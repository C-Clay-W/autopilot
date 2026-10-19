/**
 * Node TranscriptStore：使用异步顺序追加器保存 Session 事件，并只增量读取文件尾部。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentEventEnvelope, TranscriptStore } from "@autopilot-agent/core";
import { safeFilePath, withAsyncFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

const transcriptIndexes = new Map<string, TranscriptIndex>();
const transcriptRootInitializations = new Map<string, Promise<void>>();

interface TranscriptIndex {
  initialized: boolean;
  offset: number;
  pendingBytes: Buffer;
  endsWithNewline: boolean;
  keys: Set<string>;
}

interface ParsedTranscript {
  values: AgentEventEnvelope[];
  lines: string[];
}

/** 返回一个可复用的 Session 增量索引。 */
function getTranscriptIndex(filePath: string): TranscriptIndex {
  const key = path.resolve(filePath);
  const existing = transcriptIndexes.get(key);
  if (existing) return existing;
  const created: TranscriptIndex = { initialized: false, offset: 0, pendingBytes: Buffer.alloc(0), endsWithNewline: true, keys: new Set() };
  transcriptIndexes.set(key, created);
  return created;
}

/** 返回 Transcript 的增量幂等键；文件已经按 Session 隔离，仍保留 sessionId 以固定契约。 */
function getEnvelopeKey(envelope: AgentEventEnvelope): string {
  return `${envelope.sessionId}\u0000${envelope.turnId}\u0000${envelope.seq}`;
}

/** 确保存储根只初始化一次，并把后续 Transcript 目录创建交给异步文件 API。 */
function ensureTranscriptDirectory(stateRoot: string): Promise<void> {
  const key = path.resolve(stateRoot);
  const existing = transcriptRootInitializations.get(key);
  if (existing) return existing;
  const initialization = Promise.resolve().then(async function initializeTranscriptDirectory() {
    const state = ensureNodeStateRoot(key);
    await fsp.mkdir(state.transcriptsDir, { recursive: true });
  }).catch(function forgetFailedInitialization(error) {
    transcriptRootInitializations.delete(key);
    throw error;
  });
  transcriptRootInitializations.set(key, initialization);
  return initialization;
}

/** 异步读取完整文件；文件不存在时返回空 Buffer。 */
async function readTranscriptBuffer(filePath: string): Promise<Buffer> {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

/** 记录 JSONL 损坏行的脱敏诊断，不把正文写入日志。 */
function reportCorruptedLine(filePath: string): void {
  console.warn(`[DURABLE_JSONL_CORRUPTED] file=${path.basename(filePath)} records=1 lines=unknown`);
}

/** 解析一行 JSONL 并更新增量索引；损坏行保留在文件中但不阻断后续记录。 */
function parseTranscriptLine(filePath: string, line: Buffer, index: TranscriptIndex, parsed?: ParsedTranscript): void {
  if (line.length === 0) return;
  const serialized = line.toString("utf8");
  try {
    const envelope = JSON.parse(serialized) as AgentEventEnvelope;
    index.keys.add(getEnvelopeKey(envelope));
    parsed?.values.push(envelope);
    parsed?.lines.push(serialized);
  } catch {
    reportCorruptedLine(filePath);
  }
}

/** 消费完整 JSONL 行，并把没有换行结尾的损坏片段留给下一次增量读取。 */
function consumeTranscriptBytes(filePath: string, bytes: Buffer, index: TranscriptIndex, parsed?: ParsedTranscript): void {
  const source = index.pendingBytes.length > 0 ? Buffer.concat([index.pendingBytes, bytes]) : bytes;
  if (source.length > 0) index.endsWithNewline = source[source.length - 1] === 0x0a;
  let lineStart = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== 0x0a) continue;
    parseTranscriptLine(filePath, source.subarray(lineStart, cursor), index, parsed);
    lineStart = cursor + 1;
  }
  const trailing = source.subarray(lineStart);
  if (trailing.length === 0) {
    index.pendingBytes = Buffer.alloc(0);
    return;
  }
  try {
    JSON.parse(trailing.toString("utf8"));
    parseTranscriptLine(filePath, trailing, index, parsed);
    index.pendingBytes = Buffer.alloc(0);
  } catch {
    index.pendingBytes = Buffer.from(trailing);
  }
}

/** 从完整文件重新构建 turnId/seq 索引，并返回当前可恢复事件。 */
function rebuildTranscriptIndex(filePath: string, bytes: Buffer, index: TranscriptIndex): ParsedTranscript {
  index.keys.clear();
  index.pendingBytes = Buffer.alloc(0);
  index.endsWithNewline = true;
  const parsed: ParsedTranscript = { values: [], lines: [] };
  consumeTranscriptBytes(filePath, bytes, index, parsed);
  index.offset = bytes.length;
  index.initialized = true;
  return parsed;
}

/** 按指定偏移异步读取文件尾部，避免每个 delta 从头扫描完整 Transcript。 */
async function readTranscriptTail(filePath: string, offset: number): Promise<{ bytes: Buffer; size: number }> {
  const descriptor = await fsp.open(filePath, "r");
  try {
    const stats = await descriptor.stat();
    const length = Math.max(0, stats.size - offset);
    const bytes = Buffer.alloc(length);
    let position = 0;
    while (position < length) {
      const result = await descriptor.read(bytes, position, length - position, offset + position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
    }
    return { bytes: position === length ? bytes : bytes.subarray(0, position), size: stats.size };
  } finally {
    await descriptor.close();
  }
}

/** 在跨进程锁内把当前进程遗漏的文件尾部合并进增量索引。 */
async function refreshTranscriptIndex(filePath: string, index: TranscriptIndex): Promise<void> {
  if (!index.initialized) {
    rebuildTranscriptIndex(filePath, await readTranscriptBuffer(filePath), index);
    return;
  }
  let stats: { size: number };
  try {
    stats = await fsp.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    rebuildTranscriptIndex(filePath, Buffer.alloc(0), index);
    return;
  }
  if (stats.size < index.offset) {
    rebuildTranscriptIndex(filePath, await readTranscriptBuffer(filePath), index);
    return;
  }
  if (stats.size === index.offset) return;
  const tail = await readTranscriptTail(filePath, index.offset);
  consumeTranscriptBytes(filePath, tail.bytes, index);
  index.offset = tail.size;
}

/** 异步追加一个唯一 Transcript 信封，并在追加成功后更新本地索引。 */
async function appendTranscriptEnvelope(filePath: string, envelope: AgentEventEnvelope): Promise<void> {
  const index = getTranscriptIndex(filePath);
  await withAsyncFileLock(filePath, async function appendUnderLock() {
    await refreshTranscriptIndex(filePath, index);
    const key = getEnvelopeKey(envelope);
    if (index.keys.has(key)) return;
    const serialized = JSON.stringify(envelope);
    const separator = index.endsWithNewline ? "" : "\n";
    const bytes = Buffer.from(`${separator}${serialized}\n`, "utf8");
    await fsp.appendFile(filePath, bytes);
    index.pendingBytes = Buffer.alloc(0);
    index.endsWithNewline = true;
    index.offset += bytes.length;
    index.keys.add(key);
  });
}

/** 从完整事件流中过滤历史版本的相邻重复信封，保持原文件不改写。 */
function removeAdjacentDuplicateEnvelopes(parsed: ParsedTranscript): AgentEventEnvelope[] {
  const events: AgentEventEnvelope[] = [];
  let previousLine = "";
  for (let index = 0; index < parsed.values.length; index += 1) {
    const line = parsed.lines[index];
    if (line === previousLine) continue;
    previousLine = line;
    events.push(parsed.values[index]);
  }
  return events;
}

/** 创建基于共享状态根的 TranscriptStore。 */
export function createNodeTranscriptStore(options: NodeStoreOptions): TranscriptStore {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 返回指定 Session transcript 文件的安全路径。 */
  function filePath(sessionId: string): string {
    return safeFilePath(paths.transcriptsDir, sessionId, ".jsonl");
  }

  return {
    async append(sessionId: string, envelope: AgentEventEnvelope): Promise<void> {
      await ensureTranscriptDirectory(paths.root);
      await appendTranscriptEnvelope(filePath(sessionId), envelope);
    },

    async getEvents(sessionId: string): Promise<AgentEventEnvelope[]> {
      await ensureTranscriptDirectory(paths.root);
      const target = filePath(sessionId);
      const index = getTranscriptIndex(target);
      return withAsyncFileLock(target, async function readUnderLock() {
        return removeAdjacentDuplicateEnvelopes(rebuildTranscriptIndex(target, await readTranscriptBuffer(target), index));
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      await ensureTranscriptDirectory(paths.root);
      const target = filePath(sessionId);
      const index = getTranscriptIndex(target);
      await withAsyncFileLock(target, async function deleteUnderLock() {
        try {
          await fsp.unlink(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        index.initialized = true;
        index.offset = 0;
        index.pendingBytes = Buffer.alloc(0);
        index.endsWithNewline = true;
        index.keys.clear();
      });
    },
  };
}
