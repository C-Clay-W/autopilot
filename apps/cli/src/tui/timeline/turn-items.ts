/** 合并既有 Presentation 与宿主输入位置，并读取每轮最后一次安全 Todo。 */
import { capturePresentationInputPosition, reducePresentationInput, selectTurnTimeline, type AgentPresentationState, type TimelineItem, type TodoSnapshotItem } from "@autopilot-agent/presentation";
import type { CliTuiInputPosition, CliTuiTimelineEvent } from "../types.js";

export type TuiHostInput = Extract<CliTuiTimelineEvent, { type: "tui_input_consumed" }>;

/** 保存当前可见事实的稳定边界，连续回答以字符位置保留输入前后的正文。 */
export function captureTuiInputPosition(turnId: string | undefined, events: CliTuiTimelineEvent[], presentation?: AgentPresentationState): CliTuiInputPosition {
  return { turnId, eventCount: events.filter(function publicEvent(event) { return event.type !== "tui_input_consumed"; }).length, items: presentation && turnId ? capturePresentationInputPosition(presentation, turnId).items : [] };
}

/** 只采用该轮自身的最后一次 todo_updated；显式空列表保持清空语义。 */
export function getTuiTurnTodo(events: CliTuiTimelineEvent[], turnId: string): TodoSnapshotItem | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "todo_updated" && event.turnId === turnId) return { id: `todo:${turnId}`, kind: "todo", turnId, todos: event.todos, counts: event.counts };
  }
  return undefined;
}

/** 按提交边界切分共享节点，再复用 selector 分组；宿主正文不会被后来的分组或回答吞到前面。 */
export function getTuiTurnItems(presentation: AgentPresentationState, turnId: string, events: CliTuiTimelineEvent[]): Array<TimelineItem | TuiHostInput> {
  const inputs = events.filter(function host(event): event is TuiHostInput { return event.type === "tui_input_consumed"; });
  let state = presentation;
  for (const input of inputs) {
    state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input: { turnId: input.turnId, inputId: input.inputId, delivery: input.delivery, content: input.content, position: input.position ?? { items: [] }, cancelled: input.cancelled, state: input.consumed === false ? "queued" : "consumed" } } });
  }
  const todo = getTuiTurnTodo(events, turnId);
  // CLI 只采用本轮 events；不把恢复或 Session latest 误当作本轮更新。
  state = { ...state, todosByTurn: { ...state.todosByTurn, [turnId]: todo ?? { id: `todo:${turnId}`, kind: "todo", turnId, todos: [], counts: { completed: 0, pending: 0, inProgress: 0 } } } };
  const inputById = new Map(inputs.map(function pair(input) { return [input.inputId, input]; }));
  return selectTurnTimeline(state, turnId).map(function host(item) { return item.kind === "input_notice" ? inputById.get(item.inputId) ?? item : item; });
}