/** repair-02真实Hook→延迟HTTP→原Core/Route回归；隔离内存和fake sampler，不发Provider/文件批准。 */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { createPresentationState } from "@autopilot-agent/presentation";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";
import { POST as cancelRoute } from "@/app/api/sessions/[id]/cancel/route";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";

const contextMock = vi.hoisted(function context() { const items: never[] = []; return { manager: { subscribeList: function subscribe() { return function off() {}; }, getListSnapshot: function list() { return items; }, beginSession: vi.fn() }, refreshSessions: vi.fn() }; });
const notice = vi.hoisted(function notices() { return { error: vi.fn(), warning: vi.fn() }; });
vi.mock("@/app/chat/session-task-context", function context() { return { useSessionTaskContext: function read() { return contextMock; } }; });
vi.mock("@/app/chat/components/Notice", function noticeModule() { return { useNotice: function read() { return notice; } }; });

/** 正式Core和WebTurnHost创建真实write_file待审批，再等待原执行段完整收尾。 */
async function fixture() {
  const ports = createMemoryPorts(process.cwd());
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: { async sample() { return { content: "", reasoningSummary: "fixture", toolCalls: [{ id: "write-call", name: "write_file", input: { path: "repair-02-must-not-exist.txt", content: "fixture" } }], finishReason: "tool_calls" }; } } } });
  const session = await runtime.sessions.create({ title: "cancel-delivery" });
  const input = { sessionId: session.id, turnId: "waiting-turn" };
  const turnHost = createWebTurnHost({ runtime, ports });
  turnHost.start({ ...input, content: "write fixture" });
  expect(await turnHost.waitSettled(input.turnId)).toBe(true);
  expect((await runtime.turns.getRecoverableState(input))?.status).toBe("awaiting_approval");
  const context = { workspaceId: "workspace", workspaceRoot: process.cwd(), projectId: session.projectId, runtime, turnHost } as WebWorkspaceContext;
  let messages: any[] = [{ id: "assistant", role: "assistant", content: "已有过程", turnId: input.turnId }];
  const options = {
    isChat: false, workspaceId: "workspace", sessionId: session.id, canWrite: true, messages, loading: false, activeTurnId: input.turnId, streamingMessageId: "assistant", resumePendingSessionId: null,
    textareaRef: { current: null }, setMessages: function update(next: any) { messages = typeof next === "function" ? next(messages) : next; }, setLoading: vi.fn(), setActivity: vi.fn(), setPresentation: vi.fn(), setStreamingMessageId: vi.fn(), setActiveTurnId: vi.fn(), setPendingInputs: vi.fn(), setResumePendingSessionId: vi.fn(),
    loadHistory: vi.fn(async function history() { const state = await runtime.turns.getRecoverableState(input); messages = messages.map(function authoritative(message) { return { ...message, canContinue: state?.status === "interrupted_recoverable" }; }); return true; }), consumeAgentStream: vi.fn(), getSessionController: vi.fn(), setTransportState: vi.fn(), clearActiveTurn: vi.fn(), markAwaitingUserInput: vi.fn(),
    activeTurnRef: { current: input }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, cancelInFlightRef: { current: null }, requestAbortRef: { current: null }, transportDisconnectedRef: { current: false }, awaitingApprovalRef: { current: true }, awaitingUserInputRef: { current: false }, executionEpochRef: { current: 0 }, pendingInputsRef: { current: [] }, currentSessionIdRef: { current: session.id }, currentWorkspaceIdRef: { current: "workspace" },
  } as unknown as Parameters<typeof useTurnRecoveryActions>[0];
  return { ports, runtime, input, context, options, messages: function read() { return messages; } };
}

/** 用真实React Hook，仅捕获10秒提示timer，免实际等待或冷编译。 */
function mount(options: Parameters<typeof useTurnRecoveryActions>[0]) {
  let current!: ReturnType<typeof useTurnRecoveryActions>;
  let deadline!: () => void;
  vi.stubGlobal("window", { setTimeout: function timer(callback: () => void) { deadline = callback; return 1; }, clearTimeout: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  function Probe() { current = useTurnRecoveryActions(options); return null; }
  const view = render(createElement(Probe));
  return { get current() { return current; }, expire: function expire() { deadline(); }, unmount: view.unmount };
}

afterEach(function cleanup() { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("repair-02 cancel delivery", function suite() {
  it("超过10秒的取消仍送达真实Route，未确认不授予恢复/审批，最终权威中断", async function delayedDelivery() {
    const f = await fixture();
    let deliver!: () => Promise<void>;
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(function fetchDelayed(_url: string, init?: RequestInit) {
      signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(function pending(resolve, reject) {
        signal?.addEventListener("abort", function aborted() { reject(new DOMException("aborted", "AbortError")); });
        deliver = async function deliverCommand() { const response = await runWithWorkspaceRequestContext(f.context, function invoke() { return cancelRoute(new Request("http://localhost/api/sessions/fixture/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: init?.body }), { params: Promise.resolve({ id: f.input.sessionId }) }); }); resolve(response); };
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const hook = mount(f.options);
    try {
      const stopping = hook.current.cancelCurrentTurn();
      f.options.cancelInFlightRef.current?.catch(function ignore() {});
      hook.expire();
      expect(signal?.aborted ?? false).toBe(false);
      expect(f.messages()[0].canContinue).toBe(false);
      expect(f.messages()[0].content).toBe("已有过程");
      await hook.current.handleApproval("assistant", { kind: "approval", turnId: f.input.turnId, approvalId: "old", state: "required", id: "old", callId: "write-call", toolName: "write_file" }, "allow_once");
      expect(fetcher).toHaveBeenCalledTimes(1);
      await deliver();
      await stopping;
      expect((await f.runtime.turns.getRecoverableState(f.input))?.status).toBe("interrupted_recoverable");
      expect((await f.runtime.turns.getRecoverableState(f.input))?.approval).toBeUndefined();
      expect(f.messages()[0].canContinue).toBe(true);
      expect(f.options.cancelInFlightRef.current).toBeNull();
    } finally { hook.unmount(); }
  });

  it("响应丢失但History已确认中断时保留权威恢复资格", async function lostResponse() {
    const f = await fixture();
    vi.stubGlobal("fetch", vi.fn(async function sentButLost(_url: string, init?: RequestInit) {
      await runWithWorkspaceRequestContext(f.context, function invoke() { return cancelRoute(new Request("http://localhost/api/sessions/fixture/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: init?.body }), { params: Promise.resolve({ id: f.input.sessionId }) }); });
      throw new TypeError("response lost");
    }));
    const hook = mount(f.options);
    try {
      await hook.current.cancelCurrentTurn();
      expect((await f.runtime.turns.getRecoverableState(f.input))?.status).toBe("interrupted_recoverable");
      expect(f.messages()[0].canContinue).toBe(true);
      expect(f.options.cancelInFlightRef.current).toBeNull();
    } finally { hook.unmount(); }
  });

  it("恢复请求失败经History替换容器后仍显示可操作提示", async function continueFailureVisible() {
    const f = await fixture();
    f.options.getSessionController = function controller() { return { createAbortController: function create() { return new AbortController(); } } as any; };
    f.options.loadHistory = vi.fn(async function replaceHistory() { f.options.setMessages([{ id: "restored-container", role: "assistant", content: "已有过程", turnId: f.input.turnId, canContinue: true }]); return true; });
    vi.stubGlobal("fetch", vi.fn(async function refused() { return Response.json({ error: "需要处理审批" }, { status: 400 }); }));
    const hook = mount(f.options);
    try {
      await hook.current.handleContinueTurn("assistant");
      expect(f.messages()[0].id).toBe("restored-container");
      expect(f.messages()[0].canContinue).toBe(true);
      expect(f.messages()[0].recoveryError).toContain("恢复请求未成功");
    } finally { hook.unmount(); }
  });

  it("失败取消校准后释放单次锁，明确未确认并可对同一目标再次请求", async function failedDelivery() {
    const f = await fixture();
    vi.stubGlobal("fetch", vi.fn(async function fail() { throw new TypeError("network"); }));
    const hook = mount(f.options);
    try {
      await hook.current.cancelCurrentTurn();
      expect(f.options.loadHistory).toHaveBeenCalledWith(f.input.sessionId);
      expect(f.options.cancelInFlightRef.current).toBeNull();
      expect(f.messages()[0].canContinue).toBe(false);
      expect(f.messages()[0].content).toBe("已有过程");
      expect(f.messages()[0].recoveryError).toContain("停止");
    } finally { hook.unmount(); }
  });
});
