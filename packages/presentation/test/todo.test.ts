/** Presentation Todo 快照测试：验证 Session 任务链 latest-write-wins、去重与 History replay。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { createPresentationState, reducePresentationInput, replayPresentationInputs, selectTodoSnapshot } from "../src/index.js";

/** 构造单个 todo_updated 信封。 */
function createTodoEnvelope(overrides: Partial<{ seq: number; turnId: string; timestamp: string; content: string; status: string }>): AgentEventEnvelope {
  const turnId = overrides.turnId ?? "turn-a";
  return {
    seq: overrides.seq ?? 1,
    sessionId: "session-todo",
    turnId,
    timestamp: overrides.timestamp ?? "2026-08-27T15:00:00.000Z",
    event: {
      type: "todo_updated",
      turnId,
      todoChainId: "chain-todo",
      todos: [
        { content: "分析需求", activeForm: "正在分析需求", status: "completed" },
        { content: overrides.content ?? "执行修改", activeForm: "正在执行修改", status: overrides.status ?? "in_progress" },
      ],
      counts: { pending: 0, inProgress: 1, completed: 1 },
    } as AgentEvent,
  };
}

/** 把信封数组转为 Presentation 输入。 */
function toInputs(envelopes: AgentEventEnvelope[]) {
  return envelopes.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; });
}

describe("Presentation Todo 快照", function todoPresentationSuite() {
  it("todo_updated 投影为 Session 任务链单卡，归属最近更新的 Turn", function projectsTodoSnapshot() {
    const state = replayPresentationInputs(toInputs([createTodoEnvelope({})]));
    const todo = selectTodoSnapshot(state);

    expect(todo).toMatchObject({
      id: "todo:session-todo",
      kind: "todo",
      turnId: "turn-a",
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "执行修改", status: "in_progress" },
      ],
      counts: { pending: 0, inProgress: 1, completed: 1 },
    });
    expect(state.items.filter(function isTodo(item) { return item.kind === "todo"; })).toHaveLength(1);
  });

  it("同一 Turn 旧 seq 与重复信封被忽略，只保留最新整表", function ignoresStaleSeqAndDuplicates() {
    const older = createTodoEnvelope({ seq: 2, content: "旧任务" });
    const newer = createTodoEnvelope({ seq: 3, timestamp: "2026-08-27T15:00:01.000Z", content: "新任务" });
    const duplicate = createTodoEnvelope({ seq: 3, timestamp: "2026-08-27T15:00:01.000Z", content: "新任务" });

    const state = [older, newer, older, duplicate].reduce(function reduceLive(current, envelope) {
      return reducePresentationInput(current, { kind: "runtime_event", envelope });
    }, createPresentationState());
    const todo = selectTodoSnapshot(state);

    expect(todo?.todos.map(function getContent(item) { return item.content; })).toEqual(["分析需求", "新任务"]);
  });

  it("跨 Turn 后到快照整值替换，乱序回放仍以最近时间戳为准", function latestWriteWinsAcrossTurns() {
    const turnOne = createTodoEnvelope({ turnId: "turn-a", seq: 2, timestamp: "2026-08-27T15:00:01.000Z", content: "第一轮" });
    const turnTwo = createTodoEnvelope({ turnId: "turn-b", seq: 1, timestamp: "2026-08-27T15:10:00.000Z", content: "第二轮" });

    const live = [turnOne, turnTwo].reduce(function reduceLive(current, envelope) {
      return reducePresentationInput(current, { kind: "runtime_event", envelope });
    }, createPresentationState());
    const replay = replayPresentationInputs(toInputs([turnOne, turnTwo]));
    const replayReversed = replayPresentationInputs(toInputs([turnTwo, turnOne]));

    expect(selectTodoSnapshot(live)?.turnId).toBe("turn-b");
    expect(selectTodoSnapshot(replay)?.turnId).toBe("turn-b");
    expect(selectTodoSnapshot(replayReversed)?.turnId).toBe("turn-b");
    expect(selectTodoSnapshot(replay)?.todos[1].content).toBe("第二轮");
  });

  it("跨 Turn 同毫秒事件按 Transcript 追加顺序保留真正的最后快照", function keepsTranscriptOrderWhenTimestampsMatch() {
    const earlier = createTodoEnvelope({ turnId: "turn-z-earlier", timestamp: "2026-08-27T15:00:00.000Z", content: "旧任务" });
    const later = createTodoEnvelope({ turnId: "turn-a-later", timestamp: "2026-08-27T15:00:00.000Z", content: "新任务" });

    const state = replayPresentationInputs(toInputs([earlier, later]));

    expect(selectTodoSnapshot(state)?.turnId).toBe("turn-a-later");
    expect(selectTodoSnapshot(state)?.todos[1].content).toBe("新任务");
  });

  it("没有 todo_updated 的 transcript 不产生 Todo 卡，普通新 Turn 不清空已有快照", function noTodoWithoutEvents() {
    const empty = replayPresentationInputs(toInputs([createTodoEnvelope({}), {
      seq: 5,
      sessionId: "session-todo",
      turnId: "turn-b",
      timestamp: "2026-08-27T15:10:00.000Z",
      event: { type: "turn_started", turnId: "turn-b", stepCount: 0 } as AgentEvent,
    }]));

    expect(selectTodoSnapshot(empty)?.turnId).toBe("turn-a");

    const noTodoSession = replayPresentationInputs(toInputs([{
      seq: 1,
      sessionId: "session-other",
      turnId: "turn-x",
      timestamp: "2026-08-27T15:00:00.000Z",
      event: { type: "turn_started", turnId: "turn-x", stepCount: 0 } as AgentEvent,
    }]));
    expect(selectTodoSnapshot(noTodoSession)).toBeUndefined();
  });
});
