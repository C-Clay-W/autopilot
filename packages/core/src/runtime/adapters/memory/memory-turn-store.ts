/**
 * 内存 TurnStore 适配器
 *
 * 用于 contract test 与 headless smoke，不依赖真实文件系统。
 * Phase 3 新增；存储 Turn 实体与冻结的 FrozenRunConfig。
 */

import type { Turn } from "../../domain";
import type { TurnStore } from "../../ports";

export class MemoryTurnStore implements TurnStore {
  private turns = new Map<string, Turn>();

  async get(id: string): Promise<Turn | null> {
    return this.turns.get(id) ?? null;
  }

  async save(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }

  async list(sessionId: string): Promise<Turn[]> {
    return Array.from(this.turns.values()).filter((turn) => turn.sessionId === sessionId);
  }

  async getLatest(sessionId: string): Promise<Turn | null> {
    const turns = await this.list(sessionId);
    if (turns.length === 0) return null;
    return turns.reduce((latest, turn) => (turn.startedAt > latest.startedAt ? turn : latest));
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) this.turns.delete(turnId);
    }
  }
}
