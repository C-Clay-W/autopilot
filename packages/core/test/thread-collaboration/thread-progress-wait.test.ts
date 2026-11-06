/** 验证 wait 按进展游标唤醒：先订阅再复读、并发目标、跨进程复读、取消与终态优先；不启动目标。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadFacade } from "../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../src/runtime/application/thread-delivery-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";
import { createThreadTools } from "../../src/internal/tools/builtins/thread-tools";
import type { RuntimePorts, ThreadStore } from "../../src/runtime/ports";
import type { ToolExecutionContext } from "../../src/internal/tools/types";

/** 宿主授权目录：与 Web/CLI 宿主保持同一最小集合。 */
const THREAD_TOOL_NAMES = ["create_thread", "list_threads", "read_thread", "send_thread", "wait_threads", "read_shared_state", "update_shared_state", "report_progress", "read_progress", "interrupt_thread"];

/** 工具执行上下文：本轮不触发审批。 */
function contextOf(callId: string): ToolExecutionContext {
  return { permissionMode: "ask", toolCallId: callId };
}

/** 去掉可选的进程内订阅，模拟只能靠有界复读发现跨进程写入的存储。 */
function withoutSubscribe(store: ThreadStore): ThreadStore {
  return {
    verifyRequest: (id, groupId, digest) => store.verifyRequest(id, groupId, digest),
    reserveRequest: (id, groupId, digest) => store.reserveRequest(id, groupId, digest),
    withSessionLock: (threadId, operation) => store.withSessionLock(threadId, operation),
    hasMembership: (threadId) => store.hasMembership(threadId),
    readControl: (groupId) => store.readControl(groupId),
    writeEvent: (event) => store.writeEvent(event),
    readEvent: (groupId, seq) => store.readEvent(groupId, seq),
    writeMessage: (message) => store.writeMessage(message),
    readMessage: (groupId, threadId, seq) => store.readMessage(groupId, threadId, seq),
    compareAndSetControl: (groupId, expected, value) => store.compareAndSetControl(groupId, expected, value),
    listGroups: () => store.listGroups(),
  };
}

/** 记录订阅状态的存储包装：用于断言等待期间订阅不被提前解除。 */
function trackingStore(store: ThreadStore, state: { active: number; subscribes: number }): ThreadStore {
  const base = withoutSubscribe(store);
  const subscribe = store.subscribe?.bind(store);
  if (!subscribe) return base;
  return {
    ...base,
    subscribe(groupId: string, listener: () => void) {
      state.subscribes += 1;
      state.active += 1;
      const off = subscribe(groupId, listener);
      return function release() { state.active -= 1; off(); };
    },
  };
}

/** 直接在存储中放一个 running Turn，模拟该会话正在执行中的 Turn。 */
async function startRunningTurn(ports: RuntimePorts, sessionId: string, turnId: string): Promise<void> {
  await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now(), schemaVersion: 2 });
  const session = await ports.sessionStore.get(sessionId);
  await ports.sessionStore.save({ ...session!, status: "running", activeTurnId: turnId, updatedAt: ports.clock.now() });
}

/** 建立已启用协作组；子会话处于运行中，父会话用人类入口等待与读取。 */
async function setup(options?: { subscribe?: boolean; track?: { active: number; subscribes: number } }) {
  const ports = createMemoryPorts();
  if (options?.subscribe === false) ports.threadStore = withoutSubscribe(ports.threadStore);
  if (options?.track) ports.threadStore = trackingStore(ports.threadStore, options.track);
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const capability = { workspaceId: "workspace", stateRootId: "state-one", projectId: root.projectId!, allowedTools: THREAD_TOOL_NAMES, modelCatalog: [] };
  const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, title: "child", requestId: "create-child" });
  const task = await human.send({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, requestId: "run-child", mode: "run", content: "本次明确委派" });
  const control = (await ports.threadStore.readControl(group.groupId))!;
  await ports.threadStore.compareAndSetControl(group.groupId, control.revision, { ...control, revision: control.revision + 1, deliveries: control.deliveries.map(function bind(item) { return item.messageId === task.messageId ? { ...item, reservedTurnId: "turn-child", status: "claimed" as const } : item; }) });
  await startRunningTurn(ports, child.threadId, "turn-child");
  const tools = createThreadTools(createThreadsToolBinding(ports, capability, { threadId: child.threadId, turnId: "turn-child" }));
  /** 读取一次快照并返回该目标的等待游标。 */
  async function cursorOf(threadId: string): Promise<string> {
    const page = await human.wait({ protocolVersion: 1, groupId: group.groupId, targets: [{ threadId }], timeoutMs: 0 });
    return page.results[0]!.cursor;
  }
  return { ports, sessions, root, capability, human, group, child, tools, cursorOf };
}

describe("wait 按进展游标唤醒", function waitProgressContract() {
  it("新摘要唤醒只给计数，不重复消费同一游标", async function wakesOnProgress() {
    const f = await setup();
    const cursor = await f.cursorOf(f.child.threadId);
    const waiting = f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor }], timeoutMs: 3_000 });
    await f.tools.reportProgress.execute({ kind: "progress", summary: "读取完成，准备补测试" }, contextOf("call-p1"));
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.results[0]).toMatchObject({ reason: "progress", pendingProgress: 1 });
    // 等待结果只带状态与计数：摘要正文不进入唤醒结果。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("准备补测试");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(1024);
    // 回传同一游标不会重复唤醒。
    const repeated = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor: result.results[0]!.cursor }], timeoutMs: 60 });
    expect(repeated.timedOut).toBe(true);
    expect(repeated.results[0]?.reason).toBe("timeout");
  });

  it("并发目标各自按游标报告新摘要", async function concurrentTargets() {
    const f = await setup();
    const second = await f.human.create({ protocolVersion: 1, groupId: f.group.groupId, parentThreadId: f.root.id, title: "second", requestId: "create-second" });
    const task = await f.human.send({ protocolVersion: 1, groupId: f.group.groupId, threadId: second.threadId, requestId: "run-second", mode: "run", content: "第二个委派" });
    const control = (await f.ports.threadStore.readControl(f.group.groupId))!;
    await f.ports.threadStore.compareAndSetControl(f.group.groupId, control.revision, { ...control, revision: control.revision + 1, deliveries: control.deliveries.map(function bind(item) { return item.messageId === task.messageId ? { ...item, reservedTurnId: "turn-second", status: "claimed" as const } : item; }) });
    await startRunningTurn(f.ports, second.threadId, "turn-second");
    const secondTools = createThreadTools(createThreadsToolBinding(f.ports, f.capability, { threadId: second.threadId, turnId: "turn-second" }));
    const page = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId }, { threadId: second.threadId }], timeoutMs: 0 });
    // 两个目标同时写入不同类别的摘要，各自按自己的游标差量返回。
    await Promise.all([
      f.tools.reportProgress.execute({ kind: "milestone", summary: "子一关键结论" }, contextOf("call-c1")),
      secondTools.reportProgress.execute({ kind: "blocked", summary: "子二等待审批" }, contextOf("call-c2")),
    ]);
    const result = await f.human.wait({
      protocolVersion: 1,
      groupId: f.group.groupId,
      targets: [{ threadId: f.child.threadId, cursor: page.results[0]!.cursor }, { threadId: second.threadId, cursor: page.results[1]!.cursor }],
      timeoutMs: 3_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.results.map(function reason(item) { return item.reason; })).toEqual(["progress", "progress"]);
    expect(result.results.map(function count(item) { return item.pendingProgress; })).toEqual([1, 1]);
    expect(result.results[1]?.summary.progressCount).toBe(1);
  });

  it("等待期间保持订阅，写入后按进度唤醒并在结束时解除", async function holdsSubscription() {
    const track = { active: 0, subscribes: 0 };
    const f = await setup({ track });
    const cursor = await f.cursorOf(f.child.threadId);
    const waiting = f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor }], timeoutMs: 5_000 });
    // 让等待进入订阅与阻塞状态，此时订阅必须仍然有效（不能每轮复读后就解除）。
    await new Promise<void>(function tick(resolve) { setTimeout(resolve, 50); });
    expect(track.subscribes).toBe(1);
    expect(track.active).toBe(1);
    await f.tools.reportProgress.execute({ kind: "progress", summary: "等待期间的进展" }, contextOf("call-hold"));
    const result = await waiting;
    expect(result.results[0]).toMatchObject({ reason: "progress", pendingProgress: 1 });
    expect(track.active).toBe(0);
  });

  it("存储不提供订阅时靠有界复读发现新摘要", async function pollingFallback() {
    const f = await setup({ subscribe: false });
    const cursor = await f.cursorOf(f.child.threadId);
    const startedAt = Date.now();
    const waiting = f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor }], timeoutMs: 3_000 });
    await f.tools.reportProgress.execute({ kind: "progress", summary: "跨进程写入" }, contextOf("call-cross"));
    const result = await waiting;
    expect(result.results[0]).toMatchObject({ reason: "progress", pendingProgress: 1 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("取消立即结束等待且不改变目标执行", async function abortKeepsTarget() {
    const f = await setup();
    const cursor = await f.cursorOf(f.child.threadId);
    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor }], timeoutMs: 10_000, signal: controller.signal });
    setTimeout(function stop() { controller.abort(); }, 30);
    const result = await waiting;
    expect(result.results[0]?.reason).toBe("aborted");
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((await f.ports.sessionStore.get(f.child.threadId))?.status).toBe("running");
    expect((await f.ports.turnStore.get("turn-child"))?.status).toBe("running");
  });

  it("终态优先于新摘要，观察不启动也不恢复目标", async function terminalOutranksProgress() {
    const f = await setup();
    const cursor = await f.cursorOf(f.child.threadId);
    await f.tools.reportProgress.execute({ kind: "completed", summary: "子任务完成" }, contextOf("call-done"));
    const turn = await f.ports.turnStore.get("turn-child");
    await f.ports.turnStore.save({ ...turn!, status: "completed" });
    const result = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor }], timeoutMs: 3_000 });
    expect(result.timedOut).toBe(false);
    expect(result.results[0]).toMatchObject({ reason: "terminal", pendingProgress: 1 });
    expect(result.results[0]?.summary.turnStatus).toBe("completed");
    // 等待只观察：不新增 Turn，也不改写 Session 状态。
    expect(await f.ports.turnStore.list(f.child.threadId)).toHaveLength(1);
    expect((await f.ports.sessionStore.get(f.child.threadId))?.status).toBe("running");
  });

  it("相同审批关注游标阻塞，新审批调用代次立即唤醒", async function approvalGeneration() {
    const f = await setup();
    const turn = (await f.ports.turnStore.get("turn-child"))!;
    await f.ports.turnStore.save({ ...turn, status: "waiting_approval" });
    const checkpoint = { turnId: turn.id, status: "awaiting_approval" as const, stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "approve-one", name: "edit_file", input: {} }] };
    await f.ports.checkpointStore.save(f.child.threadId, checkpoint);
    const first = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId }], timeoutMs: 0 });
    expect(first.results[0].reason).toBe("attention");
    const started = Date.now();
    const repeated = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor: first.results[0].cursor }], timeoutMs: 60 });
    expect(repeated.timedOut).toBe(true); expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    await f.ports.checkpointStore.save(f.child.threadId, { ...checkpoint, pendingCalls: [{ id: "approve-two", name: "edit_file", input: {} }] });
    const next = await f.human.wait({ protocolVersion: 1, groupId: f.group.groupId, targets: [{ threadId: f.child.threadId, cursor: repeated.results[0].cursor }], timeoutMs: 1000 });
    expect(next.results[0].reason).toBe("attention"); expect(next.timedOut).toBe(false); expect(next.results[0].cursor).not.toBe(first.results[0].cursor);
  });

  it("密集进展不产生投递，notify 也不启动空闲目标", async function noPerItemDelivery() {
    const f = await setup();
    // setup 已有本次任务的 run 投递；冻结完整基线，进展不能增加或改写它。
    const baseline = structuredClone((await f.ports.threadStore.readControl(f.group.groupId))!.deliveries);
    const baselineIds = new Set(baseline.map(function identity(item) { return item.messageId; }));
    for (let n = 1; n <= 10; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `进度 ${n}` }, contextOf(`call-dense${n}`));
    const afterProgress = (await f.ports.threadStore.readControl(f.group.groupId))!;
    expect(afterProgress.deliveries).toEqual(baseline);
    expect(afterProgress.progress?.filter(function own(item) { return item.threadId === f.child.threadId; })).toHaveLength(10);
    const notification = await f.tools.sendThread.execute({ threadId: f.root.id, mode: "notify", content: "请查看结果" }, contextOf("call-notify"));
    const control = (await f.ports.threadStore.readControl(f.group.groupId))!;
    // 显式 notify 只能新增自身回执对应的投递，原任务基线必须完整保留。
    expect(control.deliveries.filter(function existing(item) { return baselineIds.has(item.messageId); })).toEqual(baseline);
    const added = control.deliveries.filter(function fresh(item) { return !baselineIds.has(item.messageId); });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ messageId: notification.messageId, threadId: f.root.id, mode: "notify", status: "pending" });
    expect(control.deliveries).toHaveLength(baseline.length + 1);
    const delivery = createThreadDeliveryService(f.ports, f.ports.threadStore, { workspaceId: "workspace", stateRootId: "state-one", ownerId: "host-a" });
    expect(await delivery.claimDeliveries({ activeThreads: [] })).toEqual([]);
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toEqual([]);
    expect((await f.ports.sessionStore.get(f.root.id))?.status).toBe("idle");
  });
});
