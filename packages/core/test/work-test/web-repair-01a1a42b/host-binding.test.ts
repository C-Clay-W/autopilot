/** Web执行归属回归，只使用内存Store与真实CAS投递服务。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadService } from "../../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../src/runtime/application/thread-delivery-service";
import { createThreadObservationDisplay } from "../../../src/internal/tools/thread-observation-display";

/** 创建可选受信执行档位的普通协作组与子会话。 */
async function fixture(executionHost?: string) {
  const ports = createMemoryPorts();
  const root = await createSessionService(ports).create({ title: "root" });
  const context = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, allowedTools: ["read_file"], modelCatalog: [], actor: { kind: "human" as const, principalId: "local" }, ...(executionHost ? { executionHost } : {}) };
  const service = createThreadService(ports, ports.threadStore, context);
  const group = await service.enable({ rootThreadId: root.id, requestId: "enable" });
  const groupId = group.group.groupId;
  const child = await service.create({ groupId, parentThreadId: root.id, requestId: "child" });
  /** 模拟不同宿主重启后的owner，档位由受信装配单独提供。 */
  function host(ownerId: string, profile?: string) {
    return createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "ws", stateRootId: "state", ownerId, ...(profile ? { executionHost: profile } : {}) });
  }
  return { ports, root, context, child, service, groupId, host };
}

it("Web派发由兼容宿主领取，默认Runner不能竞争，重启不改变档位", async function webOwner() {
  const f = await fixture("web-work-v1");
  await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "任务" });
  expect(await f.host("cli").claimDeliveries({ activeThreads: [] })).toEqual([]);
  expect(await f.host("web-old", "web-work-v0").claimDeliveries({ activeThreads: [] })).toEqual([]);
  const delivery = (await f.host("web-one", "web-work-v1").claimDeliveries({ activeThreads: [] }))[0];
  expect(delivery.delivery.ownerId).toBe("web-one");
  await f.host("web-one", "web-work-v1").releaseDelivery({ groupId: f.groupId, messageId: delivery.message.messageId });
  expect((await f.host("web-restarted", "web-work-v1").claimDeliveries({ activeThreads: [] }))[0].delivery.ownerId).toBe("web-restarted");
});

it("旧缺省任务沿用原领取语义", async function legacyOwner() {
  const f = await fixture();
  await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "legacy", mode: "run", content: "旧任务" });
  expect(await f.host("cli").claimDeliveries({ activeThreads: [] })).toHaveLength(1);
});

it("后续steer与恢复控制仍匹配目标原档位，发送参数不能改绑", async function steeringAndResume() {
  const f = await fixture("web-work-v1");
  const childId = f.child.threadId;
  await f.ports.sessionStore.save({ ...(await f.ports.sessionStore.get(childId))!, status: "running", activeTurnId: "turn" });
  await f.ports.turnStore.save({ id: "turn", sessionId: childId, status: "running", startedAt: 1, frozenRunConfig: {} });
  const legacySender = createThreadService(f.ports, f.ports.threadStore, { ...f.context, executionHost: undefined });
  await legacySender.send({ groupId: f.groupId, threadId: childId, requestId: "steer", mode: "steer", expectedTurnId: "turn", content: "后续引导", executionHost: "forged" } as never);
  await f.host("cli").claimDeliveries({ activeThreads: [childId] });
  expect(await f.ports.inputInbox.list({ sessionId: childId })).toHaveLength(0);
  await f.host("web", "web-work-v1").claimDeliveries({ activeThreads: [childId] });
  expect(await f.ports.inputInbox.list({ sessionId: childId })).toHaveLength(1);
  const control = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, control.revision, { ...control, revision: control.revision + 1, controls: [{ controlId: "resume", kind: "resume", threadId: childId, expectedTurnId: "turn", status: "pending", createdAt: 1, updatedAt: 1 }] });
  expect(await f.host("cli").pendingResumes()).toEqual([]);
  expect(await f.host("web-restart", "web-work-v1").pendingResumes()).toHaveLength(1);
  expect(await f.host("cli").claimResume({ groupId: f.groupId, controlId: "resume" })).toBe(false);
  expect(await f.host("web-restart", "web-work-v1").claimResume({ groupId: f.groupId, controlId: "resume" })).toBe(true);
});

it("观察display只投影受控事实，游标不改变身份，审批与里程碑保留阶段", function safeObservationFacts() {
  const first = createThreadObservationDisplay("wait_threads", { targets: [{ threadId: "target", taskId: "task", cursor: "one" }] }, { results: [{ reason: "timeout", summary: { turnStatus: "running", progressCount: 1 }, secret: "private" }] })!;
  const second = createThreadObservationDisplay("wait_threads", { targets: [{ threadId: "target", taskId: "task", cursor: "two" }], timeoutMs: 30000 }, { results: [{ reason: "snapshot", summary: { turnStatus: "running", progressCount: 2 } }] })!;
  expect(second.key).toBe(first.key); expect(second.phase).toBe(first.phase);
  expect(JSON.stringify(first)).not.toContain("private"); expect(JSON.stringify(first)).not.toContain("target");
  const attention = createThreadObservationDisplay("wait_threads", { targets: [{ threadId: "target", taskId: "task" }] }, { results: [{ reason: "attention", summary: { turnStatus: "waiting_approval" } }] })!;
  expect(attention.phase).not.toBe(first.phase);
  const nextApproval = createThreadObservationDisplay("wait_threads", { targets: [{ threadId: "target", taskId: "task" }] }, { results: [{ reason: "attention", cursor: "new-approval-epoch", summary: { turnStatus: "waiting_approval" } }] })!;
  expect(nextApproval.phase).not.toBe(attention.phase);
  expect(JSON.stringify(nextApproval)).not.toContain("new-approval-epoch");
  const milestone = createThreadObservationDisplay("read_progress", { threadId: "target", taskId: "task" }, { items: [{ kind: "milestone", progressSeq: 1, summary: "真实阶段" }] })!;
  const next = createThreadObservationDisplay("read_progress", { threadId: "target", taskId: "task" }, { items: [{ kind: "milestone", progressSeq: 2, summary: "下一阶段" }] })!;
  expect(milestone.lines).toContain("milestone · 真实阶段"); expect(next.phase).not.toBe(milestone.phase);
});
