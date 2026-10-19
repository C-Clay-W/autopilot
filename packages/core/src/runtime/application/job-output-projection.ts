/**
 * Job 安全输出投影：跨分片解码、控制序列清理、敏感信息屏蔽和不透明 cursor。
 *
 * 原始 stdout/stderr 不经过该类型返回给模型或宿主；两路输出各自保持顺序，不伪造交错顺序。
 */

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { JobOutputView, JobSafeOutputSnapshot, JobSafeOutputStreamSnapshot, JobSafeOutputStreamView } from "../domain";

const PROJECTION_VERSION = 1 as const;
const SAFE_STREAM_LIMIT = 32 * 1024;
const SAFE_CARRY_LIMIT = 8 * 1024;
const OMITTED_FRAGMENT = "…[过长未完成输出已省略]…\n";

interface SafeCursorPayload {
  projectionVersion: 1;
  epoch: string;
  offset: number;
}

/** 删除终端控制序列并屏蔽已定义的凭据键值、绝对路径和已知敏感值。 */
function sanitizeRecord(record: string, sensitiveValues: readonly string[]): string {
  let safe = record
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2[REDACTED]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s:"<>|]+\\)+[^\\\s:"<>|]*/g, "[ABSOLUTE_PATH]")
    .replace(/\/(?:Users|home|private|tmp|var)\/(?:[^\s/]+\/)*[^\s]*/g, "[ABSOLUTE_PATH]");
  for (const value of sensitiveValues) {
    if (value) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
}

/** 从开头按完整 Unicode 字符淘汰，直至文本满足 UTF-8 字节预算。 */
function trimToByteLimit(text: string, byteLimit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= byteLimit) return text;
  let start = bytes.length - byteLimit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** 编码不透明安全 cursor；调用方不得解析或自行构造。 */
function encodeCursor(snapshot: JobSafeOutputStreamSnapshot, offset: number): string {
  const payload: SafeCursorPayload = { projectionVersion: PROJECTION_VERSION, epoch: snapshot.epoch, offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 解码并校验安全 cursor；任何不匹配都要求调用方重置窗口。 */
function decodeCursor(cursor: string | undefined): SafeCursorPayload | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SafeCursorPayload>;
    if (value.projectionVersion !== PROJECTION_VERSION || typeof value.epoch !== "string" || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) return null;
    return value as SafeCursorPayload;
  } catch {
    return null;
  }
}

/** 单路安全输出投影，使用 StringDecoder 保留跨 chunk 的 UTF-8 尾部。 */
class SafeStreamProjector {
  private readonly decoder = new StringDecoder("utf8");
  private carry = "";
  private droppingRecord = false;
  private text: string;
  private startOffset: number;
  private nextOffset: number;
  private truncated: boolean;

  /** 从新流或 durable 快照创建投影器。 */
  constructor(private readonly sensitiveValues: readonly string[], private readonly epoch: string, snapshot?: JobSafeOutputStreamSnapshot) {
    this.text = snapshot?.text ?? "";
    this.startOffset = snapshot?.startOffset ?? 0;
    this.nextOffset = snapshot?.nextOffset ?? 0;
    this.truncated = snapshot?.truncated ?? false;
  }

  /** 解码一个原始 chunk，只发布完整记录；过长未完成片段不会提前泄露。 */
  append(chunk: Buffer): void {
    const decoded = this.decoder.write(chunk);
    let offset = 0;
    while (offset < decoded.length) {
      const newline = decoded.indexOf("\n", offset);
      const end = newline < 0 ? decoded.length : newline + 1;
      const fragment = decoded.slice(offset, end);
      if (!this.droppingRecord) {
        if (Buffer.byteLength(this.carry, "utf8") + Buffer.byteLength(fragment, "utf8") > SAFE_CARRY_LIMIT) {
          this.carry = "";
          this.droppingRecord = true;
          this.publish(OMITTED_FRAGMENT);
        } else this.carry += fragment;
      }
      if (newline >= 0) {
        if (!this.droppingRecord) this.publish(sanitizeRecord(this.carry, this.sensitiveValues));
        this.carry = "";
        this.droppingRecord = false;
      }
      offset = end;
    }
  }

  /** 终态时 flush decoder 与未完成记录。 */
  flush(): void {
    this.carry += this.decoder.end();
    if (this.carry && !this.droppingRecord) this.publish(sanitizeRecord(this.carry, this.sensitiveValues));
    this.carry = "";
  }

  /** 返回当前可持久化安全窗口。 */
  snapshot(): JobSafeOutputStreamSnapshot {
    return { projectionVersion: PROJECTION_VERSION, epoch: this.epoch, text: this.text, startOffset: this.startOffset, nextOffset: this.nextOffset, truncated: this.truncated };
  }

  /** 按不透明 cursor 读取增量；错误代次返回当前窗口并要求 reset。 */
  read(cursor?: string, byteLimit?: number): JobSafeOutputStreamView {
    const snapshot = this.snapshot();
    const decoded = decodeCursor(cursor);
    const resetRequired = cursor !== undefined && (!decoded || decoded.epoch !== snapshot.epoch);
    const requestedOffset = resetRequired || !decoded ? snapshot.startOffset : decoded.offset;
    const gap = requestedOffset < snapshot.startOffset;
    const effectiveOffset = Math.max(snapshot.startOffset, Math.min(requestedOffset, snapshot.nextOffset));
    const relativeOffset = effectiveOffset - snapshot.startOffset;
    const available = snapshot.text.slice(relativeOffset);
    let text = available;
    if (byteLimit !== undefined && Buffer.byteLength(text, "utf8") > byteLimit) {
      const bytes = Buffer.from(text, "utf8");
      let end = byteLimit;
      while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      text = bytes.subarray(0, end).toString("utf8");
    }
    const deliveredOffset = effectiveOffset + text.length;
    return {
      text,
      nextCursor: encodeCursor(snapshot, deliveredOffset),
      startCursor: encodeCursor(snapshot, snapshot.startOffset),
      gap: gap || snapshot.startOffset > 0 && cursor === undefined,
      resetRequired,
      truncated: snapshot.truncated || text.length < available.length,
    };
  }

  /** 追加安全文本并按 UTF-8 字节预算淘汰旧窗口。 */
  private publish(value: string): void {
    if (!value) return;
    this.nextOffset += value.length;
    const retained = trimToByteLimit(this.text + value, SAFE_STREAM_LIMIT);
    if (retained.length < this.text.length + value.length) this.truncated = true;
    this.text = retained;
    this.startOffset = this.nextOffset - retained.length;
  }
}

/** 双流 Job 安全输出投影器。 */
export class JobOutputProjector {
  private readonly stdout: SafeStreamProjector;
  private readonly stderr: SafeStreamProjector;

  /** 新建或从持久化窗口恢复投影；恢复不会尝试重建未完成 carry。 */
  constructor(options: { sensitiveValues?: readonly string[]; snapshot?: JobSafeOutputSnapshot; epoch?: string } = {}) {
    const epoch = options.snapshot?.stdout.epoch ?? options.epoch ?? randomUUID();
    this.stdout = new SafeStreamProjector(options.sensitiveValues ?? [], options.snapshot?.stdout.epoch ?? `${epoch}-stdout`, options.snapshot?.stdout);
    this.stderr = new SafeStreamProjector(options.sensitiveValues ?? [], options.snapshot?.stderr.epoch ?? `${epoch}-stderr`, options.snapshot?.stderr);
  }

  /** 写入指定原始输出流。 */
  append(stream: "stdout" | "stderr", chunk: Buffer): void { (stream === "stdout" ? this.stdout : this.stderr).append(chunk); }
  /** 终态时发布两路 decoder/carry 的剩余内容。 */
  flush(): void { this.stdout.flush(); this.stderr.flush(); }
  /** 返回双流 durable 安全快照。 */
  snapshot(): JobSafeOutputSnapshot { return { stdout: this.stdout.snapshot(), stderr: this.stderr.snapshot() }; }
  /** 读取双流安全增量。 */
  read(input: { stdoutCursor?: string; stderrCursor?: string; maxBytesPerStream?: number } = {}): JobOutputView { return { stdout: this.stdout.read(input.stdoutCursor, input.maxBytesPerStream), stderr: this.stderr.read(input.stderrCursor, input.maxBytesPerStream) }; }
}

/** 从 durable 安全快照读取，不创建新的代次。 */
export function readStoredJobOutput(snapshot: JobSafeOutputSnapshot, input: { stdoutCursor?: string; stderrCursor?: string; maxBytesPerStream?: number } = {}): JobOutputView {
  return new JobOutputProjector({ snapshot }).read(input);
}
