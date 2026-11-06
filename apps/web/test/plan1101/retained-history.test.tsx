/** W2/W3/W4：真实React Hook校准与只读观察，HTTP和通知受控，不启动Runtime。 */
import { createElement, useRef, useState } from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPresentationState } from "@autopilot-agent/presentation";
import { useSessionConversation } from "@/app/chat/hooks/useSessionConversation";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";
import { createSessionTaskManager, createWorkspaceSessionKey } from "@/app/chat/session-task-store";
import { getTurnPresentationMessageIds, mergeHistoryIntoChatMessages, type RealtimeChatMessage } from "@/app/chat/chat-message-state";

const context = vi.hoisted(function mocks() { return { manager: null as unknown as ReturnType<typeof createSessionTaskManager>, refreshSessions: vi.fn(), invalidateThreadDirectory: vi.fn() }; });
vi.mock("@/app/chat/session-task-context", function mockContext() { return { useSessionTaskContext: function read() { return context; } }; });
vi.mock("@/app/chat/components/Notice", function mockNotice() { return { useNotice: function notice() { return { warning: vi.fn(), error: vi.fn(), success: vi.fn() }; } }; });

/** 只装浏览器计时/事件表面，不模拟React生命周期或Hook业务。 */
beforeEach(function globals() {
  vi.clearAllMocks();
  context.manager = createSessionTaskManager();
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(function restore() { vi.unstubAllGlobals(); });

/** 安全History载体；保留queue条件验证只读激活不武装resume。 */
function history(id: string, turnId = "old", status = "completed") {
  return { meta: { id, productMode: "work", title: id, runtimeStatus: status, activeTurnId: status === "running" ? turnId : undefined },
    messages: [{ id: `message-${turnId}`, role: "assistant", turnId, content: turnId, createdAt: 1 }],
    presentation: { ...createPresentationState(), turnId, ...(status === "running" ? { activeOperation: { kind: "thinking", id: "thinking" } } : {}) },
    canAutoStartNext: true, pendingInputs: [{ inputId: "queue", delivery: "queue", status: "pending", content: "后续" }],
    ...(status === "waiting_approval" ? { agent: { turnId, status: "awaiting_approval", recoverable: true } } : {}),
  };
}

/** 同时挂载实际History与恢复观察Hook，保留本地草稿/光标状态作为保活证据。 */
function mount(sessionId = "B", withRecovery = true, initialActive = false) {
  let current!: ReturnType<typeof useSessionConversation>;
  let draft!: string;
  let setDraft!: (text: string) => void;
  let cursor!: { current: number };
  const notifyNewProgress = vi.fn();
  const selected = vi.fn(), pinned = vi.fn();
  function Probe(props: { sessionId: string; active: boolean }) {
    [draft, setDraft] = useState("");
    cursor = useRef(0);
    current = useSessionConversation({ workspaceId: "ws", sessionId: props.sessionId, active: props.active, isChat: false, notifyNewProgress, setSelectedSkills: selected, setPinnedSkills: pinned });
    const recovery = { ...current, isChat: false, workspaceId: "ws", sessionId: props.sessionId, canWrite: withRecovery && current.historyReady, textareaRef: { current: null } };
    useTurnRecoveryActions(recovery);
    return null;
  }
  const view = render(createElement(Probe, { sessionId, active: initialActive }));
  return { get current() { return current; }, get draft() { return draft; }, get cursor() { return cursor; }, setDraft: function update(text: string) { setDraft(text); }, rerender: function rerender(id: string, active: boolean) { view.rerender(createElement(Probe, { sessionId: id, active })); }, unmount: view.unmount };
}

/** Hook只转发安全成功四元身份；重复通知的目录副作用由真实Provider用例验证去重。 */
it("W2 Hook只用安全create_thread成功身份触发目录失效", async function forwardsSafeCreateEvent() {
  vi.stubGlobal("fetch", vi.fn(async function response() { return Response.json(history("B")); }));
  const hook = mount("B", false);
  try {
    await vi.waitFor(function loaded() { expect(hook.current.historyReady).toBe(true); });
    const ignoredEvents = [
      { type: "tool_result", turnId: "new", seq: 2, toolName: "create_thread", result: { status: "error" } },
      { type: "tool_result", turnId: "new", seq: 3, toolName: "read_file", result: { status: "success", output: { text: "create_thread success只是正文" } } },
    ];
    await hook.current.consumeAgentStream(new Response(ignoredEvents.map(function frame(event) { return `data: ${JSON.stringify(event)}\n\n`; }).join("") + "data: [DONE]\n\n"), "container", "B");
    expect(context.invalidateThreadDirectory).not.toHaveBeenCalled();
    const success = { type: "tool_result", turnId: "new", seq: 4, toolName: "create_thread", result: { status: "success", output: { marker: "raw-channel-marker", workspaceId: "forged-workspace", sessionId: "forged-session", turnId: "forged-turn", seq: 999 } } };
    // 重复成功事件可原样通知Provider；此处不mock出一套目录去重实现或断言副作用次数。
    await hook.current.consumeAgentStream(new Response([success, success].map(function frame(event) { return `data: ${JSON.stringify(event)}\n\n`; }).join("") + "data: [DONE]\n\n"), "container", "B");
    expect(context.invalidateThreadDirectory.mock.calls.length).toBeGreaterThan(0);
    for (const args of context.invalidateThreadDirectory.mock.calls) expect(args).toEqual(["ws", "B", "new", 4]);
    expect(JSON.stringify(context.invalidateThreadDirectory.mock.calls)).not.toMatch(/raw-channel-marker|forged-workspace|forged-session|forged-turn/);
  } finally { hook.unmount(); }
});

/** 真实分段始终保留；只淘汰明确synthetic，且每Turn只选一个共享Presentation容器。 */
it("W3 synthetic与迟到History合并不丢真实分段且展示唯一", function mergesContainers() {
  const synthetic: RealtimeChatMessage = { id: "agent-turn-T", role: "assistant", turnId: "T", content: "", optimistic: true };
  const real: RealtimeChatMessage[] = [{ id: "one", role: "assistant", turnId: "T", content: "前段", createdAt: 1 }, { id: "two", role: "assistant", turnId: "T", content: "后段", createdAt: 2 }];
  const waiting = mergeHistoryIntoChatMessages([synthetic], [synthetic, ...real]);
  expect(waiting).toEqual(real);
  expect([...getTurnPresentationMessageIds(waiting)]).toEqual(["one"]);
  expect(mergeHistoryIntoChatMessages(waiting, [synthetic])).toEqual(real);
  expect(mergeHistoryIntoChatMessages(waiting, real)).toEqual(real);
});

/** 隐藏B保活→目录新Turn→激活，使用既有只读stream看到审批；A继续运行，不发任何执行请求。 */
it("W4 保活激活校准外部Turn和审批且只读，不改草稿光标或A", async function observesRetainedSession() {
  const session = function dto(id: string, runtimeStatus: "running" | "completed", activeTurnId?: string) { return { id, title: id, productMode: "work" as const, createdAt: 1, updatedAt: 1, status: "active" as const, runtimeStatus, activeTurnId }; };
  context.manager.syncWorkspaceSessions("ws", [session("A", "running", "turn-A"), session("B", "completed")]);
  let payload = history("B");
  const fetcher = vi.fn(async function response(input: unknown, options?: RequestInit) {
    expect(options?.method ?? "GET").toBe("GET");
    if (String(input).includes("/stream?")) {
      payload = history("B", "external", "waiting_approval");
      return new Response('data: {"type":"approval_required","turnId":"external","seq":3,"toolName":"run_command","callId":"call","result":{"status":"approval_required","approval":{"approvalId":"approval-external","toolName":"run_command","reason":"确认","risk":"write"}}}\n\ndata: [DONE]\n\n');
    }
    return Response.json(payload);
  });
  vi.stubGlobal("fetch", fetcher);
  const hook = mount();
  try {
    await vi.waitFor(function loaded() { expect(hook.current.historyReady).toBe(true); });
    hook.setDraft("保留草稿"); hook.cursor.current = 3;
    payload = history("B", "external", "running");
    hook.rerender("B", true);
    await vi.waitFor(function observed() { expect(hook.current.activeTurnId).toBe("external"); expect(hook.current.awaitingApprovalRef.current).toBe(true); });
    expect(hook.current.messages.some(function external(message) { return message.turnId === "external"; })).toBe(true);
    expect(hook.current.resumePendingSessionId).toBeNull();
    expect(hook.draft).toBe("保留草稿"); expect(hook.cursor.current).toBe(3);
    expect(context.manager.getSessionSnapshot(createWorkspaceSessionKey("ws", "A"))?.phase).toBe("running");
    expect(fetcher.mock.calls.filter(function stream(call) { return String(call[0]).includes("/stream?"); })).toHaveLength(1);
    expect(fetcher.mock.calls.every(function target(call) { return String(call[0]).includes("/sessions/B"); })).toBe(true);
  } finally { hook.unmount(); }
});

/** 持续可见B没有见过running且Inbox为空；终态版本校准一次，本地执行忙时延后而不丢版本。 */
it.each([false, true])("W4 短外部Turn仅终态目录也补结果，本地执行待补=%s", async function observesCompletedShortTurn(localExecution) {
  /** 只改变B的持久更新时间；A与其他workspace保持独立。 */
  function directory(updatedAt: number) {
    return [{ id: "A", title: "A", productMode: "work" as const, createdAt: 1, updatedAt: 1, status: "active" as const, runtimeStatus: "running" as const, activeTurnId: "turn-A" },
      { id: "B", title: "B", productMode: "work" as const, createdAt: 1, updatedAt, status: "active" as const, runtimeStatus: "completed" as const }];
  }
  context.manager.syncWorkspaceSessions("ws", directory(1));
  let payload = { ...history("B"), pendingInputs: [] };
  const fetcher = vi.fn(async function response(input: unknown, options?: RequestInit) {
    expect(options?.method ?? "GET").toBe("GET");
    expect(String(input)).toBe("/api/workspaces/ws/sessions/B");
    return Response.json(payload);
  });
  vi.stubGlobal("fetch", fetcher);
  const hook = mount("B", true, true);
  try {
    await vi.waitFor(function loaded() { expect(hook.current.historyReady).toBe(true); });
    await new Promise<void>(function baselineFrame(resolve) { setTimeout(resolve, 25); });
    hook.setDraft("短任务期间草稿"); hook.cursor.current = 4;
    if (localExecution) {
      hook.current.requestAbortRef.current = new AbortController();
      hook.current.setLoading(true);
      await new Promise<void>(function executionFrame(resolve) { setTimeout(resolve, 25); });
    }
    fetcher.mockClear();
    payload = { ...history("B", "short-completed"), pendingInputs: [], messages: [
      { id: "short-prompt", role: "user", turnId: "short-completed", content: "短队列任务", createdAt: 2 },
      { id: "short-result", role: "assistant", turnId: "short-completed", content: "SHORT-QUEUE-DONE", createdAt: 3 },
    ] };
    context.manager.syncWorkspaceSessions("ws", directory(2));
    if (localExecution) {
      await new Promise<void>(function busyFrame(resolve) { setTimeout(resolve, 25); });
      expect(fetcher).not.toHaveBeenCalled();
      expect(hook.current.messages.some(function premature(message) { return message.id === "short-result"; })).toBe(false);
      hook.current.requestAbortRef.current = null;
      hook.current.setLoading(false);
    }
    await vi.waitFor(function resultVisible() { expect(hook.current.messages.map(function content(message) { return message.content; })).toEqual(["短队列任务", "SHORT-QUEUE-DONE"]); });
    expect(fetcher).toHaveBeenCalledOnce();
    context.manager.syncWorkspaceSessions("ws", directory(2));
    context.manager.syncWorkspaceSessions("other", directory(999));
    await new Promise<void>(function duplicateFrame(resolve) { setTimeout(resolve, 25); });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(hook.current.resumePendingSessionId).toBeNull();
    expect(hook.draft).toBe("短任务期间草稿"); expect(hook.cursor.current).toBe(4);
    expect(context.manager.getSessionSnapshot(createWorkspaceSessionKey("ws", "A"))?.activeTurnId).toBe("turn-A");
  } finally { hook.current.requestAbortRef.current = null; hook.unmount(); }
});

/** 旧history响应不能覆盖后续精确目标，沿原代次及Session身份保护。 */
it("W4 旧History迟到不覆盖新目标", async function ignoresLateHistory() {
  let finish!: (response: Response) => void;
  const old = new Promise<Response>(function wait(resolve) { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(function response(input: unknown) { return String(input).endsWith("/B") ? old : Promise.resolve(Response.json(history("C", "turn-C"))); }));
  const hook = mount("B", false);
  try {
    hook.rerender("C", true);
    await vi.waitFor(function current() { expect(hook.current.sessionMeta?.id).toBe("C"); });
    finish(Response.json(history("B", "old-B")));
    await new Promise<void>(function frame(resolve) { setTimeout(resolve, 25); });
    expect(hook.current.sessionMeta?.id).toBe("C");
    expect(hook.current.messages.some(function oldMessage(message) { return message.turnId === "old-B"; })).toBe(false);
  } finally { hook.unmount(); }
});
