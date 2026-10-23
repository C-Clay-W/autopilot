/** P16 Hook 行为回归：真实 React 挂载，隔离 HTTP/上下文，覆盖空会话和输入竞态。 */
import { createElement, type Dispatch, type SetStateAction } from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentationState, reducePresentationInput, selectTurnTimeline, type AgentPresentationState } from "@autopilot-agent/presentation";
import { useSessionConversation } from "@/app/chat/hooks/useSessionConversation";
import { useConversationSubmission } from "@/app/chat/hooks/useConversationSubmission";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";
import type { Message, PendingAgentInput } from "@/app/chat/chat-page-types";

const context = vi.hoisted(function contextMocks() { return { manager: { updateRuntimeState: vi.fn(), beginSession: vi.fn(), getSessionSnapshot: vi.fn(), applyTerminalEvent: vi.fn() }, refreshSessions: vi.fn() }; });
/** 通知与上下文一样提升为共享替身，便于断言用户可见的停止/继续提示。 */
const notice = vi.hoisted(function noticeMocks() { return { error: vi.fn(), warning: vi.fn(), success: vi.fn() }; });
vi.mock("@/app/chat/session-task-context", function contextMock() { return { useSessionTaskContext: function readContext() { return context; } }; });
vi.mock("@/app/chat/components/Notice", function noticeMock() { return { useNotice: function useNoticeMock() { return notice; } }; });
vi.mock("@/lib/knowledge-ingest-client", function knowledgeMock() { return { uploadChatKnowledge: vi.fn() }; });

/** 用现有 Ink 测试 renderer 执行真实 React Hook 生命周期，不模拟 React 或复制 Hook 逻辑。 */
function mountHook<T, P extends object>(hook: (props: P) => T, initial: P) {
  let current!: T;
  function Probe(props: P) { current = hook(props); return null; }
  const mounted = render(createElement(Probe, initial as P & Record<string, unknown>));
  return { get current() { return current; }, rerender(props: P) { mounted.rerender(createElement(Probe, props as P & Record<string, unknown>)); }, unmount: mounted.unmount };
}

/** 等待 React 的 effect 与有限异步状态提交。 */
async function frame(): Promise<void> { await new Promise<void>(function next(resolve) { setTimeout(resolve, 25); }); }

/** HTTP 回调由测试显式决定先后顺序。 */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(function pending(done) { resolve = done; }); return { promise, resolve }; }

/** 状态 setter 使用 React 相同的函数更新约定，供两个实际 Hook 共用页面事实。 */
function cell<T>(initial: T) { let value = initial; const set: Dispatch<SetStateAction<T>> = function update(next) { value = typeof next === "function" ? (next as (previous: T) => T)(value) : next; }; return { get value() { return value; }, set }; }

/** 构造真实 Hook 所需的页面回调及共享 refs，所有网络均由 fetch mock 控制。 */
function inputHarness() {
  const state = cell<AgentPresentationState>({ ...createPresentationState(), turnId: "A", items: [{ id: "answer", kind: "assistant_answer", turnId: "A", stepId: "s", channel: "process", content: "点击前" }] });
  const pending = cell<PendingAgentInput[]>([]);
  const messages = cell<Message[]>([]);
  const common = {
    isChat: false, workspaceId: "workspace", sessionId: "session", canWrite: true, messages: [], loading: true, activeTurnId: "A",
    textareaRef: { current: null }, setMessages: messages.set, setLoading: vi.fn(), setActivity: vi.fn(), setPresentation: state.set,
    setStreamingMessageId: vi.fn(), setActiveTurnId: vi.fn(), setPendingInputs: pending.set, setInputDeliveryNotice: vi.fn(), setResumePendingSessionId: vi.fn(),
    loadHistory: vi.fn(async function load() { return true; }), consumeAgentStream: vi.fn(async function stream() { return "terminal" as const; }), getSessionController: vi.fn(), setTransportState: vi.fn(), clearActiveTurn: vi.fn(), markAwaitingUserInput: vi.fn(),
    activeTurnRef: { current: null as { sessionId: string; turnId: string } | null }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set<string>() }, cancelInFlightRef: { current: null }, requestAbortRef: { current: null }, transportDisconnectedRef: { current: false }, awaitingApprovalRef: { current: false }, awaitingUserInputRef: { current: false }, executionEpochRef: { current: 0 },
    pendingInputsRef: { current: [] as PendingAgentInput[] }, currentSessionIdRef: { current: "session" }, currentWorkspaceIdRef: { current: "workspace" }, queueExecutionRequestedRef: { current: false }, joinedInputIdsRef: { current: new Set<string>() }, historyInputIdsRef: { current: new Set<string>() },
  };
  const submission = { ...common, presentation: state.value, hasWorkspace: true, currentRetrieval: "none", databaseEnabled: false, selectedSkills: [], setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn(), inputRef: { current: "用户原文\n@docs/a.md" }, inputActionsRef: { current: null }, onOpenWorkspacePicker: vi.fn(), onSessionStarting: vi.fn(), onSessionCreated: vi.fn(), handleContinueTurn: vi.fn(), requestNextQueuedTurn: vi.fn(), setSessionMeta: vi.fn(), setHistoryReady: vi.fn(), setReadOnlyReason: vi.fn(), setChatAttachments: vi.fn(), locallyCreatedSessionRef: { current: null } } as unknown as Parameters<typeof useConversationSubmission>[0];
  const recovery = { ...common, streamingMessageId: "assistant", resumePendingSessionId: null } as unknown as Parameters<typeof useTurnRecoveryActions>[0];
  return { state, pending, messages, common, submission, recovery };
}

describe("P16 session input Hooks", function suite() {
  beforeEach(function globals() { vi.clearAllMocks(); vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
  afterEach(function restore() { vi.unstubAllGlobals(); });

  it("已有活动 History 恢复后切空会话会执行全部清理，不引用越界变量", async function clearsEmptySession() {
    const presentation = { ...createPresentationState(), turnId: "A", activeOperation: { kind: "thinking" as const, id: "thinking" }, turnStartedAt: { A: new Date(1000).toISOString() } };
    vi.stubGlobal("fetch", vi.fn(async function history() { return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "running" }, messages: [{ id: "queue-message", role: "user", content: "领取的队列原文", turnId: "A", clientRecordId: "input:claimed", createdAt: 1 }], presentation, pendingInputs: [{ inputId: "pending", delivery: "queue", content: "旧等待" }] }); }));
    const options = { workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() };
    const hook = mountHook(useSessionConversation, options);
    try {
      await frame();
      expect(hook.current.historyReady).toBe(true);
      expect(hook.current.activity?.startedAt).toBe(1000);
      expect(hook.current.pendingInputs).toHaveLength(1);
      expect(hook.current.historyInputIdsRef.current.has("claimed")).toBe(true);
      expect(hook.current.joinedInputIdsRef.current.has("claimed")).toBe(true);
      hook.rerender({ ...options, sessionId: "" });
      await frame();
      expect(await hook.current.loadHistory("")).toBe(true);
      await frame();
      expect(hook.current.activity).toBeUndefined();
      expect(hook.current.sessionMeta).toBeNull();
      expect(hook.current.historyReady).toBe(true);
      expect(hook.current.pendingInputs).toEqual([]);
      expect(hook.current.pendingInputsRef.current).toEqual([]);
      expect(hook.current.messages).toEqual([]);
      expect(hook.current.loading).toBe(false);
      expect(hook.current.historyInputIdsRef.current.size).toBe(0);
    } finally { hook.unmount(); }
  });

  it("steer 消费先于POST确认且附件await期间回答继续时仍用点击边界保留一次正文", async function consumedBeforeConfirmation() {
    const h = inputHarness();
    const upload = deferred<Response>();
    const confirm = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(upload.promise).mockReturnValueOnce(confirm.promise));
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      hook.current.setSelectedFiles([{ name: "a.png", size: 1, file: new Blob(["x"]) as File }]);
      await frame();
      const sending = hook.current.handleSend();
      const answer = h.submission.presentation.items[0];
      h.state.set({ ...h.submission.presentation, items: answer.kind === "assistant_answer" ? [{ ...answer, content: answer.content + "点击后" }] : [answer] });
      upload.resolve(Response.json({ attachment: { id: "file", name: "a.png", mimeType: "image/png" } }));
      await frame();
      h.state.set(reducePresentationInput(h.state.value, { kind: "host_event", event: { kind: "input", input: { inputId: "input", turnId: "A", state: "consumed" } } }));
      h.common.joinedInputIdsRef.current.add("input");
      confirm.resolve(Response.json({ inputId: "input", delivery: "steer", status: "consumed", turnId: "A" }, { status: 202 }));
      await sending;
      const timeline = selectTurnTimeline(h.state.value, "A");
      expect(timeline.map(function kind(item) { return item.kind; })).toEqual(["assistant_answer", "input_notice", "assistant_answer"]);
      expect(timeline[0]).toMatchObject({ content: "点击前" });
      expect(timeline[1]).toMatchObject({ content: "用户原文\n@docs/a.md", state: "consumed" });
      expect(h.pending.value).toEqual([]);
    } finally { hook.unmount(); }
  });

  it("慢附件提交与后续无附件提交的确认反序时仍按点击序展示引导", async function attachmentSubmissionOrder() {
    const h = inputHarness();
    const upload = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(upload.promise).mockResolvedValueOnce(Response.json({ inputId: "second", delivery: "steer", status: "pending", turnId: "A" }, { status: 202 })).mockResolvedValueOnce(Response.json({ inputId: "first", delivery: "steer", status: "pending", turnId: "A" }, { status: 202 })));
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      hook.current.setSelectedFiles([{ name: "a.png", size: 1, file: new Blob(["x"]) as File }]);
      await frame();
      h.submission.inputRef.current = "首条引导";
      const first = hook.current.handleSend();
      await frame();
      h.submission.inputRef.current = "后续引导";
      await hook.current.handleSend();
      upload.resolve(Response.json({ attachment: { id: "file", name: "a.png", mimeType: "image/png" } }));
      await first;
      const inputs = selectTurnTimeline(h.state.value, "A").filter(function input(item) { return item.kind === "input_notice"; });
      expect(inputs.map(function text(item) { return item.kind === "input_notice" ? item.content : undefined; })).toEqual(["首条引导", "后续引导"]);
    } finally { hook.unmount(); }
  });

  it.each(["session", "workspace", "error"])("旧POST %s 回调不能写入切换后的目标", async function ignoresOldCallback(kind) {
    const h = inputHarness();
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(function wait() { return response.promise; }));
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      const sending = hook.current.handleSend();
      if (kind === "workspace") h.common.currentWorkspaceIdRef.current = "other-workspace";
      else h.common.currentSessionIdRef.current = "other-session";
      response.resolve(Response.json(kind === "error" ? { code: "active_turn_finished" } : { inputId: "old", delivery: "steer", status: "pending", turnId: "A" }, { status: kind === "error" ? 409 : 202 }));
      await sending;
      expect(h.messages.value).toEqual([]);
      expect(h.pending.value).toEqual([]);
      expect(h.state.value.items.some(function input(item) { return item.kind === "input_notice"; })).toBe(false);
      expect(h.common.clearActiveTurn).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it("queue 实际领取headers先于确认时两Hook按同一inputId补正文且不重建等待", async function queuedBeforeConfirmation() {
    const h = inputHarness();
    const confirmation = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(confirmation.promise).mockResolvedValueOnce(new Response("data: end\n\n", { headers: { "X-Agent-Input-Id": "queue", "X-Agent-Turn-Id": "B" } })));
    const submit = mountHook(useConversationSubmission, h.submission);
    const recovery = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      submit.current.setInputDelivery("queue");
      await frame();
      const sending = submit.current.handleSend();
      await recovery.current.requestNextQueuedTurn();
      confirmation.resolve(Response.json({ inputId: "queue", delivery: "queue", status: "consumed", turnId: "A" }, { status: 202 }));
      await sending;
      const inputs = h.state.value.items.filter(function input(item) { return item.kind === "input_notice"; });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ turnId: "B", content: "用户原文\n@docs/a.md", state: "consumed" });
      expect(h.pending.value).toEqual([]);
    } finally { submit.unmount(); recovery.unmount(); }
  });

  it("queue 返回时已经切会话，finally不会清理新轮", async function ignoresOldQueue() {
    const h = inputHarness();
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(function wait() { return response.promise; }));
    const recovery = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const started = recovery.current.requestNextQueuedTurn();
      h.common.currentSessionIdRef.current = "other-session";
      h.common.setLoading.mockClear();
      response.resolve(new Response("data: end\n\n", { headers: { "X-Agent-Input-Id": "queue", "X-Agent-Turn-Id": "B" } }));
      await started;
      expect(h.common.setLoading).not.toHaveBeenCalled();
      expect(h.common.clearActiveTurn).not.toHaveBeenCalled();
      expect(h.common.consumeAgentStream).not.toHaveBeenCalled();
    } finally { recovery.unmount(); }
  });

  it("同会话旧输入失败回调不清新Turn，合法晚确认仍补原Turn正文", async function sameSessionNewTurn() {
    const h = inputHarness();
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      const failed = hook.current.handleSend();
      h.common.activeTurnRef.current = { sessionId: "session", turnId: "B" };
      first.resolve(Response.json({ code: "active_turn_finished" }, { status: 409 }));
      await failed;
      expect(h.common.clearActiveTurn).not.toHaveBeenCalled();
      expect(h.common.setLoading).not.toHaveBeenCalled();
      h.submission.inputRef.current = "合法晚确认原文";
      const confirmed = hook.current.handleSend();
      second.resolve(Response.json({ inputId: "late", delivery: "steer", status: "pending", turnId: "A" }, { status: 202 }));
      await confirmed;
      expect(h.state.value.items.find(function input(item) { return item.kind === "input_notice"; })).toMatchObject({ turnId: "A", content: "合法晚确认原文" });
    } finally { hook.unmount(); }
  });

  it("取消原Turn后晚确认保留取消正文且不恢复等待；History已有queue气泡不再补第二份", async function cancelledAndHistoryInput() {
    const h = inputHarness();
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      const sending = hook.current.handleSend();
      h.common.cancelledTurnIdsRef.current.add("A");
      first.resolve(Response.json({ inputId: "cancelled", delivery: "steer", status: "pending", turnId: "A" }, { status: 202 }));
      await sending;
      expect(h.state.value.items.find(function input(item) { return item.kind === "input_notice"; })).toMatchObject({ cancelled: true, content: "用户原文\n@docs/a.md" });
      expect(h.pending.value).toEqual([]);
      h.submission.inputRef.current = "History队列原文";
      hook.current.setInputDelivery("queue");
      await frame();
      const queued = hook.current.handleSend();
      h.common.historyInputIdsRef.current.add("history-queue");
      h.common.joinedInputIdsRef.current.add("history-queue");
      second.resolve(Response.json({ inputId: "history-queue", delivery: "queue", status: "consumed", turnId: "B" }, { status: 202 }));
      await queued;
      expect(h.state.value.items.some(function input(item) { return item.kind === "input_notice" && item.inputId === "history-queue"; })).toBe(false);
      expect(h.pending.value).toEqual([]);
    } finally { hook.unmount(); }
  });

  it("同会话queue旧流结束时不清新Turn", async function sameSessionQueueFinalization() {
    const h = inputHarness();
    const stream = deferred<"terminal">();
    h.common.consumeAgentStream.mockReturnValueOnce(stream.promise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("data: end\n\n", { headers: { "X-Agent-Input-Id": "queue", "X-Agent-Turn-Id": "B" } })));
    const recovery = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const started = recovery.current.requestNextQueuedTurn();
      await frame();
      h.common.activeTurnRef.current = { sessionId: "session", turnId: "C" };
      h.common.setLoading.mockClear();
      stream.resolve("terminal");
      await started;
      expect(h.common.clearActiveTurn).not.toHaveBeenCalled();
      expect(h.common.setLoading).not.toHaveBeenCalled();
    } finally { recovery.unmount(); }
  });
});

describe("H2 Turn 停止与继续", function h2RecoverySuite() {
  beforeEach(function globals() { vi.clearAllMocks(); vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
  afterEach(function restore() { vi.unstubAllGlobals(); });

  /** 停止在途时准备一条真实可继续的 Turn 消息与可用的 Session controller。 */
  function recoveryWithContinuableTurn() {
    const h = inputHarness();
    const messages: Message[] = [{ id: "assistant", role: "assistant", content: "", turnId: "A", canContinue: true }];
    h.messages.set(messages);
    h.recovery.messages = messages;
    h.submission.messages = messages;
    h.submission.loading = false;
    h.common.getSessionController.mockReturnValue({ createAbortController: function create() { return new AbortController(); } });
    return h;
  }

  it("停止在途时的继续动作给出明确提示且不抢跑", async function blocksContinueWhileStopping() {
    const h = recoveryWithContinuableTurn();
    h.common.cancelInFlightRef.current = Promise.resolve();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      await hook.current.handleContinueTurn("assistant");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(notice.warning).toHaveBeenCalledWith("任务正在停止，请等待服务端确认后再继续");
      expect(h.common.setLoading).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it("停止在途时的明确继续命令同样给出提示且不发送", async function blocksContinueCommandWhileStopping() {
    const h = recoveryWithContinuableTurn();
    h.submission.inputRef.current = "继续执行";
    h.common.cancelInFlightRef.current = Promise.resolve();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = mountHook(useConversationSubmission, h.submission);
    try {
      await hook.current.handleSend();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(notice.warning).toHaveBeenCalledWith("任务正在停止，请等待服务端确认后再发送");
    } finally { hook.unmount(); }
  });

  it("继续失败不乐观恢复可继续入口，仅保留结构化原因（P17 问题2）", async function keepsStructuredReasonWithoutOptimisticEntry() {
    const h = recoveryWithContinuableTurn();
    vi.stubGlobal("fetch", vi.fn(async function continueRoute() { return Response.json({ error: "TURN_NOT_RESUMABLE" }, { status: 409 }); }));
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      await hook.current.handleContinueTurn("assistant");
      await frame();
      const message = h.messages.value[0];
      expect(message.canContinue).toBe(false);
      expect(message.recoveryError).toContain("恢复失败");
      expect(message.recoveryError).toContain("TURN_NOT_RESUMABLE");
      expect(message.activity).toBeUndefined();
    } finally { hook.unmount(); }
  });

  it("点击继续立即隐藏旧继续入口与旧停止提示（P17 问题2）", async function hidesStaleRecoveryProjectionOnClaim() {
    const h = recoveryWithContinuableTurn();
    const seeded: Message[] = [{ id: "assistant", role: "assistant", content: "", turnId: "A", canContinue: true, termination: { reason: "turn_limit_reached", recoverable: true } }];
    h.messages.set(seeded);
    h.recovery.messages = seeded;
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(function wait() { return response.promise; }));
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const started = hook.current.handleContinueTurn("assistant");
      await frame();
      const message = h.messages.value[0];
      expect(message.canContinue).toBe(false);
      expect(message.termination).toBeUndefined();
      expect(message.activity).toBe("answer");
      response.resolve(new Response("data: end\n\n"));
      await started;
    } finally { hook.unmount(); }
  });

  it("继续在途时重复触发不再发送第二个请求（P17 问题2）", async function blocksDuplicateContinueWhileInFlight() {
    const h = recoveryWithContinuableTurn();
    const response = deferred<Response>();
    const fetchMock = vi.fn(function wait() { return response.promise; });
    vi.stubGlobal("fetch", fetchMock);
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const started = hook.current.handleContinueTurn("assistant");
      await frame();
      await hook.current.handleContinueTurn("assistant");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      response.resolve(new Response("data: end\n\n"));
      await started;
    } finally { hook.unmount(); }
  });

  it("完成终态清除上一段恢复留下的旧停止提示（P17 问题2）", async function completionClearsStaleTermination() {
    const presentation = createPresentationState();
    const agent = { turnId: "A", status: "interrupted_recoverable", recoverable: true, termination: { reason: "turn_limit_reached", recoverable: true } };
    vi.stubGlobal("fetch", vi.fn(async function history() {
      return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "interrupted" }, messages: [{ id: "assistant", role: "assistant", content: "部分结果", turnId: "A" }], presentation, agent });
    }));
    const options = { workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() };
    const hook = mountHook(useSessionConversation, options);
    try {
      await frame();
      const restored = hook.current.messages[0];
      expect(restored.canContinue).toBe(true);
      expect(restored.termination).toEqual({ reason: "turn_limit_reached", recoverable: true });
      const outcome = await hook.current.consumeAgentStream(new Response('data: {"type":"turn_completed","turnId":"A"}\n\n'), "assistant", "session");
      expect(outcome).toBe("terminal_seen");
      await frame();
      const cleared = hook.current.messages[0];
      expect(cleared.termination).toBeUndefined();
      expect(cleared.canContinue).toBe(false);
      expect(cleared.activity).toBeUndefined();
    } finally { hook.unmount(); }
  });

  it("旧继续请求的收尾不清理后来续接的执行段", async function ignoresStaleFinally() {
    const h = recoveryWithContinuableTurn();
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(function wait() { return response.promise; }));
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const started = hook.current.handleContinueTurn("assistant");
      await frame();
      h.common.setLoading.mockClear();
      h.common.clearActiveTurn.mockClear();
      h.common.executionEpochRef.current += 1;
      response.resolve(new Response("data: end\n\n"));
      await started;
      expect(h.common.setLoading).not.toHaveBeenCalled();
      expect(h.common.clearActiveTurn).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it("停止请求失败时重新同步权威状态并结束忙状态", async function resyncsAfterCancelFailure() {
    const h = recoveryWithContinuableTurn();
    h.common.activeTurnRef.current = { sessionId: "session", turnId: "A" };
    let rejectCancel!: (error: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(function cancelRoute() { return new Promise<Response>(function pending(_resolve, reject) { rejectCancel = reject; }); }));
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      const stopping = hook.current.cancelCurrentTurn();
      await frame();
      expect(hook.current.stopping).toBe(true);
      rejectCancel(new TypeError("network"));
      await stopping;
      await frame();
      expect(notice.error).toHaveBeenCalledWith("停止请求未收到确认，已重新同步任务状态");
      expect(h.common.loadHistory).toHaveBeenCalledWith("session");
      expect(hook.current.stopping).toBe(false);
    } finally { hook.unmount(); }
  });

  it("取消返回 409 且权威状态同步失败时撤销可继续资格", async function revokesWhenCancelUnconfirmed() {
    const h = recoveryWithContinuableTurn();
    h.common.activeTurnRef.current = { sessionId: "session", turnId: "A" };
    vi.stubGlobal("fetch", vi.fn(async function cancelRoute() { return Response.json({ error: "TURN_ALREADY_RUNNING" }, { status: 409 }); }));
    h.common.loadHistory.mockResolvedValueOnce(false);
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      await hook.current.cancelCurrentTurn();
      await frame();
      const message = h.messages.value.find((item) => item.turnId === "A");
      expect(message?.canContinue).toBe(false);
      expect(message?.recoveryError).toContain("停止请求未收到确认");
    } finally { hook.unmount(); }
  });

  it("继续失败且权威状态同步失败时不保留可继续承诺", async function revokesWhenContinueUnconfirmable() {
    const h = recoveryWithContinuableTurn();
    vi.stubGlobal("fetch", vi.fn(async function continueRoute() { return Response.json({ error: "TURN_NOT_RESUMABLE" }, { status: 409 }); }));
    h.common.loadHistory.mockResolvedValueOnce(false);
    const hook = mountHook(useTurnRecoveryActions, h.recovery);
    try {
      await hook.current.handleContinueTurn("assistant");
      await frame();
      const message = h.messages.value[0];
      expect(message.canContinue).toBe(false);
      expect(message.recoveryError).toContain("无法确认任务当前状态");
    } finally { hook.unmount(); }
  });

  it("服务端终态优先于旧活动快照，不把历史 Turn 恢复成运行中", async function terminalBeatsStaleProjection() {
    const presentation = { ...createPresentationState(), turnId: "A", activeOperation: { kind: "thinking" as const, id: "thinking" }, turnStartedAt: { A: new Date(1000).toISOString() } };
    vi.stubGlobal("fetch", vi.fn(async function history() { return Response.json({ meta: { id: "session", productMode: "work", runtimeStatus: "interrupted" }, messages: [], presentation }); }));
    const options = { workspaceId: "workspace", sessionId: "session", isChat: false, notifyNewProgress: vi.fn(), setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn() };
    const hook = mountHook(useSessionConversation, options);
    try {
      await frame();
      expect(hook.current.loading).toBe(false);
      expect(hook.current.activity).toBeUndefined();
      expect(hook.current.activeTurnId).toBe("");
    } finally { hook.unmount(); }
  });
});
