/** C4：协作只读投影绑定durable Inbox消费事实，不把接受/交付当消费。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadService } from "../../src/runtime/application/thread-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";
import { createThreadDeliveryService } from "../../src/runtime/application/thread-delivery-service";
import { createAgentInputInboxCapability } from "../../src/runtime/application/input-inbox-service";
import { createThreadTools } from "../../src/internal/tools/builtins/thread-tools";

/** 建立真实投递/Inbox/绑定查询，只有模型及宿主执行不参与。 */
async function setup() {
  const ports = createMemoryPorts();
  const root = await createSessionService(ports).create({ title: "parent" });
  const context = { workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: "user" };
  const human = createThreadService(ports, ports.threadStore, { ...context, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ rootThreadId: root.id, requestId: "enable" });
  const child = await human.create({ groupId: group.groupId, parentThreadId: root.id, requestId: "child" });
  await ports.sessionStore.save({ ...root, status: "running", activeTurnId: "parent-turn" });
  await ports.turnStore.save({ id: "parent-turn", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
  const target = (await ports.sessionStore.get(child.threadId))!;
  await ports.sessionStore.save({ ...target, status: "running", activeTurnId: "child-turn" });
  await ports.turnStore.save({ id: "child-turn", sessionId: target.id, status: "running", frozenRunConfig: {}, startedAt: 2 });
  const binding = createThreadsToolBinding(ports, context, { threadId: root.id, turnId: "parent-turn" });
  const host = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "workspace", stateRootId: "state", ownerId: "host" });
  const sent = await binding.send({ threadId: child.threadId, requestId: "steer", content: "补充约束" });
  return { ports, root, child, human, groupId: group.groupId, binding, host, sent };
}

/** 接受、桥接、真实同Turn消费依次可区分，read与messageStatus共用精确证据。 */
it("C4 pending 和 delivered 不冒充 consumed，同 Turn Inbox 消费才投影证据", async function projectsActualConsumption() {
  const f = await setup();
  expect(createThreadTools(f.binding).sendThread.serializeOutput(f.sent)).toMatchObject({ accepted: true, deliveryStatus: "pending", executionStatus: "unconfirmed", consumptionStatus: "unconfirmed" });
  let message = (await f.binding.read({ threadId: f.child.threadId })).messages[0];
  expect(message.deliveryStatus).toBe("pending");
  expect(message.inputState).toBeUndefined();
  await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
  message = (await f.binding.read({ threadId: f.child.threadId })).messages[0];
  expect(message).toMatchObject({ messageId: f.sent.messageId, deliveryStatus: "delivered", inputState: { status: "pending", inputId: message.inputId, turnId: "child-turn" } });
  const capability = createAgentInputInboxCapability(f.ports.inputInbox, f.child.threadId, "child-turn");
  await capability.drain({ maxDelivery: "steer", boundary: "before_sample" });
  message = (await f.binding.read({ threadId: f.child.threadId })).messages[0];
  expect(message.inputState).toEqual({ inputId: message.inputId, turnId: "child-turn", status: "consumed" });
  expect((await f.human.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: f.sent.messageId })).inputState).toEqual(message.inputState);
  expect(JSON.stringify(await f.binding.read({ threadId: f.child.threadId }))).not.toContain("checkpoint");
});

/** 即使存在已消费输入，blocked、错messageId/inputId或错Turn也不能借用消费证据。 */
it.each(["blocked", "foreign-input", "wrong-turn"] as const)("C4 %s 不投影借用的 consumed", async function rejectsMismatchedConsumption(kind) {
  const f = await setup();
  await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
  await createAgentInputInboxCapability(f.ports.inputInbox, f.child.threadId, "child-turn").drain({ maxDelivery: "steer", boundary: "before_sample" });
  const control = (await f.ports.threadStore.readControl(f.groupId))!;
  let inputId = control.deliveries[0].inputId;
  if (kind === "foreign-input") {
    const foreign = await f.ports.inputInbox.post({ sessionId: f.child.threadId, clientMessageId: "another-message", turnId: "child-turn", delivery: "steer", content: "另一条" });
    await createAgentInputInboxCapability(f.ports.inputInbox, f.child.threadId, "child-turn").drain({ maxDelivery: "steer", boundary: "before_sample" });
    inputId = foreign.inputId;
  }
  expect(await f.ports.threadStore.compareAndSetControl(f.groupId, control.revision, {
    ...control, revision: control.revision + 1,
    deliveries: control.deliveries.map(function changed(delivery) { return { ...delivery, inputId, ...(kind === "blocked" ? { status: "blocked" as const } : {}), ...(kind === "wrong-turn" ? { turnId: "another-turn" } : {}) }; }),
  })).toBe(true);
  expect((await f.binding.read({ threadId: f.child.threadId })).messages[0].inputState).toBeUndefined();
  expect((await f.human.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: f.sent.messageId })).inputState).toBeUndefined();
});
