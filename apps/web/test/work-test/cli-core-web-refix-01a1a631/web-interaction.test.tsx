/** S3 正式恢复Hook的提交/观察代次回归，复用已有Ink挂载真实React生命周期。 */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createPresentationState, type UserQuestionItem } from "@autopilot-agent/presentation";
import { useSessionConversation } from "@/app/chat/hooks/useSessionConversation";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";

const context = vi.hoisted(function mocks() {
  const empty: unknown[] = [];
  return { manager: { subscribeList: function subscribe() { return function remove() {}; }, getListSnapshot: function snapshot() { return empty; }, beginSession: vi.fn(), getSessionSnapshot: vi.fn(), updateRuntimeState: vi.fn(), applyTerminalEvent: vi.fn() }, refreshSessions: vi.fn() };
});
vi.mock("@/app/chat/session-task-context", function mockContext() { return { useSessionTaskContext: function read() { return context; } }; });
vi.mock("@/app/chat/components/Notice", function mockNotice() { return { useNotice: function notice() { return { warning: vi.fn(), error: vi.fn(), success: vi.fn() }; } }; });

/** 等待真实React的订阅/effect提交。 */
async function frame() { await new Promise(function wait(resolve) { setTimeout(resolve, 25); }); }
/** 显式控制网络与流的完成时刻。 */
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>(function wait(done, fail) { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
/** 与React setter相同的函数更新约定。 */
function cell<T>(initial: T) { let value = initial; return { get value() { return value; }, set: function set(next: T | ((current: T) => T)) { value = typeof next === "function" ? (next as (current: T) => T)(value) : next; } }; }
/** 构造安全问题Presentation，没有答案正文缓存。 */
function question(requestId = "q1"): UserQuestionItem { return { id: `question:${requestId}`, kind: "user_question", turnId: "turn", requestId, callId: `call-${requestId}`, state: "required", questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "小", description: "最小" }, { label: "全", description: "全部" }] }] }; }

/** 挂载正式Hook，页面回调保留可检验目标事实，流消费使用受控Promise。 */
function harness() {
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const item = question();
  const presentation = cell({ ...createPresentationState(), items: [item] });
  const messages = cell([{ id: "assistant", role: "assistant", content: "", turnId: "turn" }] as any[]);
  const stream = deferred<"terminal_seen">();
  const options: any = {
    isChat: false, workspaceId: "workspace", sessionId: "session", canWrite: true, messages: messages.value, loading: false, activeTurnId: "turn", streamingMessageId: "assistant", resumePendingSessionId: null,
    textareaRef: { current: null }, setMessages: messages.set, setLoading: vi.fn(), setActivity: vi.fn(), setPresentation: presentation.set, setStreamingMessageId: vi.fn(), setActiveTurnId: vi.fn(), setPendingInputs: vi.fn(), setResumePendingSessionId: vi.fn(),
    loadHistory: vi.fn(async function history() { return true; }), consumeAgentStream: vi.fn(function consume() { return stream.promise; }), getSessionController: function controller() { return { createAbortController: function create() { return new AbortController(); } }; }, setTransportState: vi.fn(), clearActiveTurn: vi.fn(), markAwaitingUserInput: vi.fn(),
    activeTurnRef: { current: { sessionId: "session", turnId: "turn" } }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, cancelInFlightRef: { current: null }, requestAbortRef: { current: null }, transportDisconnectedRef: { current: false }, awaitingApprovalRef: { current: false }, awaitingUserInputRef: { current: true }, executionEpochRef: { current: 0 }, pendingInputsRef: { current: [] }, currentSessionIdRef: { current: "session" }, currentWorkspaceIdRef: { current: "workspace" },
  };
  let hook!: ReturnType<typeof useTurnRecoveryActions>;
  /** Hook真实挂载，不复制其状态机。 */
  function Probe() { hook = useTurnRecoveryActions(options); return null; }
  const view = render(createElement(Probe));
  return { item, options, messages, presentation, stream, get hook() { return hook; }, rerender: function rerender() { options.messages = messages.value; view.rerender(createElement(Probe)); }, unmount: view.unmount };
}

/** 只恢复本文件的HTTP/浏览器替身。 */
afterEach(function cleanup() { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("S3 答案保存并继续202后提交Promise及时结束，离线待领取显示已保存，后台流独立收尾", async function releasesSubmission() {
  const f = harness();
  const fetcher = vi.fn(async function respond(input: unknown) { return String(input).endsWith("/questions") ? Response.json({ ok: true }) : String(input).endsWith("/continue") ? Response.json({ accepted: true, controlId: "control" }, { status: 202 }) : new Response("controlled"); });
  vi.stubGlobal("fetch", fetcher);
  try {
    await frame();
    await f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }]);
    await frame();
    expect(f.options.consumeAgentStream).toHaveBeenCalledTimes(1);
    expect(f.presentation.value.items[0].state).toBe("answered");
    expect(f.messages.value[0]).toMatchObject({ questionRequestId: "q1", canContinue: true, recoveryError: "答案已保存，等待兼容宿主接手" });
    expect(f.options.setLoading).toHaveBeenLastCalledWith(false);
    f.stream.resolve("terminal_seen");
    await frame();
    expect(f.options.requestAbortRef.current).toBeNull();
  } finally { f.stream.resolve("terminal_seen"); f.unmount(); }
});

it("S3 答案保存后continue失败，原请求重试跳过questions并保留恢复入口", async function retriesSavedAnswer() {
  const f = harness();
  let rejectContinue = true;
  const fetcher = vi.fn(async function respond(input: unknown) { const url = String(input); if (url.endsWith("/questions")) return Response.json({ ok: true }); if (url.endsWith("/continue")) return rejectContinue ? Response.json({ error: "controlled" }, { status: 409 }) : Response.json({ accepted: true, controlId: "control" }, { status: 202 }); return new Response("controlled"); });
  vi.stubGlobal("fetch", fetcher);
  try {
    await frame();
    await expect(f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }])).rejects.toThrow("答案已保存");
    expect(f.presentation.value.items[0].state).toBe("answered");
    expect(f.messages.value[0]).toMatchObject({ canContinue: true, questionRequestId: "q1" });
    rejectContinue = false;
    f.rerender();
    await frame();
    await f.hook.handleContinueTurn("assistant");
    expect(fetcher.mock.calls.filter(function questions(call) { return String(call[0]).endsWith("/questions"); })).toHaveLength(1);
    const request = fetcher.mock.calls.filter(function continuation(call) { return String(call[0]).endsWith("/continue"); }).at(-1)!;
    expect(JSON.parse((request[1] as RequestInit).body as string)).toEqual({ turnId: "turn", requestId: "q1" });
  } finally { f.stream.resolve("terminal_seen"); await frame(); f.unmount(); }
});

it("S3 切会话后的迟到答案响应不继续也不更新新目标", async function ignoresSwitchedResponse() {
  const f = harness();
  const response = deferred<Response>();
  const fetcher = vi.fn(function respond() { return response.promise; });
  vi.stubGlobal("fetch", fetcher);
  try {
    await frame();
    const submit = f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }]);
    f.options.currentSessionIdRef.current = "other";
    f.options.executionEpochRef.current++;
    response.resolve(Response.json({ ok: true }));
    await submit;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.presentation.value.items[0].state).toBe("required");
    expect(f.messages.value[0]).not.toHaveProperty("questionRequestId");
  } finally { f.unmount(); }
});

it("S3 正式取消后迟到questions响应不能发continue或复活问题", async function ignoresCancelledResponse() {
  const f = harness();
  const response = deferred<Response>();
  const fetcher = vi.fn(function respond(input: unknown) { const url = String(input); return url.endsWith("/questions") ? response.promise : Promise.resolve(Response.json(url.includes("/turn-state") ? { turnId: "turn", cancellation: "confirmed" } : { ok: true })); });
  vi.stubGlobal("fetch", fetcher);
  try {
    await frame();
    const submit = f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }]);
    await f.hook.cancelCurrentTurn();
    const afterCancel = JSON.stringify(f.messages.value);
    response.resolve(Response.json({ ok: true }));
    await submit;
    expect(fetcher.mock.calls.some(function continuation(call) { return String(call[0]).endsWith("/continue"); })).toBe(false);
    expect(JSON.stringify(f.messages.value)).toBe(afterCancel);
  } finally { f.unmount(); }
});

it("S3 同Turn新请求代次抵御旧观察失败，断流在当前请求显示恢复提示", async function fencesObservationFailure() {
  const f = harness();
  vi.stubGlobal("fetch", vi.fn(async function respond(input: unknown) { return String(input).endsWith("/questions") ? Response.json({ ok: true }) : String(input).endsWith("/continue") ? Response.json({ accepted: true }, { status: 202 }) : new Response("controlled"); }));
  try {
    await frame();
    await f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }]);
    f.options.executionEpochRef.current++;
    f.presentation.set({ ...createPresentationState(), items: [question("q2")] });
    const before = JSON.stringify(f.messages.value);
    f.stream.reject(new TypeError("controlled transport failure"));
    await frame();
    expect(JSON.stringify(f.messages.value)).toBe(before);
    expect(f.presentation.value.items[0].requestId).toBe("q2");
    expect(f.options.setTransportState).not.toHaveBeenCalled();
  } finally { f.unmount(); }
});

it("S3 当前观察断流可见且不重新提交答案", async function currentDisconnect() {
  const f = harness();
  const fetcher = vi.fn(async function respond(input: unknown) { return String(input).endsWith("/questions") ? Response.json({ ok: true }) : String(input).endsWith("/continue") ? Response.json({ accepted: true }, { status: 202 }) : new Response("controlled"); });
  vi.stubGlobal("fetch", fetcher);
  try {
    await frame();
    await f.hook.handleUserQuestion("assistant", f.item, [{ id: "scope", selected: ["小"] }]);
    f.stream.reject(new TypeError("controlled transport failure"));
    await frame();
    expect(f.messages.value[0].recoveryError).toContain("观察连接中断");
    expect(f.presentation.value.items[0].state).toBe("answered");
    expect(fetcher.mock.calls.filter(function questions(call) { return String(call[0]).endsWith("/questions"); })).toHaveLength(1);
  } finally { f.unmount(); }
});

it("S3 正式Session事件入口只为新问题推进executionEpoch，重复请求保留代次", async function actualEpochProducer() {
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async function history() { return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "waiting_user_input" }, messages: [{ id: "assistant", role: "assistant", content: "", turnId: "turn" }], presentation: { ...createPresentationState(), items: [question("q1")] }, agent: { turnId: "turn", status: "awaiting_user_input", requestId: "q1", interactionState: "pending", recoverable: true } }); }));
  let conversation!: ReturnType<typeof useSessionConversation>;
  /** 使用正式Session Hook及controller接收安全SSE事件。 */
  function Probe() { conversation = useSessionConversation({ workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() }); return null; }
  const mounted = render(createElement(Probe));
  try {
    await frame();
    expect(conversation.historyReady).toBe(true);
    /** 只构造受信事件字段，消费入口仍为生产Session controller。 */
    async function receive(requestId: string, seq: number) {
      const event = { sessionId: "session", turnId: "turn", timestamp: new Date().toISOString(), seq, type: "question_required", callId: `call-${requestId}`, requestId, questions: question(requestId).questions };
      const body = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
      await conversation.consumeAgentStream(new Response(body), "assistant", "session");
      await frame();
    }
    await receive("q1", 1);
    const first = conversation.executionEpochRef.current;
    await receive("q1", 1);
    expect(conversation.executionEpochRef.current).toBe(first);
    await receive("q2", 2);
    expect(conversation.executionEpochRef.current).toBe(first + 1);
  } finally { mounted.unmount(); }
});

it("S3 History重开claimed首事件窗口保留原请求恢复，未知执行结果禁止自动继续", async function restoresClaimedInteraction() {
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const agent = { turnId: "turn", status: "awaiting_user_input", requestId: "q1", interactionState: "unconfirmed", execution: "unconfirmed", recoverable: true, continuation: { controlId: "control", state: "claimed" } };
  const snapshot = { meta: { id: "session", productMode: "work", runtimeStatus: "waiting_user_input" }, messages: [{ id: "assistant", role: "assistant", content: "", turnId: "turn" }], presentation: { ...createPresentationState(), items: [{ ...question("q1"), state: "answered" }] }, agent };
  const fetcher = vi.fn(async function history() { return Response.json(snapshot); });
  vi.stubGlobal("fetch", fetcher);
  let conversation!: ReturnType<typeof useSessionConversation>;
  /** 正式History恢复入口验证保存事实与恢复动作，不模拟页面状态机。 */
  function Probe() { conversation = useSessionConversation({ workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() }); return null; }
  const mounted = render(createElement(Probe));
  try {
    await frame();
    expect(conversation.historyReady).toBe(true);
    expect(conversation.messages.find(function notice(message) { return message.id === "execution-notice-turn"; })).toMatchObject({ content: "答案已保存，等待兼容宿主继续原任务", questionRequestId: "q1", canContinue: true });
    expect(conversation.presentation.items[0].state).toBe("answered");
    await conversation.loadHistory("session", { ...snapshot, agent: { ...agent, continuation: { controlId: "control", state: "failed", failureCode: "BOUNDARY_CHANGED" } } } as any, true);
    await frame();
    expect(conversation.messages.find(function notice(message) { return message.id === "execution-notice-turn"; })).toMatchObject({ content: "原决定或答案已保存，执行结果未确认，请先核对原任务状态", canContinue: false });
    expect(conversation.messages.some(function resumable(message) { return message.canContinue; })).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { mounted.unmount(); }
});

it("S3 审批保存前失败以权威History恢复当前卡，不再撤下仍有效请求", async function approvalSaveFailure() {
  const f = harness();
  const approval = { id: "approval:a1", kind: "approval", approvalId: "a1", turnId: "turn", callId: "call", toolName: "todo_write", reason: "controlled", state: "required" } as any;
  f.presentation.set({ ...createPresentationState(), items: [approval] });
  f.options.awaitingUserInputRef.current = false;
  f.options.awaitingApprovalRef.current = true;
  f.options.loadHistory = vi.fn(async function authoritativePending() { f.presentation.set({ ...createPresentationState(), items: [approval] }); return true; });
  const fetcher = vi.fn(async function unavailable() { return Response.json({ error: "controlled" }, { status: 503 }); });
  vi.stubGlobal("fetch", fetcher);
  f.rerender();
  try {
    await frame();
    await f.hook.handleApproval("assistant", approval, "allow_once");
    expect(f.options.loadHistory).toHaveBeenCalledTimes(1);
    expect(f.presentation.value.items[0].state).toBe("required");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { f.unmount(); }
});
