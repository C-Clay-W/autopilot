/** 协作 Route 契约：受信归属、DTO 校验、202 接受语义、hostOffline 与固定错误映射。 */
import { GET as readTasks } from "@/app/api/workspaces/[workspaceId]/threads/groups/[groupId]/tasks/route";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebWorkspaceHost, WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import { POST as enableGroup, GET as readGroups } from "@/app/api/workspaces/[workspaceId]/threads/groups/route";
import { PATCH as setGroupEnabled } from "@/app/api/workspaces/[workspaceId]/threads/groups/[groupId]/route";
import { GET as readState, PATCH as updateState } from "@/app/api/workspaces/[workspaceId]/threads/groups/[groupId]/state/route";
import { GET as readGroupEvents } from "@/app/api/workspaces/[workspaceId]/threads/groups/[groupId]/events/route";
import { GET as readMessages, POST as sendMessage } from "@/app/api/workspaces/[workspaceId]/threads/[threadId]/messages/route";
import { GET as readMessageStatus } from "@/app/api/workspaces/[workspaceId]/threads/[threadId]/messages/[messageId]/route";
import { GET as readThread } from "@/app/api/workspaces/[workspaceId]/threads/[threadId]/route";
import { POST as interruptThread } from "@/app/api/workspaces/[workspaceId]/threads/[threadId]/interrupt/route";
import { POST as waitThreads } from "@/app/api/workspaces/[workspaceId]/threads/wait/route";
import { GET as readCapabilities } from "@/app/api/workspaces/[workspaceId]/threads/capabilities/route";

/** 伪造的协议入口：只记录调用并返回固定形状，用于验证 Route 的 DTO 与状态码。 */
function createFakeFacade() {
  const calls: Array<{ method: string; input: unknown }> = [];
  /** 生成记录型方法；`throwCode` 用于模拟 Core 稳定错误。 */
  function method(name: string, result: unknown = { ok: true }) {
    return vi.fn(async function invoke(input: unknown) {
      calls.push({ method: name, input });
      return { protocolVersion: 1, ...(result as Record<string, unknown>) };
    });
  }
  const facade = {
    enable: method("enable", { group: { groupId: "group-1", enabled: true } }),
    disable: method("disable", { groupId: "group-1", enabled: false }),
    groups: method("groups", { items: [] }),
    groupOf: method("groupOf", { group: null }),
    create: method("create", { threadId: "thread-1", groupId: "group-1", parentThreadId: "thread-1" }),
    list: method("list", { items: [] }),
    read: method("read", { thread: { threadId: "thread-1" } }),
    send: method("send", { messageId: "message-1", deliverySeq: 1, deliveryStatus: "pending", hostOffline: true }),
    messageStatus: method("messageStatus", { deliveryStatus: "pending" }),
    interrupt: method("interrupt", { accepted: true, controlId: "control-1", hostOffline: false }),
    tasks: method("tasks", { items: [] }),
    wait: method("wait", { results: [], timedOut: false }),
    messages: method("messages", { items: [] }),
    readState: method("readState", { value: {}, revision: 0 }),
    updateState: method("updateState", { revision: 1 }),
    events: method("events", { items: [] }),
    capabilities: method("capabilities", { operations: [] }),
  };
  return { facade, calls };
}

/** 构造 Workspace Context；Runtime 只在会话子 Route 使用，本轮不触达。 */
function createContext(threadHost?: WebWorkspaceContext["threadHost"]): WebWorkspaceContext {
  return {
    workspaceId: "ws",
    workspaceRoot: "/tmp/ws",
    runtime: {} as WebWorkspaceContext["runtime"],
    projectId: "project-1",
    compositionRoot: {} as WebWorkspaceContext["compositionRoot"],
    ...(threadHost ? { threadHost } : {}),
  };
}

/** 注入工作区 Host 与协作宿主；每个用例结束时复位，避免影响其他测试。 */
function installHost(input: { withThreadHost?: boolean } = {}) {
  const ensureStarted = vi.fn();
  const kick = vi.fn();
  const host = {
    workspaceId: "ws",
    stateRootId: "root-1",
    facade: () => createFakeFacadeCurrent.facade,
    ensureStarted,
    kick,
    isRunning: () => true,
    stop: vi.fn(async () => undefined),
  };
  const context = createContext(input.withThreadHost === false ? undefined : host as unknown as WebWorkspaceContext["threadHost"]);
  setWebWorkspaceHostForTest({
    getContext: async () => context,
    listWorkspaces: async () => [],
    isDirectorySelectionAvailable: () => false,
    beginDirectorySelection: async () => undefined,
    inspectSelection: async () => { throw new Error("unused"); },
    submitTrust: async () => { throw new Error("unused"); },
    removeWorkspace: async () => false,
  } as unknown as WebWorkspaceHost);
  return { host, ensureStarted, kick, context };
}

/** 当前用例的伪造入口；installHost 与用例共用同一实例。 */
let createFakeFacadeCurrent = createFakeFacade();

/** 构造 JSON 请求。 */
function jsonRequest(url: string, method: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const params = Promise.resolve({ workspaceId: "ws", groupId: "group-1", threadId: "thread-1", messageId: "message-1" });

afterEach(function resetHost() {
  setWebWorkspaceHostForTest(undefined);
  createFakeFacadeCurrent = createFakeFacade();
});

describe("协作 Route", function threadRoutesContract() {
  it("启用协作组只接受人类入口字段并返回 201", async function enableGroupRoute() {
    const f = createFakeFacadeCurrent;
    const { ensureStarted } = installHost();
    const response = await enableGroup(jsonRequest("/api/workspaces/ws/threads/groups", "POST", { requestId: "req-1", rootThreadId: "thread-1", actor: { kind: "human" } }), { params });
    expect(response.status).toBe(201);
    expect(f.calls[0]).toEqual({ method: "enable", input: { protocolVersion: 1, rootThreadId: "thread-1", requestId: "req-1" } });
    // 任何协作 Route 首次进入都会先接管驱动，再按在线事实回执。
    expect(ensureStarted).toHaveBeenCalledTimes(1);
  });

  it("停用与重新启用走同一 PATCH，且重新启用必须带根会话", async function toggleGroupRoute() {
    const f = createFakeFacadeCurrent;
    installHost();
    const disabled = await setGroupEnabled(jsonRequest("/api/workspaces/ws/threads/groups/group-1", "PATCH", { requestId: "req-2", enabled: false }), { params });
    expect(disabled.status).toBe(200);
    expect(f.calls[0]).toEqual({ method: "disable", input: { protocolVersion: 1, groupId: "group-1", requestId: "req-2" } });
    const enabled = await setGroupEnabled(jsonRequest("/api/workspaces/ws/threads/groups/group-1", "PATCH", { requestId: "req-3", enabled: true, rootThreadId: "thread-1" }), { params });
    expect(enabled.status).toBe(200);
    expect(f.calls[1]).toEqual({ method: "enable", input: { protocolVersion: 1, rootThreadId: "thread-1", requestId: "req-3", groupId: "group-1" } });
    const missingRoot = await setGroupEnabled(jsonRequest("/api/workspaces/ws/threads/groups/group-1", "PATCH", { requestId: "req-4", enabled: true }), { params });
    expect(missingRoot.status).toBe(400);
  });

  it("组查询区分列表与会话归属", async function groupQueriesRoute() {
    const f = createFakeFacadeCurrent;
    installHost();
    const byThread = await readGroups(new Request("http://localhost/api/workspaces/ws/threads/groups?threadId=thread-9"), { params });
    expect(byThread.status).toBe(200);
    expect(f.calls[0]).toEqual({ method: "groupOf", input: { protocolVersion: 1, threadId: "thread-9" } });
    await readGroups(new Request("http://localhost/api/workspaces/ws/threads/groups?limit=10"), { params });
    expect(f.calls[1]).toEqual({ method: "groups", input: { protocolVersion: 1, limit: 10 } });
  });

  it("send 返回 202 与 accepted，并唤醒本宿主 Runner", async function sendRoute() {
    const f = createFakeFacadeCurrent;
    const { kick } = installHost();
    const response = await sendMessage(jsonRequest("/api/workspaces/ws/threads/thread-1/messages", "POST", {
      groupId: "group-1",
      requestId: "req-send",
      mode: "run",
      content: "执行并回报",
      from: { kind: "human" },
      actor: "ceo",
    }), { params });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, messageId: "message-1", deliveryStatus: "pending", hostOffline: true });
    expect(f.calls[0]).toEqual({ method: "send", input: { protocolVersion: 1, groupId: "group-1", threadId: "thread-1", requestId: "req-send", mode: "run", content: "执行并回报" } });
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("消息列表 GET 透传分页并区分非法参数与越权", async function messagesRoute() {
    const f = createFakeFacadeCurrent;
    installHost();
    f.facade.messages.mockResolvedValueOnce({ items: [{ messageId: "message-1", mode: "run", deliveryStatus: "pending", deliverySeq: 1, content: "执行并回报" }] } as never);
    const response = await readMessages(new Request("http://localhost/api/workspaces/ws/threads/thread-1/messages?groupId=group-1&cursor=c1&limit=10"), { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ messageId: "message-1", deliveryStatus: "pending" }] });
    expect(f.facade.messages.mock.calls[0][0]).toEqual({ protocolVersion: 1, groupId: "group-1", threadId: "thread-1", cursor: "c1", limit: 10 });
    const missingGroup = await readMessages(new Request("http://localhost/api/workspaces/ws/threads/thread-1/messages"), { params });
    expect(missingGroup.status).toBe(400);
    const invalidLimit = await readMessages(new Request("http://localhost/api/workspaces/ws/threads/thread-1/messages?groupId=group-1&limit=0"), { params });
    expect(invalidLimit.status).toBe(400);
    expect(f.facade.messages).toHaveBeenCalledTimes(1);
    f.facade.messages.mockRejectedValueOnce(Object.assign(new Error("THREAD_SCOPE_DENIED"), { code: "THREAD_SCOPE_DENIED" }));
    const denied = await readMessages(new Request("http://localhost/api/workspaces/ws/threads/thread-1/messages?groupId=group-1"), { params });
    expect(denied.status).toBe(404);
  });

  it("非法模式与缺失字段在进入 Core 前被拒绝", async function rejectsInvalidDto() {
    const f = createFakeFacadeCurrent;
    installHost();
    const invalidMode = await sendMessage(jsonRequest("/api/workspaces/ws/threads/thread-1/messages", "POST", { groupId: "group-1", requestId: "req", mode: "send", content: "x" }), { params });
    expect(invalidMode.status).toBe(400);
    const missingGroup = await readThread(new Request("http://localhost/api/workspaces/ws/threads/thread-1"), { params });
    expect(missingGroup.status).toBe(400);
    const missingRevision = await updateState(jsonRequest("/api/workspaces/ws/threads/groups/group-1/state", "PATCH", { requestId: "req", operations: [{ op: "set", key: "goal", value: 1 }] }), { params });
    expect(missingRevision.status).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it("状态与事件读取透传 dto，wait 必须显式给出 timeoutMs", async function stateAndWaitRoutes() {
    const f = createFakeFacadeCurrent;
    installHost();
    await readState(new Request("http://localhost/api/workspaces/ws/threads/groups/group-1/state"), { params });
    await readGroupEvents(new Request("http://localhost/api/workspaces/ws/threads/groups/group-1/events?limit=5"), { params });
    await readMessageStatus(new Request("http://localhost/api/workspaces/ws/threads/thread-1/messages/message-1?groupId=group-1"), { params });
    expect(f.calls.map(function name(call) { return call.method; })).toEqual(["readState", "events", "messageStatus"]);
    const missingTimeout = await waitThreads(jsonRequest("/api/workspaces/ws/threads/wait", "POST", { groupId: "group-1", targets: [{ threadId: "thread-1" }] }), { params });
    expect(missingTimeout.status).toBe(400);
    const ok = await waitThreads(jsonRequest("/api/workspaces/ws/threads/wait", "POST", { groupId: "group-1", targets: [{ threadId: "thread-1", taskId: "run-message" }], timeoutMs: 0 }), { params });
    expect(ok.status).toBe(200);
    expect(f.facade.wait.mock.calls[0][0]).toMatchObject({ targets: [{ threadId: "thread-1", taskId: "run-message" }] });
  });

  it("组事件持续读取并用页游标重连，取消只释放观察", async function groupEventsStream() {
    const f = createFakeFacadeCurrent;
    const { ensureStarted, kick } = installHost();
    f.facade.events.mockResolvedValueOnce({ protocolVersion: 1, items: [{ groupSeq: 1 }], cursor: "c1" } as never)
      .mockResolvedValueOnce({ protocolVersion: 1, items: [{ groupSeq: 2 }], cursor: "c2" } as never);
    const abort = new AbortController();
    const response = await readGroupEvents(new Request("http://localhost/events", { signal: abort.signal }), { params });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("id: c1");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("id: c2");
    abort.abort();
    await reader.cancel();
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(f.facade.events.mock.calls[1][0]).toMatchObject({ groupId: "group-1", cursor: "c1" });
    f.facade.events.mockResolvedValueOnce({ protocolVersion: 1, items: [], cursor: "c2" } as never);
    const reconnect = await readGroupEvents(new Request("http://localhost/events", { headers: { "Last-Event-ID": "c2" } }), { params });
    expect(f.facade.events.mock.calls[2][0]).toMatchObject({ groupId: "group-1", cursor: "c2" });
    await reconnect.body!.cancel();
  });

  it("断开等待中的事件读取不会继续输出", async function cancelPendingGroupRead() {
    const f = createFakeFacadeCurrent;
    installHost();
    let release!: (value: never) => void;
    f.facade.events.mockResolvedValueOnce({ protocolVersion: 1, items: [{ groupSeq: 1 }], cursor: "c1" } as never)
      .mockImplementationOnce(async function pending() { return new Promise(function wait(resolve) { release = resolve; }); });
    const response = await readGroupEvents(new Request("http://localhost/events"), { params });
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    await new Promise(function wait(resolve) { setTimeout(resolve, 1100); });
    await reader.cancel();
    release({ protocolVersion: 1, items: [{ groupSeq: 2 }], cursor: "c2" } as never);
    expect((await pending).done).toBe(true);
  });

  it("组事件初次错误映射，流内错误安全结束", async function groupEventsErrors() {
    const f = createFakeFacadeCurrent;
    installHost();
    f.facade.events.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "THREAD_CURSOR_INVALID" }));
    const invalid = await readGroupEvents(new Request("http://localhost/events?cursor=bad"), { params });
    expect(invalid.status).toBe(409);
    f.facade.events.mockResolvedValueOnce({ protocolVersion: 1, items: [{ groupSeq: 1 }], cursor: "c1" } as never)
      .mockRejectedValueOnce(new Error("private path"));
    const response = await readGroupEvents(new Request("http://localhost/events"), { params });
    const reader = response.body!.getReader();
    await reader.read();
    const error = new TextDecoder().decode((await reader.read()).value);
    expect(error).toContain("THREADS_UNAVAILABLE");
    expect(error).not.toContain("private path");
    expect((await reader.read()).done).toBe(true);
  });

  it("interrupt 返回 202，接受不等于已停止", async function interruptRoute() {
    const f = createFakeFacadeCurrent;
    installHost();
    const response = await interruptThread(jsonRequest("/api/workspaces/ws/threads/thread-1/interrupt", "POST", { groupId: "group-1", requestId: "req-interrupt", expectedTurnId: "turn-1" }), { params });
    expect(response.status).toBe(202);
    expect(f.calls[0]).toEqual({ method: "interrupt", input: { protocolVersion: 1, groupId: "group-1", threadId: "thread-1", requestId: "req-interrupt", expectedTurnId: "turn-1" } });
  });

  it("Core 越权错误脱敏为 404，宿主未装配时 503", async function mapsErrors() {
    const facade = createFakeFacadeCurrent.facade;
    facade.send.mockRejectedValueOnce(Object.assign(new Error("THREAD_SCOPE_DENIED"), { code: "THREAD_SCOPE_DENIED" }));
    installHost();
    const denied = await sendMessage(jsonRequest("/api/workspaces/ws/threads/thread-1/messages", "POST", { groupId: "group-1", requestId: "req", mode: "notify", content: "x" }), { params });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "协作会话不存在或不可见", code: "THREAD_SCOPE_DENIED" });

    installHost({ withThreadHost: false });
    const unavailable = await readCapabilities(new Request("http://localhost/api/workspaces/ws/threads/capabilities"), { params });
    expect(unavailable.status).toBe(503);
  });

  it("能力清单展示建组授权工具", async function capabilitiesRoute() {
    installHost();
    const response = await readCapabilities(new Request("http://localhost/api/workspaces/ws/threads/capabilities"), { params });
    const payload = await response.json() as { allowedTools: string[] };
    expect(payload.allowedTools).toContain("send_thread");
    expect(payload.allowedTools).toContain("write_file");
  });
  it("明确任务条只读DTO不启动或恢复宿主", async function taskFactsRoute() {
    const f = createFakeFacadeCurrent;
    const { ensureStarted, kick } = installHost();
    const response = await readTasks(new Request("http://localhost/tasks?threadId=source"), { params: Promise.resolve({ workspaceId: "ws", groupId: "group-1" }) });
    expect(response.status).toBe(200);
    expect(f.facade.tasks.mock.calls[0][0]).toEqual({ protocolVersion: 1, groupId: "group-1", threadId: "source" });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

});
