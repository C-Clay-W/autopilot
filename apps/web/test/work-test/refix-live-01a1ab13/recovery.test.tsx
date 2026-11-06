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


/** 清理仅本用例创建的替身。 */
afterEach(function cleanup() { vi.unstubAllGlobals(); vi.clearAllMocks(); });
/** 正式两个Hook组合，受控流延迟输出，不操作真实会话。 */
async function fixture() {
 const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
 vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(), requestAnimationFrame: function schedule(cb: FrameRequestCallback) { frames.set(++frameId, cb); return frameId; }, cancelAnimationFrame: function cancel(id: number) { frames.delete(id); } });
 const snapshot: any = { meta: { id: "session", productMode: "work", runtimeStatus: "interrupted" }, messages: [{ id: "assistant", role: "assistant", content: "", turnId: "turn" }], presentation: { ...createPresentationState(), turnId: "turn", lastSeqByTurn: { turn: 10 } }, agent: { turnId: "turn", status: "interrupted_recoverable", recoverable: true } };
 let stream!: ReadableStreamDefaultController<Uint8Array>;
 const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
 const history = deferred<Response>();
 let delayHistory = false;
 let delayContinue = false; const continueBody = deferred<{ controlId: string }>();
 vi.stubGlobal("fetch", vi.fn(async function fetcher(input: unknown) {
  const url = String(input);
  if (url.endsWith("/continue")) return delayContinue ? Object.assign(Response.json({}), { json: function body() { return continueBody.promise; } }) : Response.json({ controlId: "control" }, { status: 202 });
  if (url.includes("/stream")) return response;
  return delayHistory ? history.promise : Response.json(snapshot);
 }));
 let conversation!: ReturnType<typeof useSessionConversation>;
 let recovery!: ReturnType<typeof useTurnRecoveryActions>;
 const notify = vi.fn(), pins = vi.fn(), skills = vi.fn();
 /** 直接复用页面的共享状态和代次。 */
 function Probe() {
  conversation = useSessionConversation({ workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: notify, setSelectedSkills: skills, setPinnedSkills: pins });
  recovery = useTurnRecoveryActions({ ...conversation, isChat: false, workspaceId: "workspace", sessionId: "session", canWrite: true, textareaRef: { current: null } });
  return null;
 }
 const mounted = render(createElement(Probe));
 await frame(); await frame();
 /** 模拟持久SSE信封。 */
 function event(type: string, seq: number, extra: object = {}) { return { type, seq, sessionId: "session", turnId: "turn", timestamp: new Date().toISOString(), ...extra }; }
 /** 向原连接提供事件，允许检验旧流代次。 */
 async function send(type: string, seq: number, extra: object = {}) { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event(type, seq, extra))}\n\n`)); await frame(); for (const [id, callback] of frames) { frames.delete(id); callback(performance.now()); } await frame(); }
 /** 独立流模拟另一新订阅到达。 */
 async function receive(type: string, seq: number, extra: object = {}) { await conversation.consumeAgentStream(new Response(`data: ${JSON.stringify(event(type, seq, extra))}\n\n`), "assistant", "session"); await frame(); }
 return { get conversation() { return conversation; }, get recovery() { return recovery; }, send, receive, event, snapshot, history, continueBody, delayAcceptance: function delayAcceptance() { delayContinue = true; }, delay: function delay() { delayHistory = true; }, close: function close() { try { stream.close(); } catch {} mounted.unmount(); } };
}
it.each(["turn_started", "answer_delta", "tool_result"])("r003 accepted不冒充运行，%s真实新事实清除旧恢复标记", async function clearsOnRunning(type) {
 const f = await fixture();
 try {
  await f.recovery.handleContinueTurn("assistant"); await frame();
  expect(f.conversation.loading).toBe(false);
  expect(f.conversation.messages.find(function target(m) { return m.id === "assistant"; })).toMatchObject({ canContinue: true });
  await f.send(type, 11, type === "answer_delta" ? { stepId: "step", delta: "正在输出" } : type === "tool_result" ? { stepId: "step", callId: "call", toolName: "read_file", result: { status: "success" } } : {});
  expect(f.conversation.loading).toBe(true);
  expect(f.conversation.messages.find(function target(m) { return m.id === "assistant"; })).toMatchObject({ canContinue: false, recoveryError: undefined, activity: "answer" });
 } finally { f.close(); }
});
it("r003 迟到旧事件与旧History不能覆盖新审批，跨会话信封拒绝", async function guardsNewApproval() {
 const f = await fixture();
 try {
  await f.recovery.handleContinueTurn("assistant"); await frame();
  await f.send("turn_started", 11);
  f.delay(); f.conversation.requestAbortRef.current = null;
  const pending = f.conversation.loadHistory("session");
  await f.receive("approval_required", 12, { result: { approval: { approvalId: "new-approval" } }, callId: "call", toolName: "read_file" });
  expect(f.conversation.awaitingApprovalRef.current).toBe(true);
  await f.send("answer_delta", 13, { delta: "旧流迟到", stepId: "step" });
  await f.receive("turn_started", 11);
  await f.receive("turn_started", 14, { sessionId: "another-session" });
  f.history.resolve(Response.json(f.snapshot));
  expect(await pending).toBe(false);
  expect(f.conversation.awaitingApprovalRef.current).toBe(true);
  expect(f.conversation.loading).toBe(false);
  expect(f.conversation.messages.find(function target(m) { return m.id === "assistant"; })?.canContinue).toBe(false);
 } finally { f.close(); }
});

it.each(["turn_started", "approval_required"])("r003 迟到accepted JSON不能覆盖先到的%s", async function lateAcceptance(type) {
 const f = await fixture();
 try {
  f.delayAcceptance();
  const submitting = f.recovery.handleContinueTurn("assistant");
  await frame();
  await f.receive(type, 11, type === "approval_required" ? { result: { approval: { approvalId: "new" } }, callId: "new-call", toolName: "read_file" } : {});
  f.continueBody.resolve({ controlId: "late-control" });
  await submitting; await frame();
  expect(f.conversation.messages.find(function target(m) { return m.id === "assistant"; })?.recoveryError).toBeUndefined();
  expect(f.conversation.messages.find(function target(m) { return m.id === "assistant"; })?.canContinue).toBe(false);
  expect(f.conversation.awaitingApprovalRef.current).toBe(type === "approval_required");
  expect(context.manager.beginSession).not.toHaveBeenCalled();
 } finally { f.close(); }
});
