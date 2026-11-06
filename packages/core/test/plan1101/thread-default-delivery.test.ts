/** D1：可信父子默认投递与首次持久意图冻结，复用真实Core服务和Inbox。 */
import { expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadService } from "../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../src/runtime/application/thread-delivery-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";
import { createThreadTools } from "../../src/internal/tools/builtins/thread-tools";

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
  return { ports, root, child, human, parent, groupId: group.groupId, host, binding };
}

/** 标记目标的真实活动Turn，保留精确发送校验。 */
async function running(f: Awaited<ReturnType<typeof setup>>, turnId: string) {
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status: "running", activeTurnId: turnId });
  await f.ports.turnStore.save({ id: turnId, sessionId: child.id, status: "running", frozenRunConfig: {}, startedAt: 2 });
}

/** 空闲默认run，运行时默认steer进入同Turn；显式run仍排队，Schema与绑定共用Core决策。 */
it("D1 自建孩子 idle 默认 run、running 默认 steer、显式 run 仍排队", async function routesOwnChild() {
  const f = await setup();
  const tools = createThreadTools(f.binding);
  expect(tools.sendThread.inputSchema.safeParse({ threadId: f.child.threadId, content: "任务" }).success).toBe(true);
  const first = await f.binding.send({ threadId: f.child.threadId, requestId: "first", content: "任务" });
  expect(first).toMatchObject({ mode: "run", taskId: first.messageId });
  const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
  const turnId = claimed.delivery.reservedTurnId!;
  await running(f, turnId);
  const steer = await f.binding.send({ threadId: f.child.threadId, requestId: "steer", content: "补充约束" });
  expect(steer).toMatchObject({ mode: "steer", expectedTurnId: turnId });
  const queued = await f.binding.send({ threadId: f.child.threadId, requestId: "queue", mode: "run", content: "下一轮" });
  expect(await f.host.claimDeliveries({ activeThreads: [f.child.threadId] })).toEqual([]);
  expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toMatchObject([{ clientMessageId: steer.messageId, turnId, delivery: "steer", status: "pending" }]);
  expect((await f.parent.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: queued.messageId })).deliveryStatus).toBe("blocked");
});

/** 首次持久意图后的重试不受目标终态/换轮影响；省略与显式mode仍是不同请求语义。 */
it.each([false, true])("D1 重试冻结原 steer 与 expectedTurn，落盘失败=%s", async function freezesDefaultDecision(failMessageWrite) {
  const f = await setup();
  await running(f, "child-turn");
  const input = { groupId: f.groupId, threadId: f.child.threadId, requestId: "retry", content: "约束" };
  if (failMessageWrite) {
    vi.spyOn(f.ports.threadStore, "writeMessage").mockRejectedValueOnce(new Error("injected message write failure"));
    await expect(f.parent.send(input)).rejects.toThrow();
  } else await f.parent.send(input);
  const frozen = (await f.ports.threadStore.readControl(f.groupId))!.messageIntents[0].message;
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status: "completed", activeTurnId: undefined });
  const terminalRetry = await f.parent.send(input);
  expect(terminalRetry).toMatchObject({ messageId: frozen.messageId, mode: "steer", expectedTurnId: "child-turn" });
  await running(f, "next-child-turn");
  expect(await f.parent.send(input)).toEqual(terminalRetry);
  await expect(f.parent.send({ ...input, mode: "run" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
  await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
  expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual([]);
  expect((await f.parent.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: frozen.messageId })).deliveryStatus).toBe("blocked");
  expect((await f.ports.threadStore.readControl(f.groupId))!.messageIntents).toHaveLength(1);
});

/** 等待不是可隐式恢复状态，默认发送不绕过人类审批/输入；显式run保持原排队语义。 */
it.each(["waiting_approval", "waiting_user_input"] as const)("D1 %s 默认发送拒绝且不隐式恢复", async function rejectsWaitingDefault(status) {
  const f = await setup();
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status });
  const input = { groupId: f.groupId, threadId: child.id, requestId: "waiting", content: "补充" };
  await expect(f.parent.send(input)).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  expect((await f.parent.send({ ...input, mode: "run" })).mode).toBe("run");
  expect((await f.ports.sessionStore.get(child.id))?.status).toBe(status);
  expect(await f.ports.inputInbox.list({ sessionId: child.id })).toEqual([]);
});

/** 非创建关系或人类不能取得默认路由特权，显式发送和expectedTurn守卫仍按原授权执行。 */
it("D1 非父子和人类省略 mode 拒绝，显式行为及精确 Turn 守卫保留", async function preservesAuthority() {
  const f = await setup();
  await running(f, "child-turn");
  const input = { groupId: f.groupId, threadId: f.child.threadId, requestId: "human-default", content: "消息" };
  await expect(f.human.send(input)).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  expect((await f.human.send({ ...input, mode: "notify" })).mode).toBe("notify");
  await expect(f.parent.send({ ...input, requestId: "explicit-missing-turn", mode: "steer" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(f.parent.send({ ...input, requestId: "explicit-wrong-turn", mode: "steer", expectedTurnId: "other" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
  const sibling = await f.parent.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId: "sibling" });
  const childSender = createThreadService(f.ports, f.ports.threadStore, { workspaceId: "workspace", stateRootId: "state", projectId: f.root.projectId!, allowedTools: [], modelCatalog: [], actor: { kind: "thread", threadId: f.child.threadId, turnId: "child-turn" } });
  await expect(childSender.send({ ...input, threadId: sibling.threadId, requestId: "sibling-default" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
});
