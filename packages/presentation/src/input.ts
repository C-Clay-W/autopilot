/** Presentation 的唯一输入协议：Runtime 信封与不伪装为 Runtime 的 Host 安全事件。 */
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import type { InputNoticeItem, JobItem, TransportState } from "./model.js";

export interface HostTransportEvent {
  kind: "transport";
  state: TransportState;
}

export interface HostJobEvent {
  kind: "job";
  job: Omit<JobItem, "id" | "kind">;
}

export interface HostCapabilityEvent {
  kind: "capability";
  id: string;
  scope: "mcp" | "doctor" | "evidence";
  state: string;
  summary?: string;
}

export interface HostUndoEvent {
  kind: "undo";
  transactionId: string;
  state: "preview" | "confirming" | "executing";
  paths?: string[];
}

/** 由宿主已确认原文关联既有 input_notice，不新增 canonical 消息。 */
export interface HostInputEvent {
  kind: "input";
  input: Omit<InputNoticeItem, "id" | "kind">;
}

export type HostPresentationEvent = HostTransportEvent | HostJobEvent | HostCapabilityEvent | HostUndoEvent | HostInputEvent;

export type PresentationInput = { kind: "runtime_event"; envelope: AgentEventEnvelope } | { kind: "host_event"; event: HostPresentationEvent };

/** 为持久化 Runtime 信封生成幂等键；Host 事件不共享 Runtime 的持久化身份。 */
export function getRuntimeEventId(envelope: AgentEventEnvelope): string {
  return `${envelope.sessionId}:${envelope.turnId}:${envelope.seq}`;
}
