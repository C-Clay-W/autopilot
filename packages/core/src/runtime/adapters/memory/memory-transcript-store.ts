/**
 * 内存 Transcript 存储适配器
 *
 * 按 sessionId 保存 append-only 事件序列；仅供测试与 contract test 使用。
 */

import type { AgentEventEnvelope } from "../../protocol";
import type { TranscriptStore } from "../../ports";

export class MemoryTranscriptStore implements TranscriptStore {
  private transcripts = new Map<string, AgentEventEnvelope[]>();

  async append(sessionId: string, envelope: AgentEventEnvelope): Promise<void> {
    const events = this.transcripts.get(sessionId) ?? [];
    events.push(envelope);
    this.transcripts.set(sessionId, events);
  }

  async getEvents(sessionId: string): Promise<AgentEventEnvelope[]> {
    return [...(this.transcripts.get(sessionId) ?? [])];
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.transcripts.delete(sessionId);
  }
}
