/**
 * runtime/protocol/event-envelope.ts — 事件信封与工厂函数
 *
 * AgentEventEnvelope 是 EventSink / TranscriptStore 持久化与跨进程传输的标准格式。
 * createEventEnvelope 是纯工厂函数，统一 seq / timestamp 生成，避免 turn-service 内联构造。
 */

import type { AgentCheckpoint, AgentLoopEvent } from "../../internal/agent-runtime";
import type { AgentTerminationView } from "./recoverable-turn-view";

/** 宿主可见 checkpoint 仅含生命周期与 Skill 身份；消息和工具事实始终保留在 Core 私有存储。 */
export type PublicCheckpointView = Pick<AgentCheckpoint, "turnId" | "status" | "stepCount"> & {
  messages: [];
  completedCallIds: [];
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  consumedInputIds?: string[];
};

type EventCheckpointView = Omit<PublicCheckpointView, "consumedInputIds">;

type PublicAgentEvent<Event> = Event extends { checkpoint: AgentCheckpoint }
  ? Omit<Event, "checkpoint" | "termination"> & { checkpoint: EventCheckpointView; termination?: AgentTerminationView }
  : Event extends { checkpoint?: AgentCheckpoint }
    ? Omit<Event, "checkpoint" | "termination"> & { checkpoint?: EventCheckpointView; termination?: AgentTerminationView }
    : Event;

/** 将 Kernel 事件中的完整 checkpoint 映射为公开脱敏视图。 */
export type AgentEvent = AgentLoopEvent extends infer Event
  ? Event extends unknown
    ? PublicAgentEvent<Event>
    : never
  : never;

/** 带信封的事件，供 EventSink / TranscriptStore 持久化与跨进程传输。 */
export interface AgentEventEnvelope {
  seq: number;
  sessionId: string;
  turnId: string;
  timestamp: string;
  event: AgentEvent;
}

/** createEventEnvelope 的输入参数；timestamp 由调用方从 Clock 获取，避免 protocol 反向依赖 ports。 */
export interface CreateEventEnvelopeInput {
  seq: number;
  sessionId: string;
  turnId: string;
  timestamp: string;
  event: AgentEvent;
}

/**
 * 构造一个 AgentEventEnvelope。
 * 纯函数，不读取 Clock 或任何 Port；timestamp 由调用方传入。
 * contract test 验证 seq 单调递增、timestamp 符合 ISO 8601、event 字段不被破坏。
 */
export function createEventEnvelope(input: CreateEventEnvelopeInput): AgentEventEnvelope {
  return {
    seq: input.seq,
    sessionId: input.sessionId,
    turnId: input.turnId,
    timestamp: input.timestamp,
    event: input.event,
  };
}
