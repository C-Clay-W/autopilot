/**
 * TranscriptStore Port — 会话 transcript 持久化接口
 *
 * Transcript 只保存影响模型上下文的事件（user/assistant/tool/system）。
 */

import type { AgentEventEnvelope } from "../protocol";

/** Transcript 存储端口。 */
export interface TranscriptStore {
  /** 追加一个事件到 transcript。 */
  append(sessionId: string, envelope: AgentEventEnvelope): Promise<void>;

  /** 读取某 Session 的全部 transcript 事件。 */
  getEvents(sessionId: string): Promise<AgentEventEnvelope[]>;

  /** 删除指定 Session 的完整 transcript。 */
  deleteBySession(sessionId: string): Promise<void>;
}
