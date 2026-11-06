/** W2：真实Provider与组目录Hook验证创建事件的自举、去重和workspace隔离，不连接服务。 */
import { createElement, useEffect } from "react";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { SessionTaskProvider, useSessionTaskContext } from "@/app/chat/session-task-context";
import { useThreadGroups } from "@/app/chat/hooks/useThreadGroups";
import { useSessionConversation } from "@/app/chat/hooks/useSessionConversation";
import { useTurnRecoveryActions } from "@/app/chat/hooks/useTurnRecoveryActions";
import { createPresentationState } from "@autopilot-agent/presentation";

vi.mock("@/app/chat/components/Notice", function mockNotice() { return { useNotice: function notice() { return { error: vi.fn(), warning: vi.fn(), success: vi.fn() }; } }; });

/** 恢复本文件安装的浏览器/HTTP替身。 */
afterEach(function restore() { vi.unstubAllGlobals(); });

/** 无组父会话从安全成功身份得知目录失效；重复事件不重复刷新，也不切换会话。 */
it("W2 无组A创建B、B创建C实时校准且重复/其他workspace隔离", async function discoversCreatedThreads() {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: "visible" });
  let members = ["A"];
  const fetcher = vi.fn(async function respond(input: unknown) {
    const url = String(input);
    if (url === "/api/workspaces/ws/threads/groups") return Response.json({ items: members.length === 1 ? [] : [{ groupId: "group", rootThreadId: "A", enabled: true, createdAt: 1, allowedTools: [], members: members.map(function member(threadId) { return { threadId, parentThreadId: threadId === "A" ? null : "A", createdAt: 1 }; }) }] });
    return Response.json({ sessions: members.map(function session(id) { return { id, title: id, createdAt: 1, updatedAt: 1, status: "active", runtimeStatus: "idle" }; }) });
  });
  vi.stubGlobal("fetch", fetcher);
  let context!: ReturnType<typeof useSessionTaskContext>;
  let groups!: ReturnType<typeof useThreadGroups>;
  function Probe() {
    context = useSessionTaskContext();
    groups = useThreadGroups({ workspaceId: "ws", enabled: true, refreshKey: String(context.threadDirectoryRevisions.ws ?? 0) });
    return null;
  }
  const view = render(createElement(SessionTaskProvider, null, createElement(Probe)));
  try {
    await vi.waitFor(function noGroup() { expect(fetcher).toHaveBeenCalled(); expect(groups.groups).toEqual([]); });
    context.manager.selectSession(null);
    fetcher.mockClear();
    members = ["A", "B"];
    context.invalidateThreadDirectory("ws", "A", "turn-A", 8);
    context.invalidateThreadDirectory("ws", "A", "turn-A", 8);
    await vi.waitFor(function foundB() { expect(groups.membershipByThread.has("B")).toBe(true); });
    expect(fetcher.mock.calls.filter(function scoped(call) { return String(call[0]) === "/api/workspaces/ws/sessions"; })).toHaveLength(1);
    expect(context.manager.getListSnapshot().filter(function scoped(item) { return item.workspaceId === "ws"; })).toHaveLength(2);
    members = ["A", "B", "C"];
    context.invalidateThreadDirectory("ws", "B", "turn-B", 9);
    await vi.waitFor(function foundC() { expect(groups.membershipByThread.has("C")).toBe(true); });
    const revision = context.threadDirectoryRevisions.ws;
    fetcher.mockClear();
    context.invalidateThreadDirectory("other", "A", "turn-A", 8);
    await vi.waitFor(function otherRefreshed() { expect(context.threadDirectoryRevisions.other).toBe(1); });
    expect(context.threadDirectoryRevisions.ws).toBe(revision);
    expect(fetcher.mock.calls.every(function otherOnly(call) { return String(call[0]).startsWith("/api/workspaces/other/"); })).toBe(true);
  } finally { view.unmount(); }
});

/** 冷组503→sessions首次可读→归属/SSE恢复→短任务终态进入实际History Hook，全程不手动刷新manager。 */
it("R2 组发现冷503后恢复订阅并同步短Turn终态结果", async function recoversColdGroupObservation() {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: "visible" });
  const sources: TestEventSource[] = [];
  /** 仅替换网络EventSource，消息由实际Provider的page监听与去抖处理。 */
  class TestEventSource extends EventTarget {
    readonly close = vi.fn();
    constructor(readonly url: string) { super(); sources.push(this); }
  }
  vi.stubGlobal("EventSource", TestEventSource);
  let ready = false;
  let revision = 1;
  let finishReady!: (response: Response) => void;
  const initialSessions = new Promise<Response>(function waitForHost(resolve) { finishReady = resolve; });
  /** 模拟安全目录的持久完成版本，队列没有出现过running且Inbox为空。 */
  function sessions() { return [{ id: "B", title: "B", createdAt: 1, updatedAt: revision, status: "active", runtimeStatus: "completed", productMode: "work" }]; }
  const fetcher = vi.fn(async function response(input: unknown, options?: RequestInit) {
    expect(options?.method ?? "GET").toBe("GET");
    const url = String(input);
    if (url === "/api/chat/sessions") return Response.json({ sessions: [] });
    if (url === "/api/workspaces/ws/threads/groups") return ready
      ? Response.json({ items: [{ groupId: "group", rootThreadId: "B", enabled: true, createdAt: 1, allowedTools: [], members: [{ threadId: "B", parentThreadId: null, createdAt: 1 }] }] })
      : Response.json({ code: "THREADS_UNAVAILABLE" }, { status: 503 });
    if (url === "/api/workspaces/ws/sessions") return ready ? Response.json({ sessions: sessions() }) : initialSessions;
    if (url === "/api/workspaces/ws/sessions/B") return Response.json({
      meta: sessions()[0], presentation: createPresentationState(), pendingInputs: [], canAutoStartNext: false,
      messages: revision === 1 ? [] : [{ id: "queue-prompt", role: "user", content: "短队列任务", turnId: "short", createdAt: 2 }, { id: "queue-result", role: "assistant", content: "R2-SHORT-DONE", turnId: "short", createdAt: 3 }],
    });
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  let groups!: ReturnType<typeof useThreadGroups>;
  let context!: ReturnType<typeof useSessionTaskContext>;
  let conversation!: ReturnType<typeof useSessionConversation>;
  const notify = vi.fn(), selected = vi.fn(), pinned = vi.fn();
  /** 复用Sidebar同形组归属订阅和真实History/外部Turn观察，不直接注入manager版本。 */
  function Probe() {
    context = useSessionTaskContext();
    groups = useThreadGroups({ workspaceId: "ws", enabled: true, refreshKey: `${context.threadGroupRevision}:${context.threadDirectoryRevisions.ws ?? 0}` });
    const groupId = groups.membershipByThread.get("B")?.groupId ?? null;
    useEffect(function watchGroup() { context.observeThreadGroup("ws", groupId); }, [groupId, context.observeThreadGroup]);
    useEffect(function readWorkspaceSessions() { void context.refreshSessions("ws"); }, [context.refreshSessions]);
    conversation = useSessionConversation({ workspaceId: "ws", sessionId: "B", active: true, isChat: false, notifyNewProgress: notify, setSelectedSkills: selected, setPinnedSkills: pinned });
    useTurnRecoveryActions({ ...conversation, workspaceId: "ws", sessionId: "B", isChat: false, canWrite: conversation.historyReady, textareaRef: { current: null } });
    return null;
  }
  const view = render(createElement(SessionTaskProvider, null, createElement(Probe)));
  try {
    await vi.waitFor(function firstColdFailure() { expect(groups.error).toBe("无法读取协作归属"); });
    expect(sources).toHaveLength(0);
    ready = true;
    finishReady(Response.json({ sessions: sessions() }));
    await vi.waitFor(function subscribed() { expect(groups.error).toBeUndefined(); expect(sources).toHaveLength(1); });
    expect(sources[0].url).toBe("/api/workspaces/ws/threads/groups/group/events");
    const directoryRevision = context.threadDirectoryRevisions.ws;
    await context.refreshSessions("ws");
    expect(context.threadDirectoryRevisions.ws).toBe(directoryRevision);
    revision = 2;
    sources[0].dispatchEvent(new MessageEvent("page", { data: JSON.stringify({ items: [{ kind: "turn_terminal", threadId: "B", turnId: "short" }] }) }));
    await vi.waitFor(function resultVisible() { expect(conversation.messages.map(function text(message) { return message.content; })).toEqual(["短队列任务", "R2-SHORT-DONE"]); });
    expect(context.manager.getListSnapshot()[0].session.updatedAt).toBe(2);
    expect(conversation.resumePendingSessionId).toBeNull();
    expect(sources).toHaveLength(1);
  } finally { view.unmount(); }
  expect(sources[0].close).toHaveBeenCalledOnce();
});

/** 仅临时5xx在预算耗尽后等待online重新恢复；成功后没有周期读取。 */
it("R2 组发现5xx有限三次，online恢复后停止重试", async function boundsRetriesAndRecoversOnline() {
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  let ready = false;
  const fetcher = vi.fn(async function response() { return ready ? Response.json({ items: [] }) : Response.json({ code: "THREADS_UNAVAILABLE" }, { status: 503 }); });
  vi.stubGlobal("fetch", fetcher);
  let groups!: ReturnType<typeof useThreadGroups>;
  function Probe() { groups = useThreadGroups({ workspaceId: "ws", enabled: true }); return null; }
  const view = render(createElement(Probe));
  try {
    await vi.waitFor(function exhausted() { expect(fetcher).toHaveBeenCalledTimes(3); }, { timeout: 2_500 });
    await new Promise<void>(function noMoreAutomaticRetries(resolve) { setTimeout(resolve, 550); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    ready = true;
    browser.dispatchEvent(new Event("online"));
    await vi.waitFor(function recovered() { expect(groups.error).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(4); });
    await new Promise<void>(function noPollingAfterSuccess(resolve) { setTimeout(resolve, 550); });
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { view.unmount(); }
  browser.dispatchEvent(new Event("online"));
  expect(fetcher).toHaveBeenCalledTimes(4);
});

/** 鉴权/参数或格式失败保持终止，不因online放宽安全边界或不断重试。 */
it.each(["forbidden", "malformed"] as const)("R2 组发现%s错误不自动或online重试", async function rejectsPermanentReadFailure(kind) {
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  const fetcher = vi.fn(async function response() { return kind === "forbidden" ? new Response("{}", { status: 403 }) : Response.json({ items: "invalid" }); });
  vi.stubGlobal("fetch", fetcher);
  let groups!: ReturnType<typeof useThreadGroups>;
  function Probe() { groups = useThreadGroups({ workspaceId: "ws", enabled: true }); return null; }
  const view = render(createElement(Probe));
  try {
    await vi.waitFor(function failed() { expect(groups.error).toBe("无法读取协作归属"); });
    browser.dispatchEvent(new Event("online"));
    await new Promise<void>(function noRetry(resolve) { setTimeout(resolve, 550); });
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { view.unmount(); }
});

/** workspace切换与卸载中断旧请求；迟到旧响应不进入新归属，online监听同步释放。 */
it("R2 组发现切workspace丢弃旧响应并清理请求和online监听", async function cancelsStaleWorkspaceRead() {
  const browser = new EventTarget();
  const remove = vi.spyOn(browser, "removeEventListener");
  vi.stubGlobal("window", browser);
  let finishOld!: (response: Response) => void;
  let oldSignal: AbortSignal | undefined;
  const old = new Promise<Response>(function pending(resolve) { finishOld = resolve; });
  vi.stubGlobal("fetch", vi.fn(function response(input: unknown, options?: RequestInit) {
    if (String(input).includes("/old/")) { oldSignal = options?.signal ?? undefined; return old; }
    return Promise.resolve(Response.json({ items: [] }));
  }));
  let groups!: ReturnType<typeof useThreadGroups>;
  function Probe(props: { workspaceId: string }) { groups = useThreadGroups({ workspaceId: props.workspaceId, enabled: true }); return null; }
  const view = render(createElement(Probe, { workspaceId: "old" }));
  try {
    await vi.waitFor(function requested() { expect(oldSignal).toBeDefined(); });
    view.rerender(createElement(Probe, { workspaceId: "new" }));
    await vi.waitFor(function cancelled() { expect(oldSignal?.aborted).toBe(true); });
    finishOld(Response.json({ items: [{ groupId: "old-group", members: [] }] }));
    await new Promise<void>(function lateResponse(resolve) { setTimeout(resolve, 25); });
    expect(groups.groups).toEqual([]);
    expect(groups.error).toBeUndefined();
  } finally { view.unmount(); remove.mockRestore(); }
});
