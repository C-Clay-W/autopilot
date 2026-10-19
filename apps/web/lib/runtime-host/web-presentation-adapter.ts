/** Web Presentation 适配器：把 SSE/History 的 Runtime 信封交给共享 reducer，页面不再解释 Agent 事件。 */
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import {
  createPresentationState,
  capturePresentationInputPosition,
  reducePresentationInput,
  replayPresentationInputs,
  type AgentPresentationState,
  type PresentationInput,
  type TransportState,
} from "@autopilot-agent/presentation";

/** 将 Web SSE 的扁平事件恢复为 Presentation 所需的 Runtime 输入；Host 事件由调用方单独处理。 */
export function toWebPresentationInput(value: unknown, fallbackSessionId: string): PresentationInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.turnId !== "string" || typeof record.seq !== "number") return undefined;
  const { sessionId, turnId, seq, timestamp, ...event } = record;
  const envelope: AgentEventEnvelope = {
    sessionId: typeof sessionId === "string" ? sessionId : fallbackSessionId,
    turnId,
    seq,
    timestamp: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
    event: event as AgentEvent,
  };
  return { kind: "runtime_event", envelope };
}

/** 将一条 Web SSE 事件归入当前 Presentation 状态；重复或乱序事件由 reducer 忽略。 */
export function reduceWebPresentationEvent(state: AgentPresentationState, value: unknown, fallbackSessionId: string): AgentPresentationState {
  const input = toWebPresentationInput(value, fallbackSessionId);
  if (!input || input.kind !== "runtime_event") return state;
  const event = input.envelope.event;
  const next = reducePresentationInput(state, input);
  if (event.type !== "input_joined" && event.type !== "input_consumed") return next;
  return { ...next, items: next.items.map(function position(item) {
    return item.kind === "input_notice" && item.inputId === event.inputId && !item.position ? { ...item, position: capturePresentationInputPosition(state, input.envelope.turnId, input.envelope.seq) } : item;
  }) };
}

/** 将浏览器连接状态作为 Host 事件交给 reducer，不伪装为可持久化的 Runtime 事件。 */
export function reduceWebTransportEvent(state: AgentPresentationState, transport: TransportState): AgentPresentationState {
  return reducePresentationInput(state, { kind: "host_event", event: { kind: "transport", state: transport } });
}

/** 使用与 Live 相同的 reducer 重放 Runtime 持久 transcript。 */
export function replayWebPresentation(envelopes: AgentEventEnvelope[]): AgentPresentationState {
  return replayPresentationInputs(envelopes.map(function toRuntimeInput(envelope): PresentationInput {
    return { kind: "runtime_event", envelope };
  }), createPresentationState());
}
