/**
 * runtime/application/turn/turn-event-recorder.ts — Runtime 事件持久化共享边界
 *
 * 统一"脱敏 → 构造信封 → Transcript / EventSink 写入"的持久化路径：
 * Execution Coordinator 的 persistEvent 与 manual compact 都经由同一实现，
 * 保证 per-turn seq 计算规则一致，宿主（Route）不允许伪造 Runtime 事件。
 */

import type { AgentLoopEvent } from "../../../internal/agent-runtime";
import { recordPerformanceDiagnostic } from "../../../internal/performance-diagnostics";
import type { AgentEvent, AgentEventEnvelope } from "../../protocol";
import { createEventEnvelope } from "../../protocol";
import { sanitizeEventForExternal } from "../../protocol/sanitize-checkpoint";
import type { RuntimePorts } from "../../ports";

/** 单次事件持久化的输入；seq 由调用方按边界推进后传入。 */
export interface TurnEventRecordInput {
  seq: number;
  sessionId: string;
  turnId: string;
  /** ephemeral Session 跳过 Transcript 持久化，EventSink 始终写入。 */
  isDurable: boolean;
  event: AgentLoopEvent;
}

/** Runtime 事件持久化共享边界的职责。 */
export interface TurnEventRecorder {
  /** 计算指定 Turn 在 Transcript 中的下一个 seq；与 Execution Coordinator 同一 per-turn 单调规则。 */
  nextSeq(sessionId: string, turnId: string): Promise<number>;
  /** 脱敏事件后沿 Transcript / EventSink 持久化，返回对外安全事件副本。 */
  record(input: TurnEventRecordInput): Promise<AgentEvent>;
}

/** 创建持有统一持久化边界的事件记录器。 */
export function createTurnEventRecorder(ports: RuntimePorts): TurnEventRecorder {
  /** 沿用 Execution Coordinator 的 per-turn seq 规则：只取同一 Turn 的最大 seq 再加一。 */
  async function nextSeq(sessionId: string, turnId: string): Promise<number> {
    const transcript = await ports.transcriptStore.getEvents(sessionId);
    return transcript.reduce(function getTurnMaximum(current, envelope) {
      return envelope.turnId === turnId ? Math.max(current, envelope.seq) : current;
    }, 0) + 1;
  }

  /** 构造脱敏信封并写入 Transcript 与 EventSink；对外只返回安全事件副本。 */
  async function record(input: TurnEventRecordInput): Promise<AgentEvent> {
    const envelope: AgentEventEnvelope = createEventEnvelope({
      seq: input.seq,
      sessionId: input.sessionId,
      turnId: input.turnId,
      timestamp: ports.clock.timestamp(),
      event: sanitizeEventForExternal(input.event),
    });
    if (input.isDurable) {
      const transcriptStartedAt = performance.now();
      await ports.transcriptStore.append(input.sessionId, envelope);
      recordPerformanceDiagnostic("transcript_completed", input.event.type, performance.now() - transcriptStartedAt);
    }
    const eventSinkStartedAt = performance.now();
    await ports.eventSink.write(envelope);
    recordPerformanceDiagnostic("event_sink_completed", input.event.type, performance.now() - eventSinkStartedAt);
    return sanitizeEventForExternal(input.event);
  }

  return { nextSeq, record };
}
