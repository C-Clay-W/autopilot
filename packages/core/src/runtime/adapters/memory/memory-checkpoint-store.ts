/**
 * 内存 Checkpoint 存储适配器
 *
 * 按 sessionId 保存最新 checkpoint；仅供测试与 contract test 使用。
 */

import type { AgentCheckpoint } from "../../protocol";
import type { CheckpointStore } from "../../ports";

export class MemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, AgentCheckpoint>();
  private history = new Map<string, AgentCheckpoint[]>();

  async getLatest(sessionId: string): Promise<AgentCheckpoint | null> {
    return this.checkpoints.get(sessionId) ?? null;
  }

  async getByTurn(sessionId: string, turnId: string): Promise<AgentCheckpoint | null> {
    const records = this.history.get(sessionId) ?? [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const checkpoint = records[index];
      if (checkpoint?.turnId === turnId) return checkpoint;
    }
    return null;
  }

  async save(sessionId: string, checkpoint: AgentCheckpoint): Promise<void> {
    this.checkpoints.set(sessionId, checkpoint);
    const records = this.history.get(sessionId) ?? [];
    records.push(checkpoint);
    this.history.set(sessionId, records);
  }

  async recoverStale(sessionId: string, now: number, staleAfterMs: number): Promise<AgentCheckpoint | null> {
    const latest = this.checkpoints.get(sessionId);
    if (!latest) return null;
    if (latest.status !== "running" || !latest.lease || now - latest.lease.heartbeatAt <= staleAfterMs) return latest;
    const recovered: AgentCheckpoint = {
      ...latest,
      status: "interrupted_recoverable",
      interruptionReason: "stale_lease",
    };
    this.checkpoints.set(sessionId, recovered);
    const records = this.history.get(sessionId) ?? [];
    records.push(recovered);
    this.history.set(sessionId, records);
    return recovered;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.checkpoints.delete(sessionId);
    this.history.delete(sessionId);
  }
}
