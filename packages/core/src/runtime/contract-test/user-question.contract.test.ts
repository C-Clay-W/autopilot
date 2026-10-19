/**
 * UserQuestion contract：验证问题归属、答案校验与 exactly-once 持久化语义。
 */

import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createUserQuestionService } from "../application/user-question-service";
import { createTurnService } from "../application/turn-service";
import { createAgentRuntime } from "../public";

/** 创建一个处于运行状态且可创建问题的 Session/Turn。 */
async function createQuestionFixture() {
  const ports = createMemoryPorts();
  const sessionId = "question-session";
  const turnId = "question-turn";
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "running", activeTurnId: turnId, createdAt: 1, updatedAt: 1 });
  await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: {}, startedAt: 1 });
  const service = createUserQuestionService({ questionStore: ports.userQuestionStore, checkpointStore: ports.checkpointStore, turnStore: ports.turnStore, clock: ports.clock });
  return { ports, service, sessionId, turnId };
}

/** 生成满足首版单选边界的一题请求。 */
function createQuestion() {
  return [{
    id: "scope",
    header: "范围",
    question: "本次应完成到哪个范围？",
    options: [
      { label: "最小修复", description: "仅修复当前问题" },
      { label: "完整实现", description: "完成本计划全部功能" },
    ],
  }];
}

/** 收集 Runtime 事件以验证 capability 到 checkpoint 的完整第一段链路。 */
async function collectEvents(events: AsyncIterable<import("../protocol").AgentEvent>) {
  const collected: import("../protocol").AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("UserQuestionStore contract", function userQuestionContractSuite() {
  it("按 session/turn 持久化问题并接受同一答案的幂等重试", async function acceptsIdempotentAnswer() {
    const { ports, service, sessionId, turnId } = await createQuestionFixture();
    const request = await service.request({ sessionId, turnId, questions: createQuestion() });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [] });
    const input = { sessionId, turnId, requestId: request.requestId, answers: [{ id: "scope", selected: ["最小修复"] }] };

    const first = await service.submit(input);
    const retry = await service.submit(input);

    expect(first).toEqual({ answers: [{ id: "scope", selected: ["最小修复"] }] });
    expect(retry).toEqual(first);
    expect(await service.getAnswer({ sessionId, turnId, requestId: request.requestId })).toEqual(first);
  });

  it("拒绝跨 Turn、未知选项与不同答案覆盖", async function rejectsInvalidOrConflictingAnswer() {
    const { ports, service, sessionId, turnId } = await createQuestionFixture();
    const request = await service.request({ sessionId, turnId, questions: createQuestion() });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [] });

    await expect(service.submit({ sessionId, turnId, requestId: request.requestId, answers: [{ id: "scope", selected: ["不存在"] }] })).rejects.toMatchObject({ code: "QUESTION_ANSWER_INVALID" });
    await service.submit({ sessionId, turnId, requestId: request.requestId, answers: [{ id: "scope", selected: [], custom: "需要先确认交付范围" }] });
    await expect(service.submit({ sessionId, turnId, requestId: request.requestId, answers: [{ id: "scope", selected: ["最小修复"] }] })).rejects.toMatchObject({ code: "QUESTION_ALREADY_ANSWERED" });
    await expect(service.submit({ sessionId, turnId: "other-turn", requestId: request.requestId, answers: [{ id: "scope", selected: ["最小修复"] }] })).rejects.toMatchObject({ code: "QUESTION_NOT_FOUND" });
  });

  it("拒绝模型伪造 Other 和重复题目 id", async function rejectsInvalidRequest() {
    const { service, sessionId, turnId } = await createQuestionFixture();
    await expect(service.request({ sessionId, turnId, questions: [{ ...createQuestion()[0], options: [{ label: "Other", description: "模型伪造的选项" }, { label: "有效", description: "有效说明" }] }] })).rejects.toMatchObject({ code: "QUESTION_ANSWER_INVALID" });
    await expect(service.request({ sessionId, turnId, questions: [createQuestion()[0], createQuestion()[0]] })).rejects.toMatchObject({ code: "QUESTION_ANSWER_INVALID" });
  });

  it("取消等待回答的 Turn 会使 checkpoint 终止且阻止迟到答案", async function cancelsPendingQuestion() {
    const { ports, service, sessionId, turnId } = await createQuestionFixture();
    const request = await service.request({ sessionId, turnId, questions: createQuestion() });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [] });
    const session = await ports.sessionStore.get(sessionId);
    if (!session) throw new Error("测试 Session 不存在");
    session.status = "waiting_user_input";
    await ports.sessionStore.save(session);
    const turn = await ports.turnStore.get(turnId);
    if (!turn) throw new Error("测试 Turn 不存在");
    turn.status = "waiting_user_input";
    await ports.turnStore.save(turn);

    await createTurnService(ports).cancel({ sessionId, turnId });

    expect(await ports.checkpointStore.getLatest(sessionId)).toMatchObject({ status: "interrupted" });
    await expect(service.submit({ sessionId, turnId, requestId: request.requestId, answers: [{ id: "scope", selected: ["最小修复"] }] })).rejects.toMatchObject({ code: "QUESTION_TURN_STATE_INVALID" });
  });

  it("启用 capability 时会持久化问题并将 Turn 置为等待回答", async function persistsQuestionFromRuntime() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        modelSampler: {
          async sample() {
            return { content: "", toolCalls: [{ id: "ask-runtime", name: "ask_user_question", input: { questions: createQuestion() } }], reasoningSummary: "需要确认范围" };
          },
        },
      },
    });
    const session = await runtime.sessions.create({ title: "结构化澄清测试" });
    const events = await collectEvents(runtime.turns.start({ sessionId: session.id, turnId: "runtime-question-turn", content: "请确认范围" }));

    expect(events.find((event) => event.type === "question_required")).toMatchObject({ requestId: expect.any(String) });
    expect(await ports.checkpointStore.getLatest(session.id)).toMatchObject({ status: "awaiting_user_input", turnId: "runtime-question-turn" });
    expect(await ports.turnStore.get("runtime-question-turn")).toMatchObject({ status: "waiting_user_input" });
    const record = await ports.userQuestionStore.getRequest({ sessionId: session.id, turnId: "runtime-question-turn", requestId: (events.find((event) => event.type === "question_required") as Extract<typeof events[number], { type: "question_required" }>).requestId });
    expect(record?.request.questions).toHaveLength(1);
  });

  it("重建 Runtime 后从可信答案恢复同一 Turn，并允许模型继续追问", async function resumesSameTurnFromTrustedAnswer() {
    const ports = createMemoryPorts();
    let now = 300_000;
    ports.clock = {
      now: function getCurrentTime() { return now; },
      timestamp: function getCurrentTimestamp() { return new Date(now).toISOString(); },
    };
    const firstRuntime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        maxDurationMs: 1_000,
        modelSampler: {
          async sample() {
            return { content: "", toolCalls: [{ id: "ask-before-restart", name: "ask_user_question", input: { questions: createQuestion() } }], reasoningSummary: "需要确认范围" };
          },
        },
      },
    });
    const session = await firstRuntime.sessions.create({ title: "恢复结构化澄清测试" });
    const turnId = "runtime-question-resume-turn";
    const initialEvents = await collectEvents(firstRuntime.turns.start({ sessionId: session.id, turnId, content: "请确定实现范围" }));
    const requestEvent = initialEvents.find((event) => event.type === "question_required");
    if (requestEvent?.type !== "question_required") throw new Error("问题请求不存在");

    const resumedRuntime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        modelSampler: {
          async sample(messages) {
            const answerMessage = messages.find(function findQuestionAnswer(message) {
              return message.role === "user" && message.content[0]?.type === "tool-result" && message.content[0].toolCallId === "ask-before-restart";
            });
            expect(answerMessage?.content[0]?.type === "tool-result" && answerMessage.content[0].content[0]?.text).toContain("先完成最小修复，再补充完整实现范围");
            return {
              content: "",
              toolCalls: [{
                id: "ask-follow-up",
                name: "ask_user_question",
                input: {
                  questions: [{
                    id: "verification",
                    header: "验证",
                    question: "是否需要浏览器验收？",
                    options: [
                      { label: "需要", description: "完成浏览器验收" },
                      { label: "暂不需要", description: "先完成自动化验证" },
                    ],
                  }],
                },
              }],
              reasoningSummary: "需要继续澄清验收范围",
            };
          },
        },
      },
    });
    await resumedRuntime.questions.submit({
      sessionId: session.id,
      turnId,
      requestId: requestEvent.requestId,
      answers: [{ id: "scope", selected: [], custom: "先完成最小修复，再补充完整实现范围" }],
    });
    now += 10_000;

    const resumedEvents = await collectEvents(resumedRuntime.turns.continue({ sessionId: session.id, turnId, requestId: requestEvent.requestId }));

    expect(resumedEvents.find((event) => event.type === "question_answered")).toMatchObject({ requestId: requestEvent.requestId, answerSummary: { questionCount: 1, selectedLabels: [], hasCustom: true } });
    expect(resumedEvents.find((event) => event.type === "tool_result" && event.callId === "ask-before-restart")).toMatchObject({ result: { status: "success", output: { answers: [{ id: "scope", selected: [], custom: "先完成最小修复，再补充完整实现范围" }] } } });
    expect(resumedEvents.find((event) => event.type === "question_required")).toMatchObject({ callId: "ask-follow-up" });
    expect(await ports.checkpointStore.getLatest(session.id)).toMatchObject({ turnId, status: "awaiting_user_input", pendingCalls: [{ id: "ask-follow-up" }] });
    expect((await ports.checkpointStore.getLatest(session.id))?.runtimeBudget?.startedAt).toBe(now);
    const seq = (await ports.transcriptStore.getEvents(session.id)).filter((envelope) => envelope.turnId === turnId).map((envelope) => envelope.seq);
    expect(seq).toEqual([...seq].sort((left, right) => left - right));
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("连续追问时拒绝用旧 requestId 恢复新的 pending call", async function rejectsStaleRequestIdForFollowUpQuestion() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        modelSampler: {
          async sample(messages) {
            const firstAnswer = messages.find(function findFirstAnswer(message) {
              return message.role === "user" && message.content[0]?.type === "tool-result" && message.content[0].toolCallId === "ask-first";
            });
            if (!firstAnswer) return { content: "", toolCalls: [{ id: "ask-first", name: "ask_user_question", input: { questions: createQuestion() } }], reasoningSummary: "需要确认范围" };
            return {
              content: "",
              toolCalls: [{
                id: "ask-second",
                name: "ask_user_question",
                input: {
                  questions: [{
                    id: "verification",
                    header: "验证",
                    question: "是否需要浏览器验收？",
                    options: [
                      { label: "需要", description: "完成浏览器验收" },
                      { label: "暂不需要", description: "先完成自动化验证" },
                    ],
                  }],
                },
              }],
              reasoningSummary: "需要继续澄清验收范围",
            };
          },
        },
      },
    });
    const session = await runtime.sessions.create({ title: "连续追问 requestId 测试" });
    const turnId = "runtime-question-stale-request-turn";
    const firstEvents = await collectEvents(runtime.turns.start({ sessionId: session.id, turnId, content: "请确定实现范围" }));
    const firstQuestion = firstEvents.find((event) => event.type === "question_required");
    if (firstQuestion?.type !== "question_required") throw new Error("第一题不存在");
    await runtime.questions.submit({ sessionId: session.id, turnId, requestId: firstQuestion.requestId, answers: [{ id: "scope", selected: ["最小修复"] }] });

    const secondEvents = await collectEvents(runtime.turns.continue({ sessionId: session.id, turnId, requestId: firstQuestion.requestId }));
    const secondQuestion = secondEvents.find((event) => event.type === "question_required");
    if (secondQuestion?.type !== "question_required") throw new Error("第二题不存在");

    await expect(collectEvents(runtime.turns.continue({ sessionId: session.id, turnId, requestId: firstQuestion.requestId }))).rejects.toMatchObject({ code: "QUESTION_TURN_STATE_INVALID" });
    expect(await ports.checkpointStore.getLatest(session.id)).toMatchObject({
      status: "awaiting_user_input",
      pendingCalls: [{ id: "ask-second" }],
      pendingUserQuestion: { callId: "ask-second", requestId: secondQuestion.requestId },
    });
  });

  it("取消后继续同一 Turn 会重新展示原问题", async function reissuesQuestionAfterCancelledTurnContinues() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        modelSampler: {
          async sample() {
            return { content: "", toolCalls: [{ id: "ask-cancelled", name: "ask_user_question", input: { questions: createQuestion() } }], reasoningSummary: "需要确认范围" };
          },
        },
      },
    });
    const session = await runtime.sessions.create({ title: "取消后继续结构化澄清测试" });
    const turnId = "runtime-question-cancelled-turn";
    const initialEvents = await collectEvents(runtime.turns.start({ sessionId: session.id, turnId, content: "请确定实现范围" }));
    const initialQuestion = initialEvents.find((event) => event.type === "question_required");
    if (initialQuestion?.type !== "question_required") throw new Error("初始问题不存在");

    await runtime.turns.cancel({ sessionId: session.id, turnId });
    const resumedEvents = await collectEvents(runtime.turns.continue({ sessionId: session.id, turnId }));

    expect(resumedEvents.find((event) => event.type === "question_required")).toMatchObject({
      callId: "ask-cancelled",
      requestId: initialQuestion.requestId,
      questions: createQuestion(),
    });
    expect(await ports.checkpointStore.getLatest(session.id)).toMatchObject({
      status: "awaiting_user_input",
      pendingUserQuestion: { callId: "ask-cancelled", requestId: initialQuestion.requestId },
    });
  });
});
