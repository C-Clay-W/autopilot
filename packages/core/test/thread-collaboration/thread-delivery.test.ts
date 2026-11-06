/** 验证宿主投递、领取、崩溃收敛、中断意图与只读等待，不启动真实模型。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadService } from "../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../src/runtime/application/thread-delivery-service";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createAgentInputInboxCapability } from "../../src/runtime/application/input-inbox-service";

/** 初始化真实 Session、协作组和一个空闲子会话。 */
async function setup() {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const context = { workspaceId: "workspace", stateRootId: "state-one", allowedTools: ["read_file"], modelCatalog: [], projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" } };
  const service = createThreadService(ports, ports.threadStore, context);
  const group = await service.enable({ rootThreadId: root.id, requestId: "enable" });
  const groupId = group.group.groupId;
  const child = await service.create({ groupId, parentThreadId: root.id, requestId: "child", title: "child" });
  const host = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-a" });
  return { ports, root, child, context, service, groupId, host, store: ports.threadStore };
}

/** 标记目标会话正在执行指定 Turn，并写入对应 Turn 记录。 */
async function running(f: Awaited<ReturnType<typeof setup>>, threadId: string, turnId: string): Promise<void> {
  const session = (await f.ports.sessionStore.get(threadId))!;
  await f.ports.sessionStore.save({ ...session, status: "running", activeTurnId: turnId });
  await f.ports.turnStore.save({ id: turnId, sessionId: threadId, status: "running", frozenRunConfig: {}, startedAt: 1 });
}

/** 写入一条 checkpoint，用于判断执行 lease 是否仍然新鲜。 */
async function checkpoint(f: Awaited<ReturnType<typeof setup>>, threadId: string, turnId: string, heartbeatAt: number): Promise<void> {
  await f.ports.checkpointStore.save(threadId, { turnId, status: "running", stepCount: 0, messages: [], completedCallIds: [], lease: { leaseId: "lease", ownerId: "owner", heartbeatAt, safeBoundarySeq: 0 } });
}

describe("协作投递与恢复", function deliveryContract() {
  it("notify 只持久化通知，run 才产生可领取投递", async function notifyDoesNotStart() {
    const f = await setup();
    await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "notice", mode: "notify", content: "注意进度" });
    expect(await f.host.claimDeliveries({ activeThreads: [] })).toEqual([]);
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual([]);
    expect(await f.ports.turnStore.list(f.child.threadId)).toEqual([]);

    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行定向测试" });
    const claimed = await f.host.claimDeliveries({ activeThreads: [] });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].message.messageId).toBe(sent.messageId);
    expect(claimed[0].delivery.status).toBe("claimed");
    expect(claimed[0].delivery.reservedTurnId).toBeTruthy();
    // 同一目标已有在途领取时不得重复启动，也不得再返回启动动作。
    expect(await f.host.claimDeliveries({ activeThreads: [] })).toEqual([]);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId })).deliveryStatus).toBe("claimed");
  });

  it("Turn 收尾后回填真实执行状态，未终态不写成功", async function backfillsExecution() {
    const f = await setup();
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    const before = await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
    expect(before.execution).toBeUndefined();
    await f.ports.turnStore.save({ id: turnId, sessionId: f.child.threadId, status: "completed", frozenRunConfig: {}, startedAt: 1, completedAt: 2 });
    await f.host.completeDelivery({ groupId: f.groupId, messageId: sent.messageId, turnId });
    const after = await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
    expect(after.deliveryStatus).toBe("delivered");
    expect(after.execution).toEqual({ turnId, status: "completed" });
  });

  it("领取后崩溃且无 Turn 时退回 pending，可被重新领取", async function requeuesAfterClaimCrash() {
    const f = await setup();
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    await f.host.claimDeliveries({ activeThreads: [] });
    const other = createThreadDeliveryService(f.ports, f.store, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-b" });
    const result = await other.reconcile({ staleMs: 0 });
    expect(result.requeued).toEqual([sent.messageId]);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId })).deliveryStatus).toBe("pending");
    expect(await other.claimDeliveries({ activeThreads: [] })).toHaveLength(1);
  });

  it("Turn 已落盘但回执丢失时只回填不重跑", async function backfillsWithoutRestart() {
    const f = await setup();
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await f.ports.turnStore.save({ id: turnId, sessionId: f.child.threadId, status: "failed", frozenRunConfig: {}, startedAt: 1, completedAt: 2 });
    const other = createThreadDeliveryService(f.ports, f.store, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-b" });
    const result = await other.reconcile({ staleMs: 0 });
    expect(result.delivered).toEqual([sent.messageId]);
    const status = await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
    expect(status.deliveryStatus).toBe("delivered");
    expect(status.execution).toEqual({ turnId, status: "failed" });
  });

  it("owner 失联按 lease 事实区分观察与需恢复", async function distinguishesObserveAndRecovery() {
    const f = await setup();
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await f.ports.turnStore.save({ id: turnId, sessionId: f.child.threadId, status: "running", frozenRunConfig: {}, startedAt: 1 });
    await checkpoint(f, f.child.threadId, turnId, Date.now());
    const other = createThreadDeliveryService(f.ports, f.store, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-b" });
    expect((await other.reconcile({ staleMs: 0 })).observing).toEqual([sent.messageId]);
    await checkpoint(f, f.child.threadId, turnId, Date.now() - 10 * 60_000);
    const recovered = await other.reconcile({ staleMs: 0 });
    expect(recovered.recoveryRequired).toEqual([sent.messageId]);
    const status = await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
    expect(status.deliveryStatus).toBe("failed");
    expect((await f.store.readControl(f.groupId))!.deliveries[0].reason).toBe("recovery_required");
  });

  it("活动 Turn 的 steer 只桥接匹配 Turn，并保留另一会话来源", async function bridgesSteerWithOrigin() {
    const f = await setup();
    await running(f, f.root.id, "turn-root");
    await running(f, f.child.threadId, "turn-child");
    const sender = createThreadService(f.ports, f.store, { ...f.context, actor: { kind: "thread", threadId: f.child.threadId, turnId: "turn-child" } });
    const sent = await sender.send({ groupId: f.groupId, threadId: f.root.id, requestId: "steer", mode: "steer", content: "补充约束", expectedTurnId: "turn-root" });
    expect(await f.host.claimDeliveries({ activeThreads: [f.root.id] })).toEqual([]);
    const inbox = await f.ports.inputInbox.list({ sessionId: f.root.id });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ delivery: "steer", turnId: "turn-root", content: "补充约束", origin: { kind: "thread", threadId: f.child.threadId, turnId: "turn-child" } });
    const status = await f.service.messageStatus({ groupId: f.groupId, threadId: f.root.id, messageId: sent.messageId });
    expect(status.deliveryStatus).toBe("delivered");
    expect(status.inputId).toBe(inbox[0].inputId);

    // 接受后目标 Turn 换轮：steer 不降级成新 Turn，也不写入新 Inbox。
    const stale = await sender.send({ groupId: f.groupId, threadId: f.root.id, requestId: "steer-2", mode: "steer", content: "过期引导", expectedTurnId: "turn-root" });
    await running(f, f.root.id, "turn-next");
    await f.host.claimDeliveries({ activeThreads: [f.root.id] });
    const blocked = (await f.store.readControl(f.groupId))!.deliveries.find(function target(item) { return item.messageId === stale.messageId; })!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("turn_not_running");
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toHaveLength(1);
  });

  /** 模拟宿主已领取 run，桥接只进入该执行的 Inbox，消费仍由运行时边界负责。 */
  it.each(["steer", "notify"] as const)("W1 claimed run 期间 %s 同 Turn 桥接且第二 run 仍排队", async function bridgesDuringClaimedRun(mode) {
    const f = await setup();
    const run = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run-first", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    const second = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run-second", mode: "run", content: "下一轮" });
    // Session 尚未进入 running 的启动窗口也由原 claimRun 互斥，第二 run 不得双启。
    expect(await f.host.claimDeliveries({ activeThreads: [] })).toEqual([]);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: second.messageId })).deliveryStatus).toBe("pending");
    await running(f, f.child.threadId, turnId);
    const input = { groupId: f.groupId, threadId: f.child.threadId, requestId: "bridge", mode, content: "补充约束", ...(mode === "steer" ? { expectedTurnId: turnId } : {}) };
    const sent = await f.service.send(input);
    expect((await f.service.send(input)).messageId).toBe(sent.messageId);
    expect(await f.host.claimDeliveries({ activeThreads: [f.child.threadId] })).toEqual([]);
    await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
    const inbox = await f.ports.inputInbox.list({ sessionId: f.child.threadId });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ clientMessageId: sent.messageId, turnId, delivery: "steer", status: "pending" });
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId })).deliveryStatus).toBe("delivered");
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: run.messageId })).deliveryStatus).toBe("claimed");
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: second.messageId })).deliveryStatus).toBe("blocked");
    expect(await f.ports.turnStore.list(f.child.threadId)).toHaveLength(1);
    const capability = createAgentInputInboxCapability(f.ports.inputInbox, f.child.threadId, turnId);
    expect(await capability.drain({ maxDelivery: "steer", boundary: "before_sample" })).toMatchObject([{ inputId: inbox[0].inputId, content: "补充约束" }]);
    expect((await f.ports.inputInbox.list({ sessionId: f.child.threadId }))[0]).toMatchObject({ status: "consumed", turnId });
    expect(await capability.drain({ maxDelivery: "steer", boundary: "before_sample" })).toEqual([]);
  });

  /** 非领取宿主即便声明目标活动，也不能借用其他 owner 的 run 桥接。 */
  it.each(["steer", "notify"] as const)("W1 claimed run 期间 %s 拒绝非 owner 桥接", async function rejectsForeignRunOwner(mode) {
    const f = await setup();
    await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await running(f, f.child.threadId, turnId);
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "bridge", mode, content: "补充", ...(mode === "steer" ? { expectedTurnId: turnId } : {}) });
    const other = createThreadDeliveryService(f.ports, f.store, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-b" });
    expect(await other.claimDeliveries({ activeThreads: [f.child.threadId] })).toEqual([]);
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual([]);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId })).deliveryStatus).toBe("pending");
    await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toHaveLength(1);
  });

  /** 当前 Session 必须仍匹配被领取 run 的 Turn，过期引导不能降级成新执行。 */
  it("W1 claimed run 的错 Turn 与迟到 steer 不进入 Inbox", async function rejectsWrongClaimedTurn() {
    const f = await setup();
    await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await running(f, f.child.threadId, turnId);
    const late = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "late", mode: "steer", expectedTurnId: turnId, content: "过期" });
    await running(f, f.child.threadId, "replacement-turn");
    const wrong = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "wrong-run-turn", mode: "steer", expectedTurnId: "replacement-turn", content: "另一轮" });
    expect(await f.host.claimDeliveries({ activeThreads: [f.child.threadId] })).toEqual([]);
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual([]);
    const deliveries = (await f.store.readControl(f.groupId))!.deliveries;
    expect(deliveries.find(function lateDelivery(item) { return item.messageId === late.messageId; })).toMatchObject({ status: "blocked", reason: "turn_not_running" });
    expect(deliveries.find(function wrongDelivery(item) { return item.messageId === wrong.messageId; })).toMatchObject({ status: "pending" });
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "completed", activeTurnId: undefined });
    expect(await f.host.claimDeliveries({ activeThreads: [] })).toEqual([]);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: wrong.messageId })).deliveryStatus).toBe("blocked");
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual([]);
  });

  /** Inbox 已落盘但桥接回执丢失时，重领仍沿稳定消息身份去重。 */
  it("W1 claimed run 期间桥接重试不重复输入", async function replaysBridgeIdempotently() {
    const f = await setup();
    await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行" });
    const claimed = (await f.host.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await running(f, f.child.threadId, turnId);
    const sent = await f.service.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "steer", mode: "steer", expectedTurnId: turnId, content: "补充" });
    const post = f.ports.inputInbox.post.bind(f.ports.inputInbox);
    // 模拟已持久化输入但宿主未得到应答，不伪造 consumed。
    f.ports.inputInbox.post = async function losesAcknowledgement(input) {
      await post(input);
      throw new Error("lost acknowledgement");
    };
    await expect(f.host.claimDeliveries({ activeThreads: [f.child.threadId] })).rejects.toThrow();
    const before = await f.ports.inputInbox.list({ sessionId: f.child.threadId });
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("pending");
    f.ports.inputInbox.post = post;
    await f.host.releaseDelivery({ groupId: f.groupId, messageId: sent.messageId });
    await f.host.claimDeliveries({ activeThreads: [f.child.threadId] });
    expect(await f.ports.inputInbox.list({ sessionId: f.child.threadId })).toEqual(before);
    expect((await f.service.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId })).inputId).toBe(before[0].inputId);
  });

  it("活动目标的多条 notify 各自保留消息身份，重试不重复注入", async function bridgesMultipleNotifies() {
    const f = await setup();
    await running(f, f.root.id, "turn-root");
    await running(f, f.child.threadId, "turn-child");
    const sender = createThreadService(f.ports, f.store, { ...f.context, actor: { kind: "thread", threadId: f.child.threadId, turnId: "turn-child" } });
    const first = await sender.send({ groupId: f.groupId, threadId: f.root.id, requestId: "notice-1", mode: "notify", content: "进展一" });
    const second = await sender.send({ groupId: f.groupId, threadId: f.root.id, requestId: "notice-2", mode: "notify", content: "进展二" });
    // 同一 requestId 重试沿用原消息身份，不新增投递。
    const retried = await sender.send({ groupId: f.groupId, threadId: f.root.id, requestId: "notice-1", mode: "notify", content: "进展一" });
    expect(retried.messageId).toBe(first.messageId);
    await f.host.claimDeliveries({ activeThreads: [f.root.id] });
    const inbox = await f.ports.inputInbox.list({ sessionId: f.root.id });
    expect(inbox).toHaveLength(2);
    expect(inbox.map(function id(item) { return item.clientMessageId; })).toEqual([first.messageId, second.messageId]);
    expect(inbox.map(function content(item) { return item.content; })).toEqual(["进展一", "进展二"]);
    expect(inbox.every(function mode(item) { return item.delivery === "steer"; })).toBe(true);
    const statuses = await Promise.all([first.messageId, second.messageId].map(function status(messageId) {
      return f.service.messageStatus({ groupId: f.groupId, threadId: f.root.id, messageId });
    }));
    expect(statuses.map(function state(item) { return item.deliveryStatus; })).toEqual(["delivered", "delivered"]);
    expect(statuses.map(function input(item) { return item.inputId; })).toEqual(inbox.map(function input(item) { return item.inputId; }));
    // 已交付的消息不会被再次领取或重复注入。
    await f.host.claimDeliveries({ activeThreads: [f.root.id] });
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toHaveLength(2);
  });

  it("Inbox 保留可信来源，同键不同正文或来源显式冲突", async function inboxOriginConflict() {
    const ports = createMemoryPorts();
    const capability = createAgentInputInboxCapability(ports.inputInbox, "session", "turn");
    await ports.inputInbox.post({ sessionId: "session", clientMessageId: "m1", delivery: "queue", content: "正文", origin: { kind: "thread", threadId: "other", turnId: "turn-other" } });
    const injected = await capability.drain({ maxDelivery: "queue", boundary: "before_sample" });
    expect(injected[0].origin).toEqual({ kind: "thread", threadId: "other", turnId: "turn-other" });
    await expect(ports.inputInbox.post({ sessionId: "session", clientMessageId: "m2", delivery: "queue", content: "a" })).resolves.toBeTruthy();
    await expect(ports.inputInbox.post({ sessionId: "session", clientMessageId: "m2", delivery: "queue", content: "b" })).rejects.toThrow("INBOX_INPUT_CONFLICT");
    await expect(ports.inputInbox.post({ sessionId: "session", clientMessageId: "m2", delivery: "queue", content: "a", origin: { kind: "thread", threadId: "forged" } })).rejects.toThrow("INBOX_INPUT_CONFLICT");
  });

  it("中断只持久化控制意图，绑定活动 Turn 且可重放", async function interruptIntent() {
    const f = await setup();
    await running(f, f.child.threadId, "turn-live");
    const input = { groupId: f.groupId, requestId: "interrupt", threadId: f.child.threadId, expectedTurnId: "turn-live" };
    const first = await f.service.interrupt(input);
    expect(first.accepted).toBe(true);
    expect(first.hostOffline).toBe(true);
    expect(await f.service.interrupt(input)).toMatchObject({ controlId: first.controlId, accepted: true });
    await expect(f.service.interrupt({ ...input, requestId: "other-turn", expectedTurnId: "turn-old" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    await expect(f.service.interrupt({ ...input, requestId: "mismatch-payload", threadId: f.root.id })).rejects.toMatchObject({ code: "THREAD_NOT_RUNNING" });
    const pending = await f.host.pendingInterrupts();
    expect(pending).toEqual([{ groupId: f.groupId, controlId: first.controlId, threadId: f.child.threadId, expectedTurnId: "turn-live" }]);
    await f.host.settleInterrupt({ groupId: f.groupId, controlId: first.controlId, applied: true });
    expect(await f.host.pendingInterrupts()).toEqual([]);
    const events = await f.service.listEvents({ groupId: f.groupId });
    expect(events.items.some(function terminal(event) { return event.kind === "turn_terminal"; })).toBe(true);
    // 接受命令不改变 Turn 状态，实际停止仍由 owner 执行。
    expect((await f.ports.turnStore.get("turn-live"))?.status).toBe("running");
  });

  it.each(["waiting_approval", "waiting_user_input"] as const)("真实%s等待态active为空且checkpoint一致时接受精确中断", async function interruptsWaiting(status) {
    const f = await setup();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status, activeTurnId: undefined });
    await f.ports.turnStore.save({ id: "turn-waiting", sessionId: f.child.threadId, status, frozenRunConfig: {}, startedAt: 1 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "turn-waiting", status: status === "waiting_approval" ? "awaiting_approval" : "awaiting_user_input", stepCount: 0, messages: [], completedCallIds: [] });
    const accepted = await f.service.interrupt({ groupId: f.groupId, requestId: "stop-waiting", threadId: f.child.threadId, expectedTurnId: "turn-waiting" });
    expect(accepted.accepted).toBe(true);
    const pending = await f.host.pendingInterrupts();
    expect(pending).toEqual([{ groupId: f.groupId, controlId: accepted.controlId, threadId: f.child.threadId, expectedTurnId: "turn-waiting" }]);
    expect((await f.ports.turnStore.get("turn-waiting"))?.status).toBe(status);
  });

  it("等待态拒绝错Session、旧Turn与不一致checkpoint，不落控制意图", async function waitingIdentityMismatch() {
    const f = await setup();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval", activeTurnId: undefined });
    await f.ports.turnStore.save({ id: "old", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 1 });
    await f.ports.turnStore.save({ id: "current", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 2 });
    await f.ports.turnStore.save({ id: "foreign", sessionId: f.root.id, status: "waiting_approval", frozenRunConfig: {}, startedAt: 3 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "current", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    const input = { groupId: f.groupId, threadId: f.child.threadId };
    await expect(f.service.interrupt({ ...input, requestId: "wrong-session", expectedTurnId: "foreign" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    await expect(f.service.interrupt({ ...input, requestId: "old-turn", expectedTurnId: "old" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "old", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    await expect(f.service.interrupt({ ...input, requestId: "wrong-checkpoint", expectedTurnId: "current" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    expect(await f.host.pendingInterrupts()).toEqual([]);
    expect((await f.ports.turnStore.get("current"))?.status).toBe("waiting_approval");
  });

  it("取消入口拒绝错Session和旧expected，不改新waiting轮", async function cancelIdentityGuard() {
    const f = await setup();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval", activeTurnId: undefined });
    await f.ports.turnStore.save({ id: "old", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 1 });
    await f.ports.turnStore.save({ id: "new", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 2 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "new", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    const runtime = createAgentRuntime({ ports: f.ports });
    await expect(runtime.turns.cancel({ sessionId: f.root.id, turnId: "new" })).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    await expect(runtime.turns.cancel({ sessionId: f.child.threadId, turnId: "old" })).rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH" });
    expect((await f.ports.sessionStore.get(f.child.threadId))?.status).toBe("waiting_approval");
    expect((await f.ports.checkpointStore.getLatest(f.child.threadId))?.turnId).toBe("new");
    expect((await f.ports.turnStore.get("new"))?.status).toBe("waiting_approval");
    expect((await f.ports.sessionStore.get(f.root.id))?.status).toBe("idle");
  });

});

describe("协作等待", function waitContract() {
  it("即时快照、超时与变化唤醒都不改变目标", async function observesOnly() {
    const f = await setup();
    const immediate = await f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id }], timeoutMs: 0 });
    expect(immediate.timedOut).toBe(false);
    expect(immediate.results[0].reason).toBe("snapshot");
    const cursor = immediate.results[0].cursor;

    const timed = await f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 60 });
    expect(timed.timedOut).toBe(true);
    expect(timed.results[0].reason).toBe("timeout");
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toEqual([]);
    expect(await f.ports.turnStore.list(f.root.id)).toEqual([]);

    const pending = f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 3000 });
    setTimeout(function sendLater() { void f.service.send({ groupId: f.groupId, threadId: f.root.id, requestId: "wake", mode: "notify", content: "进展" }); }, 40);
    const woken = await pending;
    expect(woken.timedOut).toBe(false);
    expect(woken.results[0].reason).toBe("changed");
    expect(woken.results[0].summary.messageCount).toBe(1);
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toEqual([]);
  });

  it("审批等待与非阻塞并行", async function attentionAndParallel() {
    const f = await setup();
    const cursor = (await f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id }], timeoutMs: 0 })).results[0].cursor;
    const waiting = f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 1200 });
    // 等待期间其他会话照常创建，不持有执行锁或存储写锁。
    const created = await f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId: "during-wait", title: "parallel" });
    expect(created.threadId).toBeTruthy();
    expect((await waiting).timedOut).toBe(true);

    const session = (await f.ports.sessionStore.get(f.root.id))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval" });
    const attention = await f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 0 });
    expect(attention.results[0].reason).toBe("attention");
    expect(attention.results[0].summary.sessionStatus).toBe("waiting_approval");
  });

  it("Abort 与游标域隔离", async function abortAndCursorDomain() {
    const f = await setup();
    const cursor = (await f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id }], timeoutMs: 0 })).results[0].cursor;
    const controller = new AbortController();
    const aborted = f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 5000, signal: controller.signal });
    setTimeout(function stop() { controller.abort(); }, 40);
    const result = await aborted;
    expect(result.results[0].reason).toBe("aborted");
    expect(result.timedOut).toBe(false);

    const otherRoot = await createSessionService(f.ports).create({ title: "second" });
    const other = createThreadService(f.ports, f.store, { ...f.context, stateRootId: "state-two" });
    await expect(other.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor }], timeoutMs: 0 })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
    await expect(f.service.wait({ groupId: f.groupId, targets: [{ threadId: otherRoot.id }], timeoutMs: 0 })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    await expect(f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id, cursor: "not-a-cursor" }], timeoutMs: 0 })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
    await expect(f.service.wait({ groupId: f.groupId, targets: [{ threadId: f.root.id }, { threadId: f.root.id }], timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
