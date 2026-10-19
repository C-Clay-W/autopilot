/** P16 共享回归：每轮 Todo 与 Host 原文的幂等、顺序和消费竞态。 */
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import { capturePresentationInputPosition, createPresentationState, reducePresentationInput, selectTodoSnapshot, selectTurnTimeline } from "../../src/index.js";

/** 构造最小安全 Todo 信封。 */
function todo(turnId: string, seq: number, timestamp: string, content: string): AgentEventEnvelope {
  return { sessionId: "session", turnId, seq, timestamp, event: { type: "todo_updated", turnId, todoChainId: "chain", todos: content ? [{ content, activeForm: content, status: "completed" }] : [], counts: { pending: 0, inProgress: 0, completed: content ? 1 : 0 } } } as AgentEventEnvelope;
}

describe("P16 shared Turn timeline", function suite() {
  it("历史 Todo 保留各轮最后快照，Session latest 与乱序保护不变", function independentTodos() {
    let state = createPresentationState();
    state = reducePresentationInput(state, { kind: "runtime_event", envelope: todo("A", 1, "2026-10-12T00:00:01Z", "A任务") });
    state = reducePresentationInput(state, { kind: "runtime_event", envelope: todo("B", 1, "2026-10-12T00:00:03Z", "B任务") });
    state = reducePresentationInput(state, { kind: "runtime_event", envelope: todo("C", 1, "2026-10-12T00:00:02Z", "C任务") });
    expect(selectTodoSnapshot(state)?.turnId).toBe("B");
    for (const turnId of ["A", "B", "C"]) expect(selectTurnTimeline(state, turnId).filter(function todo(item) { return item.kind === "todo"; })).toHaveLength(1);
    expect(selectTurnTimeline(state, "D")).toEqual([]);
    state = reducePresentationInput(state, { kind: "runtime_event", envelope: todo("B", 2, "2026-10-12T00:00:04Z", "") });
    const prior = selectTurnTimeline(state, "A").find(function todo(item) { return item.kind === "todo"; });
    expect(prior?.kind === "todo" && prior.todos[0]?.content).toBe("A任务");
  });

  it("消费先到、终态先到后确认仍保留消费归属且唯一正文按本地边界切开回答", function confirmsAfterConsumption() {
    let state = createPresentationState();
    state = { ...state, items: [{ id: "answer", kind: "assistant_answer", turnId: "A", stepId: "s", channel: "process", content: "输入前" }] };
    const position = capturePresentationInputPosition(state, "A", 1);
    state = { ...state, items: [{ ...state.items[0], content: "输入前输入后" } as typeof state.items[number], { id: "input:one", kind: "input_notice", turnId: "A", inputId: "one", state: "consumed" }, { id: "summary", kind: "turn_summary", turnId: "A", state: "completed", toolCount: 0 }] };
    const input = { inputId: "one", turnId: "B", delivery: "steer" as const, content: "原文\n@docs/a.md", state: "queued" as const, position };
    state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input } });
    state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input } });
    const timeline = selectTurnTimeline(state, "A");
    expect(timeline.map(function kind(item) { return item.kind; })).toEqual(["assistant_answer", "input_notice", "assistant_answer", "turn_summary"]);
    const notice = timeline[1];
    expect(notice).toMatchObject({ content: "原文\n@docs/a.md", state: "consumed", turnId: "A" });
    expect(selectTurnTimeline(state, "B")).toEqual([]);
  });
});
