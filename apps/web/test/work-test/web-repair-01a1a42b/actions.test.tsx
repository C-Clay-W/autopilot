/** 真实React Hook定向回归，用原Ink renderer挂载并隔离HTTP/会话上下文。 */
import { createElement, type Dispatch, type SetStateAction } from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPresentationState, type AgentPresentationState, type ApprovalItem } from "@autopilot-agent/presentation";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";
import { useSessionConversation } from "@/app/chat/hooks/useSessionConversation";
import type { Message } from "@/app/chat/chat-page-types";

const context = vi.hoisted(function mocks() {
  const list: unknown[] = [];
  return { manager: { subscribeList: function subscribe() { return function unsubscribe() {}; }, getListSnapshot: function snapshot() { return list; }, getSessionSnapshot: vi.fn(), updateRuntimeState: vi.fn(), beginSession: vi.fn(), applyTerminalEvent: vi.fn() }, refreshSessions: vi.fn() };
});
vi.mock("@/app/chat/session-task-context", function contextMock() { return { useSessionTaskContext: function current() { return context; } }; });
vi.mock("@/app/chat/components/Notice", function noticeMock() { return { useNotice: function notice() { return { error: vi.fn(), warning: vi.fn() }; } }; });

/** 执行真实Hook生命周期，不替换React状态实现。 */
function mount<T, P extends object>(hook: (options: P) => T, options: P) {
  let current!: T;
  /** 空渲染探针，仅向测试暴露本次Hook结果。 */
  function Probe() { current = hook(options); return null; }
  const mounted = render(createElement(Probe));
  return { get current() { return current; }, unmount: mounted.unmount };
}

/** 外部页面setter按React函数更新约定记录可见状态。 */
function cell<T>(initial: T) {
  let value = initial;
  const set: Dispatch<SetStateAction<T>> = function update(next) { value = typeof next === "function" ? (next as (old: T) => T)(value) : next; };
  return { get value() { return value; }, set };
}

/** 等待有界React提交。 */
async function frame() { await new Promise<void>(function tick(resolve) { setTimeout(resolve, 30); }); }

/** 构造真实恢复Hook的固定Session/Turn及共享refs，避免任何外部进程。 */
function recovery() {
  const messages = cell<Message[]>([{ id: "assistant", role: "assistant", turnId: "T", content: "", recoveryError: "旧停止红字", canContinue: true }]);
  const presentation = cell<AgentPresentationState>(createPresentationState());
  const options = {
    isChat: false, workspaceId: "ws", sessionId: "session", canWrite: true, loading: true, activeTurnId: "T", streamingMessageId: "assistant", resumePendingSessionId: null, messages: messages.value,
    textareaRef: { current: null }, setMessages: messages.set, setPresentation: presentation.set, setLoading: vi.fn(), setActivity: vi.fn(), setStreamingMessageId: vi.fn(), setActiveTurnId: vi.fn(), setPendingInputs: vi.fn(), setResumePendingSessionId: vi.fn(),
    loadHistory: vi.fn(async function history() { return true; }), consumeAgentStream: vi.fn(async function stream() { return "terminal_seen" as const; }), getSessionController: vi.fn(), setTransportState: vi.fn(), clearActiveTurn: vi.fn(), markAwaitingUserInput: vi.fn(),
    activeTurnRef: { current: { sessionId: "session", turnId: "T" } }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set<string>() }, cancelInFlightRef: { current: null }, requestAbortRef: { current: null }, transportDisconnectedRef: { current: false }, awaitingApprovalRef: { current: true }, awaitingUserInputRef: { current: false }, executionEpochRef: { current: 0 }, pendingInputsRef: { current: [] }, currentSessionIdRef: { current: "session" }, currentWorkspaceIdRef: { current: "ws" },
  } as Parameters<typeof useTurnRecoveryActions>[0];
  return { options, messages, presentation };
}

beforeEach(function globals() { vi.clearAllMocks(); vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(function cleanup() { vi.unstubAllGlobals(); });

it("审批History恢复清loading，原观察流不会持续占用可提交状态", async function approvalHistoryReleasesBusy() {
  vi.stubGlobal("fetch", vi.fn(async function history() { return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "waiting_approval" }, messages: [], presentation: createPresentationState(), agent: { turnId: "T", status: "awaiting_approval", approvalId: "A", interactionState: "pending", execution: "inactive" } }); }));
  const hook = mount(useSessionConversation, { workspaceId: "ws", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() });
  try {
    await frame(); hook.current.setLoading(true); await frame();
    await hook.current.loadHistory("session", undefined, true); await frame();
    expect(hook.current.loading).toBe(false);
    expect(hook.current.awaitingApprovalRef.current).toBe(true);
    expect(hook.current.activeTurnRef.current).toEqual({ sessionId: "session", turnId: "T" });
  } finally { hook.unmount(); }
});

it("观察loading不阻止有效审批，双击只提交一次精确原请求", async function approvalDuringObservation() {
  const h = recovery();
  const fetch = vi.fn(async function accepted(_url: string, _init?: RequestInit) { return Response.json({ ok: true }, { status: 202 }); });
  vi.stubGlobal("fetch", fetch);
  const hook = mount(useTurnRecoveryActions, h.options);
  const approval: ApprovalItem = { id: "approval:A", kind: "approval", turnId: "T", approvalId: "A", callId: "C", toolName: "write_file", state: "required" };
  try {
    await Promise.all([hook.current.handleApproval("assistant", approval, "allow_once"), hook.current.handleApproval("assistant", approval, "allow_once")]);
    const submissions = fetch.mock.calls.filter(function approvalRequest(call) { return String(call[0]).endsWith("/approvals"); });
    expect(submissions).toHaveLength(1);
    expect(JSON.parse((submissions[0][1] as RequestInit).body as string)).toEqual({ turnId: "T", approvalId: "A", decision: "allow_once" });
    expect(h.options.setLoading).toHaveBeenLastCalledWith(false);
  } finally { hook.unmount(); }
});

it("停止HTTP失败后精确终态确认清旧红字并保留同Turn恢复", async function cancellationConfirmedAfterError() {
  const h = recovery();
  h.options.loadHistory = vi.fn(async function confirmedHistory() { h.messages.set([{ id: "assistant", role: "assistant", turnId: "T", content: "", canContinue: true, recoveryError: "旧提示" }]); return true; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ error: "pending" }, { status: 409 })).mockResolvedValueOnce(Response.json({ turnId: "T", cancellation: "confirmed", status: "interrupted" })));
  const hook = mount(useTurnRecoveryActions, h.options);
  try {
    await hook.current.cancelCurrentTurn();
    expect(h.messages.value[0]).toMatchObject({ stopState: "stopped", recoveryError: undefined, canContinue: true });
    expect(h.options.loadHistory).toHaveBeenCalledWith("session", undefined, true, expect.any(AbortSignal));
    expect(h.options.clearActiveTurn).toHaveBeenCalled();
    expect(h.options.cancelInFlightRef.current).toBeNull();
  } finally { hook.unmount(); }
});

it("一次复查pending后继续确认，迟到的其他Turn不能确认本次停止", async function boundedCancellationRecheck() {
  const h = recovery();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 202 })).mockResolvedValueOnce(Response.json({ turnId: "other", cancellation: "confirmed" })).mockResolvedValueOnce(Response.json({ turnId: "T", cancellation: "confirmed" }));
  vi.stubGlobal("fetch", fetch);
  const hook = mount(useTurnRecoveryActions, h.options);
  try {
    await hook.current.cancelCurrentTurn();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(h.messages.value[0].stopState).toBe("stopped");
    expect(h.messages.value[0].recoveryError).toBeUndefined();
  } finally { hook.unmount(); }
});

it("待确认停止不能继续或提交旧审批", async function pendingStopKeepsInteractionClosed() {
  const h = recovery();
  h.options.messages[0].stopState = "pending";
  h.options.cancelledTurnIdsRef.current.add("T");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const hook = mount(useTurnRecoveryActions, h.options);
  try {
    await hook.current.handleContinueTurn("assistant");
    await hook.current.handleApproval("assistant", { id: "A", kind: "approval", approvalId: "A", turnId: "T", callId: "C", toolName: "write_file", state: "required" }, "allow_once");
    expect(fetch).not.toHaveBeenCalled();
  } finally { hook.unmount(); }
});

it("停止确认后的History永久无响应仍在有界预算内释放busy", async function boundedHistoryAfterCancel() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const h = recovery();
  let historySignal: AbortSignal | undefined;
  h.options.loadHistory = vi.fn(function stalled(_sid, _data, _observation, signal?: AbortSignal) { historySignal = signal; return new Promise<boolean>(function pending() {}); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({}, { status: 202 })).mockResolvedValueOnce(Response.json({ turnId: "T", cancellation: "confirmed" })));
  const hook = mount(useTurnRecoveryActions, h.options);
  try {
    const completion = hook.current.cancelCurrentTurn().then(function completed() { return "done"; });
    const outcome = Promise.race([completion, new Promise<string>(function budget(resolve) { setTimeout(function expired() { resolve("busy"); }, 4000); })]);
    await vi.advanceTimersByTimeAsync(4001);
    expect(await outcome).toBe("done");
    expect(historySignal?.aborted).toBe(true);
    expect(h.options.cancelInFlightRef.current).toBeNull();
    expect(h.messages.value[0].stopState).toBe("stopped");
  } finally { hook.unmount(); vi.useRealTimers(); }
});

it("有界History取消后忽略不响应abort的迟到旧结果", async function abortedHistoryCannotOverwrite() {
  const fetch = vi.fn(async function initial() { return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "idle" }, messages: [] }); });
  vi.stubGlobal("fetch", fetch);
  const hook = mount(useSessionConversation, { workspaceId: "ws", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() });
  try {
    await frame();
    let deliver!: (response: Response) => void;
    fetch.mockImplementationOnce(function late() { return new Promise<Response>(function hold(resolve) { deliver = resolve; }); });
    const controller = new AbortController();
    const history = hook.current.loadHistory("session", undefined, true, controller.signal);
    controller.abort();
    deliver(Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "running" }, messages: [{ id: "late", role: "assistant", content: "迟到旧消息" }] }));
    expect(await history).toBe(false);
    await frame();
    expect(hook.current.messages.some(function late(message) { return message.id === "late"; })).toBe(false);
  } finally { hook.unmount(); }
});
