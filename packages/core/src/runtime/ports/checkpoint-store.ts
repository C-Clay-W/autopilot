/**
 * CheckpointStore Port — Agent checkpoint 持久化接口
 *
 * 负责按 sessionId 读取最新 checkpoint 与保存新 checkpoint。
 */

import type { AgentCheckpoint } from "../protocol";

/** Checkpoint 存储端口。 */
export interface CheckpointStore {
  /** 读取某 Session 的最新 checkpoint；不存在时返回 null。 */
  getLatest(sessionId: string): Promise<AgentCheckpoint | null>;

  /** 从 Core 私有历史读取指定 Turn 最近一次 checkpoint；不经公开 transcript 投影。 */
  getByTurn(sessionId: string, turnId: string): Promise<AgentCheckpoint | null>;

  /** 保存 checkpoint。 */
  save(sessionId: string, checkpoint: AgentCheckpoint): Promise<void>;

  /** 原子检查并恢复过期的 running checkpoint；无过期 checkpoint 时返回当前最新值。 */
  recoverStale(sessionId: string, now: number, staleAfterMs: number): Promise<AgentCheckpoint | null>;

  /** 删除指定 Session 的全部 checkpoint 记录。 */
  deleteBySession(sessionId: string): Promise<void>;
}
