/**
 * 内存 Transcript 存储适配器
 *
 * 按 sessionId 保存 append-only 事件序列；仅供测试与 contract test 使用。
 */

import type { AgentEventEnvelope } from "../../protocol";
import type { TranscriptStore } from "../../ports";

export class MemoryTranscriptStore implements TranscriptStore {
  private transcripts = new Map<string, AgentEventEnvelope[]>();
  private generations = new Map<string, number>();

  async append(sessionId: string, envelope: AgentEventEnvelope): Promise<void> {
    const events = this.transcripts.get(sessionId) ?? [];
    events.push(envelope);
    this.transcripts.set(sessionId, events);
  }

  async getEvents(sessionId: string): Promise<AgentEventEnvelope[]> {
    return [...(this.transcripts.get(sessionId) ?? [])];
  }

  /** 只读受限页并绑定 Session，返回独立副本。 */
  async readPage(sessionId: string, options: { cursor?: string; limit: number }): Promise<{ items: AgentEventEnvelope[]; nextCursor?: string; cursor?: string }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("THREAD_CURSOR_INVALID");
    let offset = 0;
    const generation = this.generations.get(sessionId) ?? 0;
    if (options.cursor) {
      try {
        const data = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as { sessionId: string; offset: number; generation: number };
        if (data.sessionId !== sessionId || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error();
        if (data.generation !== generation) throw new Error("THREAD_CURSOR_EXPIRED");
        offset = data.offset;
      } catch (error) { if (error instanceof Error && error.message === "THREAD_CURSOR_EXPIRED") throw error; throw new Error("THREAD_CURSOR_INVALID"); }
    }
    const all = this.transcripts.get(sessionId) ?? [];
    if (offset > all.length) throw new Error("THREAD_CURSOR_INVALID");
    const items = structuredClone(all.slice(offset, offset + options.limit));
    const next = offset + items.length;
    const cursor = Buffer.from(JSON.stringify({ sessionId, offset: next, generation })).toString("base64url");
    return { items, cursor, ...(next < all.length ? { nextCursor: cursor } : {}) };
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.transcripts.delete(sessionId);
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
  }
}
