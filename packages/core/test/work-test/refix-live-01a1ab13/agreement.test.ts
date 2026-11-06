/** r003 内部约定持久身份与用户输入逐次转发的定向回归。 */
import { expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadService, createThreadFacade } from "../../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../src/runtime/application/thread-delivery-service";
import { createThreadsToolBinding } from "../../../src/runtime/application/thread-tool-binding";
import { createThreadTools } from "../../../src/internal/tools/builtins/thread-tools";

/** 建立授权组及真实父子来源；不启动模型。 */
async function setup() {
  const ports = createMemoryPorts();
  const root = await createSessionService(ports).create({ title: "parent" });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: "user" };
  const human = createThreadService(ports, ports.threadStore, { ...capability, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ rootThreadId: root.id, requestId: "enable" });
  await ports.sessionStore.save({ ...root, status: "running", activeTurnId: "parent-turn" });
  await ports.turnStore.save({ id: "parent-turn", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
  const parent = createThreadService(ports, ports.threadStore, { ...capability, actor: { kind: "thread", threadId: root.id, turnId: "parent-turn" } });
  const child = await parent.create({ groupId: group.groupId, parentThreadId: root.id, requestId: "child" });
  const host = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "workspace", stateRootId: "state", ownerId: "host" });
  const binding = createThreadsToolBinding(ports, capability, { threadId: root.id, turnId: "parent-turn" });
  return { ports, root, child, human, parent, capability, groupId: group.groupId, host, binding };
}

/** 标记目标的真实活动Turn，保留精确发送校验。 */
async function running(f: Awaited<ReturnType<typeof setup>>, turnId: string) {
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status: "running", activeTurnId: turnId });
  await f.ports.turnStore.save({ id: turnId, sessionId: child.id, status: "running", frozenRunConfig: {}, startedAt: 2 });
}


/** 建立真实run映射，并将目标置于原Turn运行中。 */
async function taskFixture() {
  const f = await setup();
  const task = await f.binding.send({ threadId: f.child.threadId, requestId: "task", mode: "run", content: "任务" });
  const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
  const turnId = claimed.delivery.reservedTurnId!;
  await running(f, turnId);
  return { ...f, taskId: task.messageId, turnId };
}
/** 内部标记只能由受信执行选项提供。 */
function agreement(f: Awaited<ReturnType<typeof taskFixture>>, content = "只在完成和阻塞时汇报", explicit = true) {
  return { threadId: f.child.threadId, requestId: "caller", mode: "steer" as const, expectedTurnId: f.turnId, content, reportingAgreement: { taskId: f.taskId, explicit } };
}
it("r003 同任务重复约定跨父Turn和暂停恢复幂等，变更及改回各传一次", async function durableAgreement() {
  const f = await taskFixture();
  const first = await f.binding.send(agreement(f));
  expect((await f.binding.send(agreement(f))).messageId).toBe(first.messageId);
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status: "waiting_approval" });
  expect((await f.binding.send(agreement(f))).messageId).toBe(first.messageId);
  await running(f, f.turnId);
  await f.ports.turnStore.save({ id: "parent-next", sessionId: f.root.id, status: "running", frozenRunConfig: {}, startedAt: 3 });
  await f.ports.sessionStore.save({ ...(await f.ports.sessionStore.get(f.root.id))!, activeTurnId: "parent-next" });
  const next = createThreadsToolBinding(f.ports, f.capability, { threadId: f.root.id, turnId: "parent-next" });
  expect((await next.send(agreement(f, "默认约定", false))).messageId).toBe(first.messageId);
  const changed = await next.send(agreement(f, "每阶段汇报"));
  expect(changed.messageId).not.toBe(first.messageId);
  expect((await next.send(agreement(f, "每阶段汇报"))).messageId).toBe(changed.messageId);
  expect((await next.send(agreement(f))).messageId).not.toBe(first.messageId);
  expect((await f.ports.threadStore.readControl(f.groupId))!.messageIntents.filter(function internal(i) { return i.message.purpose; })).toHaveLength(3);
});
it("r003 失败重试复用原持久投递身份且并发相同约定不增投递", async function retryAgreement() {
  const f = await taskFixture();
  vi.spyOn(f.ports.threadStore, "writeMessage").mockRejectedValueOnce(new Error("controlled"));
  await expect(f.binding.send(agreement(f))).rejects.toThrow();
  const before = (await f.ports.threadStore.readControl(f.groupId))!.messageIntents.at(-1)!;
  expect(before.committed).toBe(false);
  const retry = await f.binding.send(agreement(f));
  expect(retry.messageId).toBe(before.message.messageId);
  const both = await Promise.all([f.binding.send(agreement(f, "新约定")), f.binding.send(agreement(f, "新约定"))]);
  expect(both[0].messageId).toBe(both[1].messageId);
});
it("r003 相同用户正文两个来源各投递一次，内部用途贯穿Inbox且模型不可伪造", async function userAndInternal() {
  const f = await taskFixture();
  const first = await f.binding.send({ threadId: f.child.threadId, requestId: "user-input-1", content: "相同追加" });
  const second = await f.binding.send({ threadId: f.child.threadId, requestId: "user-input-2", content: "相同追加" });
  expect(first.messageId).not.toBe(second.messageId);
  expect((await f.binding.send({ threadId: f.child.threadId, requestId: "user-input-1", content: "相同追加" })).messageId).toBe(first.messageId);
  const internal = await f.binding.send(agreement(f));
  await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
  const inbox = await f.ports.inputInbox.list({ sessionId: f.child.threadId });
  expect(inbox.filter(function user(i) { return i.content === "相同追加"; })).toHaveLength(2);
  expect(inbox.find(function purpose(i) { return i.clientMessageId === internal.messageId; })?.origin).toMatchObject({ purpose: "reporting_agreement" });
  expect(createThreadTools(f.binding).sendThread.inputSchema.safeParse(agreement(f)).success).toBe(false);
});

it("r003 公开协议不能自报内部用途或约定，精确task身份也不能越界", async function rejectsUntrustedPurpose() {
 const f = await taskFixture();
 const facade = createThreadFacade(f.ports, { ...f.capability, actor: { kind: "thread", threadId: f.root.id, turnId: "parent-turn" } });
 await expect(facade.send({ protocolVersion: 1, groupId: f.groupId, ...agreement(f) } as any)).rejects.toMatchObject({ code: "INVALID_INPUT" });
 await expect(f.binding.send({ ...agreement(f), reportingAgreement: { taskId: "wrong-task", explicit: true } })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
});
