/**
 * Node CheckpointStore：在显式 stateRoot/checkpoints 下追加 checkpoint 审计记录。
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentCheckpoint, CheckpointStore } from "@autopilot-agent/core";
import { appendJsonLine, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 CheckpointStore。 */
export function createNodeCheckpointStore(options: NodeStoreOptions): CheckpointStore {
  const paths = getNodeStatePaths(options.stateRoot);
  const latestCache = new Map<string, { signature: string; checkpoint: AgentCheckpoint | null; bytes: number }>();
  let cacheBytes = 0;

  /** 每次锁内核对文件身份、尺寸及纳秒时间；替换/截断/外部同尺寸写入都使缓存失效。 */
  function signature(target: string): string {
    try {
      const stat = fs.statSync(target, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  /** 写入及任何读取失败立即清除此Session，绝不回退到旧值。 */
  function invalidate(key: string): void {
    const previous = latestCache.get(key);
    if (previous) cacheBytes -= previous.bytes;
    latestCache.delete(key);
  }

  /** 同一Session的最新及历史Turn缓存随写入一起失效。 */
  function invalidateSession(sessionId: string): void {
    for (const key of latestCache.keys()) if (JSON.parse(key)[0] === sessionId) invalidate(key);
  }

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.checkpointsDir, { recursive: true });
  }

  /** 返回指定 Session checkpoint 文件的安全路径。 */
  function filePath(sessionId: string): string {
    return safeFilePath(paths.checkpointsDir, sessionId, ".jsonl");
  }

  /** 逐行异步审计，只保留目标Turn最后记录；每条大JSON之后让出主线程。 */
  async function readCheckpoint(sessionId: string, turnId?: string): Promise<AgentCheckpoint | null> {
    const target = filePath(sessionId);
    const key = JSON.stringify([sessionId, turnId ?? null]);
    try {
      const before = signature(target);
      const cached = latestCache.get(key);
      if (cached?.signature === before) {
        latestCache.delete(key); latestCache.set(key, cached);
        return structuredClone(cached.checkpoint);
      }
      invalidate(key);
      let checkpoint: AgentCheckpoint | null = null;
      let bytes = 0;
      const corrupted: number[] = [];
      if (before !== "missing") {
        const input = fs.createReadStream(target, { encoding: "utf8", highWaterMark: 64 * 1024 });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let readError: Error | undefined;
        /** 底层读取错误关闭迭代器并在审计结束后拒绝，不把部分记录当成功。 */
        function failRead(error: Error): void { readError = error; lines.close(); }
        input.on("error", failRead);
        let lineNumber = 0;
        try {
          for await (const line of lines) {
            lineNumber++;
            if (!line) continue;
            try {
              const value = JSON.parse(line) as AgentCheckpoint;
              if (!turnId || value?.turnId === turnId) { checkpoint = value; bytes = Buffer.byteLength(line, "utf8"); }
            } catch { corrupted.push(lineNumber); }
            await new Promise<void>(function yieldParsing(resolve) { setImmediate(resolve); });
          }
          if (readError) throw readError;
        } finally { lines.close(); input.destroy(); input.off("error", failRead); }
      }
      if (corrupted.length) console.warn(`[DURABLE_JSONL_CORRUPTED] file=${path.basename(target)} records=${corrupted.length} lines=${corrupted.join(",")}`);
      if (!corrupted.length && before === signature(target) && bytes <= 8 * 1024 * 1024) {
        while (latestCache.size >= 8 || cacheBytes + bytes > 8 * 1024 * 1024) invalidate(latestCache.keys().next().value!);
        latestCache.set(key, { signature: before, checkpoint, bytes }); cacheBytes += bytes;
        return structuredClone(checkpoint);
      }
      return checkpoint;
    } catch (error) { invalidate(key); throw error; }
  }

  return {
    async getLatest(sessionId: string): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), () => readCheckpoint(sessionId));
    },

    async getByTurn(sessionId: string, turnId: string): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), () => readCheckpoint(sessionId, turnId));
    },

    async save(sessionId: string, checkpoint: AgentCheckpoint): Promise<void> {
      ensureDir();
      await withFileLock(filePath(sessionId), () => {
        invalidateSession(sessionId);
        appendJsonLine(filePath(sessionId), JSON.stringify(checkpoint));
      });
    },

    async recoverStale(sessionId: string, now: number, staleAfterMs: number): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), async function recover() {
        const latest = await readCheckpoint(sessionId);
        if (!latest) return null;
        if (latest.status !== "running" || !latest.lease || now - latest.lease.heartbeatAt <= staleAfterMs) return latest;
        const recovered: AgentCheckpoint = {
          ...latest,
          status: "interrupted_recoverable",
          interruptionReason: "stale_lease",
        };
        invalidateSession(sessionId);
        appendJsonLine(filePath(sessionId), JSON.stringify(recovered));
        return recovered;
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      const target = filePath(sessionId);
      await withFileLock(target, () => {
        invalidateSession(sessionId);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      });
    },
  };
}
