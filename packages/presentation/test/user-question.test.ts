/** Presentation 用户澄清问题测试：验证 Live/History 复用同一安全投影，且不泄露 Other 正文。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { createPresentationState, reducePresentationInput, replayPresentationInputs, selectRequiredUserQuestions } from "../src/index.js";

/** 构造只包含 Question 安全事件的固定 transcript。 */
function createQuestionEvents(): AgentEventEnvelope[] {
  return [
    {
      seq: 1,
      sessionId: "session-question",
      turnId: "turn-question",
      timestamp: "2026-08-27T15:00:00.000Z",
      event: {
        type: "question_required",
        turnId: "turn-question",
        stepId: "step-question",
        callId: "call-question",
        requestId: "request-question",
        questions: [{ id: "scope", header: "范围", question: "本次先处理哪部分？", options: [{ label: "最小修复", description: "先完成当前缺陷" }, { label: "完整改造", description: "同时完善相关链路" }] }],
      } as AgentEvent,
    },
    {
      seq: 2,
      sessionId: "session-question",
      turnId: "turn-question",
      timestamp: "2026-08-27T15:00:01.000Z",
      event: { type: "turn_paused", turnId: "turn-question", checkpoint: { turnId: "turn-question", status: "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [] } } as AgentEvent,
    },
  ];
}

describe("Presentation 用户澄清问题", function userQuestionPresentationSuite() {
  it("Live 与 History 投影同一条待回答问题，并只保留允许展示字段", function replaysRequiredQuestion() {
    const events = createQuestionEvents();
    const history = replayPresentationInputs(events.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; }));
    const live = events.reduce(function reduceLive(state, envelope) { return reducePresentationInput(state, { kind: "runtime_event", envelope }); }, createPresentationState());

    expect(live).toEqual(history);
    expect(selectRequiredUserQuestions(history)).toEqual([expect.objectContaining({ requestId: "request-question", callId: "call-question", questions: [{ id: "scope", header: "范围", question: "本次先处理哪部分？", options: [{ label: "最小修复", description: "先完成当前缺陷" }, { label: "完整改造", description: "同时完善相关链路" }] }] })]);
  });

  it("回答后只保留安全摘要，Other 正文与未知事件字段不会进入 Presentation", function redactsCustomAnswer() {
    const events = [...createQuestionEvents(), {
      seq: 3,
      sessionId: "session-question",
      turnId: "turn-question",
      timestamp: "2026-08-27T15:00:02.000Z",
      event: {
        type: "question_answered",
        turnId: "turn-question",
        requestId: "request-question",
        answerSummary: { questionCount: 1, selectedLabels: ["最小修复"], hasCustom: true },
        custom: "RAW_OTHER_CONTENT_MUST_NOT_RENDER",
      } as unknown as AgentEvent,
    }];
    const state = replayPresentationInputs(events.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; }));
    const question = state.items.find(function findQuestion(item) { return item.kind === "user_question"; });

    expect(selectRequiredUserQuestions(state)).toEqual([]);
    expect(question).toMatchObject({ state: "answered", answerSummary: { questionCount: 1, selectedLabels: ["最小修复"], hasCustom: true } });
    expect(JSON.stringify(state)).not.toContain("RAW_OTHER_CONTENT_MUST_NOT_RENDER");
  });

  it("取消等待回答的 Turn 后不再将问题投影为待回答", function cancelsRequiredQuestion() {
    const events = [...createQuestionEvents(), {
      seq: 3,
      sessionId: "session-question",
      turnId: "turn-question",
      timestamp: "2026-08-27T15:00:02.000Z",
      event: { type: "turn_interrupted", turnId: "turn-question", checkpoint: { turnId: "turn-question", status: "interrupted", stepCount: 1, messages: [], completedCallIds: [] }, error: "用户已取消当前任务" } as AgentEvent,
    }];
    const state = replayPresentationInputs(events.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; }));
    const question = state.items.find(function findQuestion(item) { return item.kind === "user_question"; });

    expect(selectRequiredUserQuestions(state)).toEqual([]);
    expect(question).toMatchObject({ state: "cancelled" });
  });
});
