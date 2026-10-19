/**
 * EventSink Port — Runtime 事件消费接口
 *
 * Runtime 在执行过程中通过该端口输出事件，供宿主转为 SSE、终端渲染或 IPC。
 */

import type { AgentEventEnvelope } from "../protocol";

/** 事件消费端口；宿主可观察、转发或丢弃事件，但 durable Transcript 只能由 TranscriptStore 写入。 */
export interface EventSink {
  /** 消费一个事件；禁止把事件写回同一 Runtime 的 TranscriptStore。 */
  write(envelope: AgentEventEnvelope): Promise<void>;
}
