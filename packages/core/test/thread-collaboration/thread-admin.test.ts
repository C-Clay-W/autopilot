/** 验证协作组的停用/重新启用、停用后只读、面板查询与宿主离线回执。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadFacade } from "../../src/runtime/application/thread-service";
import type { RuntimePorts } from "../../src/runtime/ports";

/** 建立已启用协作组的内存宿主；返回人类入口与根会话。 */
async function setup(hostOnline?: boolean) {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const context = { workspaceId: "workspace", stateRootId: "state-one", projectId: root.projectId!, allowedTools: ["read_file", "send_thread"], modelCatalog: [], ...(hostOnline === undefined ? {} : { hostOnline }) };
  const human = createThreadFacade(ports, { ...context, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  return { ports, sessions, root, context, human, groupId: group.groupId };
}

/** 直接在 Store 放置 running Turn，模拟该会话正在执行。 */
async function startRunningTurn(ports: RuntimePorts, sessionId: string, turnId: string): Promise<void> {
  await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now(), schemaVersion: 2 });
  const session = await ports.sessionStore.get(sessionId);
  await ports.sessionStore.save({ ...session!, status: "running", activeTurnId: turnId, updatedAt: ports.clock.now() });
}

describe("协作组管理", function threadAdminContract() {
  it("停用后拒绝新增写入与等待，但保留读取与历史", async function disableKeepsHistory() {
    const f = await setup();
    await f.human.create({ protocolVersion: 1, groupId: f.groupId, parentThreadId: f.root.id, title: "child", requestId: "create-child" });
    const sent = await f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "send-1", mode: "notify", content: "保留的通知" });
    expect(await f.human.disable({ protocolVersion: 1, groupId: f.groupId, requestId: "disable-1" })).toMatchObject({ enabled: false });
    for (const call of [
      function sendAgain() { return f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "send-2", mode: "run", content: "不应接受" }); },
      function createAgain() { return f.human.create({ protocolVersion: 1, groupId: f.groupId, parentThreadId: f.root.id, requestId: "create-2" }); },
      function updateState() { return f.human.updateState({ protocolVersion: 1, groupId: f.groupId, requestId: "state-2", expectedRevision: 0, operations: [{ op: "set", key: "goal", value: "x" }] }); },
      function waitAgain() { return f.human.wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: f.root.id }], timeoutMs: 0 }); },
      function interruptAgain() { return f.human.interrupt({ protocolVersion: 1, groupId: f.groupId, requestId: "interrupt-2", threadId: f.root.id, expectedTurnId: "turn-missing" }); },
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    }
    // 读取仍可用：成员、消息与交付状态、共享板、事件都不因停用而消失。
    expect((await f.human.list({ protocolVersion: 1, groupId: f.groupId })).items).toHaveLength(2);
    const messages = await f.human.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id });
    expect(messages.items[0]).toMatchObject({ messageId: sent.messageId, content: "保留的通知", deliveryStatus: "pending" });
    expect(await f.human.messageStatus({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, messageId: sent.messageId })).toMatchObject({ deliveryStatus: "pending" });
    expect(await f.human.readState({ protocolVersion: 1, groupId: f.groupId })).toMatchObject({ revision: 0 });
    expect((await f.human.events({ protocolVersion: 1, groupId: f.groupId })).items.map(function kind(event) { return event.kind; })).toEqual(["member_created", "member_created", "message_accepted", "group_disabled"]);
    expect(await f.human.groupOf({ protocolVersion: 1, threadId: f.root.id })).toMatchObject({ group: { groupId: f.groupId, enabled: false } });
  });

  it("重复停用幂等，重新启用复用同一组并要求空闲会话", async function reenable() {
    const f = await setup();
    const first = await f.human.disable({ protocolVersion: 1, groupId: f.groupId, requestId: "disable-1" });
    expect(await f.human.disable({ protocolVersion: 1, groupId: f.groupId, requestId: "disable-2" })).toEqual(first);
    const enabled = await f.human.enable({ protocolVersion: 1, requestId: "reenable-1", rootThreadId: f.root.id });
    expect(enabled.group).toMatchObject({ groupId: f.groupId, enabled: true });
    expect((await f.human.groups({ protocolVersion: 1 })).items).toHaveLength(1);
    // 运行中的会话不重新启用，避免把停用前的授权直接恢复。
    await f.human.disable({ protocolVersion: 1, groupId: f.groupId, requestId: "disable-3" });
    await startRunningTurn(f.ports, f.root.id, "turn-running");
    await expect(f.human.enable({ protocolVersion: 1, requestId: "reenable-2", rootThreadId: f.root.id })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  });

  it("成功完成的会话可以首次启用和重新启用，未完成终态仍拒绝", async function completedEnable() {
    const ports = createMemoryPorts();
    const sessions = createSessionService(ports);
    const root = await sessions.create({ title: "completed" });
    const human = createThreadFacade(ports, { workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], actor: { kind: "human", principalId: "user" } });
    await ports.turnStore.save({ id: "turn", sessionId: root.id, status: "completed", frozenRunConfig: {}, startedAt: 1, completedAt: 2 });
    await ports.sessionStore.save({ ...root, status: "completed", activeTurnId: undefined });
    await ports.checkpointStore.save(root.id, { turnId: "turn", status: "completed", stepCount: 1, messages: [], completedCallIds: [] });
    const enabled = await human.enable({ protocolVersion: 1, requestId: "first", rootThreadId: root.id });
    await human.disable({ protocolVersion: 1, groupId: enabled.group.groupId, requestId: "disable" });
    await ports.checkpointStore.save(root.id, { turnId: "turn", status: "limit_reached", stepCount: 1, messages: [], completedCallIds: [] });
    await expect(human.enable({ protocolVersion: 1, requestId: "limit", rootThreadId: root.id })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    await ports.checkpointStore.save(root.id, { turnId: "turn", status: "completed", stepCount: 1, messages: [], completedCallIds: [] });
    expect((await human.enable({ protocolVersion: 1, requestId: "again", rootThreadId: root.id })).group.enabled).toBe(true);
  });

  it("组查询只返回当前人类创建的组", async function groupQueries() {
    const f = await setup();
    const other = createThreadFacade(f.ports, { ...f.context, actor: { kind: "human", principalId: "other" } });
    expect((await f.human.groups({ protocolVersion: 1 })).items.map(function id(item) { return item.groupId; })).toEqual([f.groupId]);
    expect(await other.groups({ protocolVersion: 1 })).toMatchObject({ items: [] });
    expect(await other.groupOf({ protocolVersion: 1, threadId: f.root.id })).toEqual({ protocolVersion: 1, group: null });
    expect(await f.human.groupOf({ protocolVersion: 1, threadId: "not-a-member" })).toEqual({ protocolVersion: 1, group: null });
    expect((await f.human.groups({ protocolVersion: 1 })).items[0]).toMatchObject({ rootThreadId: f.root.id, allowedTools: ["read_file", "send_thread"], members: [{ threadId: f.root.id, parentThreadId: null }] });
  });

  it("run 投递按宿主在线事实回执，通知与未知状态不填 hostOffline", async function hostOfflineReceipt() {
    const offline = await setup(false);
    const offlineSend = await offline.human.send({ protocolVersion: 1, groupId: offline.groupId, threadId: offline.root.id, requestId: "run-offline", mode: "run", content: "执行" });
    expect(offlineSend).toMatchObject({ deliveryStatus: "pending", hostOffline: true });
    const notify = await offline.human.send({ protocolVersion: 1, groupId: offline.groupId, threadId: offline.root.id, requestId: "notify-offline", mode: "notify", content: "通知" });
    expect("hostOffline" in notify).toBe(false);

    const online = await setup(true);
    const onlineSend = await online.human.send({ protocolVersion: 1, groupId: online.groupId, threadId: online.root.id, requestId: "run-online", mode: "run", content: "执行" });
    expect("hostOffline" in onlineSend).toBe(false);

    const unknown = await setup();
    const unknownSend = await unknown.human.send({ protocolVersion: 1, groupId: unknown.groupId, threadId: unknown.root.id, requestId: "run-unknown", mode: "run", content: "执行" });
    expect("hostOffline" in unknownSend).toBe(false);
  });
});
