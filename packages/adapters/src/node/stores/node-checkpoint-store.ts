/**
 * Node CheckpointStore：在显式 stateRoot/checkpoints 下追加 checkpoint 审计记录。
 */

import fs from "node:fs";
import type { AgentCheckpoint, CheckpointStore } from "@autopilot-agent/core";
import { appendJsonLine, readJsonLines, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 CheckpointStore。 */
export function createNodeCheckpointStore(options: NodeStoreOptions): CheckpointStore {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.checkpointsDir, { recursive: true });
  }

  /** 返回指定 Session checkpoint 文件的安全路径。 */
  function filePath(sessionId: string): string {
    return safeFilePath(paths.checkpointsDir, sessionId, ".jsonl");
  }

  /** 在锁内读取最后一条有效 checkpoint。 */
  function readLatest(sessionId: string): AgentCheckpoint | null {
    const records = readJsonLines<AgentCheckpoint>(filePath(sessionId)).values;
    return records.length > 0 ? records[records.length - 1] : null;
  }

  /** 在锁内读取指定 Turn 最近一次私有 checkpoint。 */
  function readByTurn(sessionId: string, turnId: string): AgentCheckpoint | null {
    const records = readJsonLines<AgentCheckpoint>(filePath(sessionId)).values;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const checkpoint = records[index];
      if (checkpoint?.turnId === turnId) return checkpoint;
    }
    return null;
  }

  return {
    async getLatest(sessionId: string): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), () => readLatest(sessionId));
    },

    async getByTurn(sessionId: string, turnId: string): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), () => readByTurn(sessionId, turnId));
    },

    async save(sessionId: string, checkpoint: AgentCheckpoint): Promise<void> {
      ensureDir();
      await withFileLock(filePath(sessionId), () => {
        appendJsonLine(filePath(sessionId), JSON.stringify(checkpoint));
      });
    },

    async recoverStale(sessionId: string, now: number, staleAfterMs: number): Promise<AgentCheckpoint | null> {
      ensureDir();
      return withFileLock(filePath(sessionId), () => {
        const latest = readLatest(sessionId);
        if (!latest) return null;
        if (latest.status !== "running" || !latest.lease || now - latest.lease.heartbeatAt <= staleAfterMs) return latest;
        const recovered: AgentCheckpoint = {
          ...latest,
          status: "interrupted_recoverable",
          interruptionReason: "stale_lease",
        };
        appendJsonLine(filePath(sessionId), JSON.stringify(recovered));
        return recovered;
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      const target = filePath(sessionId);
      await withFileLock(target, () => {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      });
    },
  };
}
