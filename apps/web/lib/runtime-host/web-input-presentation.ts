/** Web 输入展示：复用 durable inbox 原文和公开消费事件恢复正文，不读取私有消息或附件展开。 */
import type { AgentEventEnvelope, InboxInput } from "@autopilot-agent/core";
import { capturePresentationInputPosition, createPresentationState, reducePresentationInput, type AgentPresentationState } from "@autopilot-agent/presentation";

/** 按持久消费事件边界补原文；History 边界不冒充本地提交瞬间。 */
export function restoreWebInputPresentation(state: AgentPresentationState, events: AgentEventEnvelope[], inputs: InboxInput[]): AgentPresentationState {
  const byId = new Map(inputs.map(function pair(input) { return [input.inputId, input]; }));
  const positions = new Map<string, ReturnType<typeof capturePresentationInputPosition>>();
  let replay = createPresentationState();
  let order = 0;
  for (const envelope of events) {
    const event = envelope.event;
    if ((event.type === "input_joined" || event.type === "input_consumed") && !positions.has(event.inputId)) {
      const input = byId.get(event.inputId);
      positions.set(event.inputId, input?.delivery === "queue" ? { turnId: envelope.turnId, items: [], order: order++ } : capturePresentationInputPosition(replay, envelope.turnId, order++));
    }
    replay = reducePresentationInput(replay, { kind: "runtime_event", envelope });
  }
  let next = state;
  for (const input of inputs) {
    const notice = next.items.find(function matching(item) { return item.kind === "input_notice" && item.inputId === input.inputId && (item.state === "joined" || item.state === "consumed"); });
    const turnId = notice && "turnId" in notice ? notice.turnId : input.delivery === "steer" || input.status === "consumed" ? input.turnId : undefined;
    if (!turnId) continue;
    const position = input.delivery === "queue" ? { turnId, items: [], order: order++ } : positions.get(input.inputId) ?? capturePresentationInputPosition(next, turnId, order++);
    next = reducePresentationInput(next, { kind: "host_event", event: { kind: "input", input: { inputId: input.inputId, turnId, delivery: input.delivery, content: input.content, position, cancelled: input.status === "cancelled", state: input.status === "consumed" ? "consumed" : "queued" } } });
  }
  return next;
}
