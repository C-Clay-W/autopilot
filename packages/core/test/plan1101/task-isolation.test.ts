/** Plan1101 S2：对等授权、真实 run 任务归属与后续独立工作隔离，不调用 Provider。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadFacade } from "../../src/runtime/application/thread-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";

/** 保存精确执行事实，测试不建立第二个模型循环。 */
async function activate(ports: ReturnType<typeof createMemoryPorts>, sessionId: string, turnId: string, status: "running" | "completed" = "running") {
  const session = (await ports.sessionStore.get(sessionId))!;
  await ports.turnStore.save({ id: turnId, sessionId, status, frozenRunConfig: {}, startedAt: ports.clock.now() });
  await ports.sessionStore.save({ ...session, status, activeTurnId: status === "running" ? turnId : undefined });
}

/** 创建同域人类宿主及 A/B 授权范围。 */
async function setup() {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const a = await sessions.create({ title: "A" });
  const capability = { workspaceId: "w", stateRootId: "state", projectId: a.projectId!, allowedTools: ["create_thread", "report_progress", "read_progress"], modelCatalog: [], humanPrincipalId: "human" };
  const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "human" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: a.id });
  const b = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: a.id, requestId: "create-b" });
  return { ports, sessions, a, b, capability, human, groupId: group.groupId };
}

/** 模拟 Runner 已持久预留身份，或指定已有 Inbox 消费关联。 */
async function bind(f: Awaited<ReturnType<typeof setup>>, messageId: string, turnId: string, inputId?: string) {
  const control = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, control.revision, { ...control, revision: control.revision + 1, deliveries: control.deliveries.map(function task(item) { return item.messageId === messageId ? { ...item, status: "delivered" as const, reservedTurnId: turnId, turnId, ...(inputId ? { inputId } : {}) } : item; }) });
}

/** 发送新的明确委派，任务 ID 就是持久 run messageId。 */
async function run(f: Awaited<ReturnType<typeof setup>>, requestId: string) {
  const result = await f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, requestId, mode: "run", content: requestId });
  expect(result.taskId).toBe(result.messageId);
  return result.messageId;
}

describe("Plan1101 任务与范围", function taskIsolation() {
  /** 旧版会话进展缺少真实任务归属，升级后可查看且不得进入新任务页。 */
  it("升级前会话进展保留且不会归入新任务", async function preservesLegacyProgress() {
    const f = await setup();
    const taskId = await run(f, "new-task");
    const control = (await f.ports.threadStore.readControl(f.groupId))!;
    await f.ports.threadStore.compareAndSetControl(f.groupId, control.revision, { ...control, revision: control.revision + 1, progress: [{ threadId: f.b.threadId, progressSeq: 1, kind: "milestone", summary: "旧版结论", createdAt: 1 }], nextProgressSeq: { [f.b.threadId]: 2 } });
    const all = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId });
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ summary: "旧版结论" });
    expect(all.items[0].taskId).toBeUndefined();
    const task = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId });
    expect(task.items).toEqual([]);
  });

  it("按共同目标范围选择，多组显式选择；仅人类 owner 可关联组外同域目标", async function scopeSelection() {
    const f = await setup();
    const c = await f.sessions.create({ title: "C" });
    const d = await f.sessions.create({ title: "D" });
    const second = await f.human.enable({ protocolVersion: 1, rootThreadId: c.id, requestId: "enable-c" });
    await f.human.associate({ protocolVersion: 1, groupId: second.group.groupId, threadId: f.a.id, requestId: "join-a" });
    await activate(f.ports, f.a.id, "a-turn");
    const a = createThreadsToolBinding(f.ports, f.capability, { threadId: f.a.id, turnId: "a-turn" });
    expect((await a.read({ threadId: c.id })).thread.threadId).toBe(c.id);
    expect((await a.read({ threadId: f.b.threadId })).thread.threadId).toBe(f.b.threadId);
    await expect(a.read({ threadId: f.a.id })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    expect((await a.read({ threadId: f.a.id, groupId: f.groupId })).thread.threadId).toBe(f.a.id);
    await expect(a.read({ threadId: d.id })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    const threadFacade = createThreadFacade(f.ports, { ...f.capability, actor: { kind: "thread", threadId: f.a.id, turnId: "a-turn" } });
    await expect(threadFacade.associate({ protocolVersion: 1, groupId: f.groupId, threadId: d.id, requestId: "forbidden" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    const input = { protocolVersion: 1, groupId: second.group.groupId, threadId: d.id, requestId: "join-d" };
    expect(await f.human.associate(input)).toEqual(await f.human.associate(input));
    expect((await a.read({ threadId: d.id })).thread.threadId).toBe(d.id);
    const foreign = { ...d, id: "foreign", projectId: "other-project" };
    await f.ports.sessionStore.save(foreign);
    await expect(f.human.associate({ ...input, threadId: foreign.id, requestId: "cross-project" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    const outsider = createThreadFacade(f.ports, { ...f.capability, actor: { kind: "human", principalId: "other" } });
    await expect(outsider.associate({ ...input, requestId: "other-owner" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  });

  it("B 后续独立任务不回报旧任务；task wait 不取 Session latest，游标不可跨任务", async function independentWork() {
    const f = await setup();
    const first = await run(f, "first");
    await bind(f, first, "task-turn");
    await activate(f.ports, f.b.threadId, "task-turn");
    const b = createThreadsToolBinding(f.ports, f.capability, { threadId: f.b.threadId, turnId: "task-turn" });
    await b.reportProgress({ requestId: "p1", kind: "progress", summary: "第一项结论" });
    const page = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId: first });
    expect(page.items[0]).toMatchObject({ taskId: first, turnId: "task-turn", summary: "第一项结论" });
    await activate(f.ports, f.b.threadId, "task-turn", "completed");
    await activate(f.ports, f.b.threadId, "user-turn");
    const user = createThreadsToolBinding(f.ports, f.capability, { threadId: f.b.threadId, turnId: "user-turn" });
    await expect(user.reportProgress({ requestId: "independent", kind: "progress", summary: "用户私有后续任务" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    const tasks = await f.human.tasks({ protocolVersion: 1, groupId: f.groupId, threadId: f.a.id });
    // 本夹具的人类run没有冒充A发起；真实thread run才出现在A的任务条。
    expect(tasks.items).toEqual([]);
    await activate(f.ports, f.a.id, "a-source");
    const sender = createThreadsToolBinding(f.ports, f.capability, { threadId: f.a.id, turnId: "a-source" });
    const explicitTask = await sender.send({ requestId: "thread-task", threadId: f.b.threadId, mode: "run", content: "明确委派" });
    await bind(f, explicitTask.messageId, "task-turn");
    const taskFacts = await f.human.tasks({ protocolVersion: 1, groupId: f.groupId, threadId: f.a.id });
    expect(taskFacts.items[0]).toMatchObject({ taskId: explicitTask.messageId, turnId: "task-turn", turnStatus: "completed" });
    expect(JSON.stringify(taskFacts)).not.toContain("user-turn");
    const waiting = await f.human.wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: f.b.threadId, taskId: first }], timeoutMs: 0 });
    expect(waiting.results[0]).toMatchObject({ taskId: first, reason: "terminal", summary: { turnId: "task-turn", turnStatus: "completed" } });
    expect(JSON.stringify(waiting)).not.toContain("user-turn");
    const second = await run(f, "second");
    await bind(f, second, "second-turn");
    await activate(f.ports, f.b.threadId, "second-turn");
    const secondBinding = createThreadsToolBinding(f.ports, f.capability, { threadId: f.b.threadId, turnId: "second-turn" });
    await secondBinding.reportProgress({ requestId: "p2", kind: "progress", summary: "第二项结论" });
    await expect(f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId: second, cursor: page.cursor })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
    await expect(f.human.wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: f.b.threadId, taskId: second, cursor: waiting.results[0]!.cursor }], timeoutMs: 0 })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
    const all = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId });
    expect(all.items.map(function task(item) { return item.taskId; })).toEqual([first, second]);
    const empty = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId: first, cursor: page.cursor });
    expect(empty.items).toEqual([]);
  });

  it("Inbox 必须真实消费才绑定实际 Turn；同 Turn 多 run 拒绝默认回报", async function inboxIdentity() {
    const f = await setup();
    const task = await run(f, "queued");
    const input = await f.ports.inputInbox.post({ sessionId: f.b.threadId, clientMessageId: task, delivery: "queue", content: "queued" });
    await bind(f, task, "stale-predicted", input.inputId);
    const pending = await f.human.wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: f.b.threadId, taskId: task }], timeoutMs: 0 });
    expect(pending.results[0]!.summary.turnId).toBeUndefined();
    expect((await f.ports.inputInbox.claimNext({ sessionId: f.b.threadId }))?.inputId).toBe(input.inputId);
    await f.ports.inputInbox.consume({ sessionId: f.b.threadId, inputId: input.inputId, turnId: "actual-turn" });
    await activate(f.ports, f.b.threadId, "actual-turn");
    const b = createThreadsToolBinding(f.ports, f.capability, { threadId: f.b.threadId, turnId: "actual-turn" });
    await b.reportProgress({ requestId: "actual", kind: "milestone", summary: "来自真实消费" });
    const page = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId: task });
    expect(page.items[0]).toMatchObject({ turnId: "actual-turn", taskId: task });
    const another = await run(f, "ambiguous");
    await bind(f, another, "actual-turn");
    await expect(b.reportProgress({ requestId: "ambiguous-report", kind: "progress", summary: "不能静默归一" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  });

  it("task 摘要容量和 pendingProgress 保留已淘汰条目计数", async function boundedTaskProgress() {
    const f = await setup();
    const task = await run(f, "bounded");
    await bind(f, task, "bounded-turn");
    await activate(f.ports, f.b.threadId, "bounded-turn");
    const b = createThreadsToolBinding(f.ports, f.capability, { threadId: f.b.threadId, turnId: "bounded-turn" });
    for (let n = 0; n < 36; n++) await b.reportProgress({ requestId: "progress-" + n, kind: "progress", summary: "累计进度" + n });
    const page = await f.human.readProgress({ protocolVersion: 1, groupId: f.groupId, threadId: f.b.threadId, taskId: task });
    expect(page.compacted).toBe(4);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ progressSeq: 36, mergedCount: 32, taskId: task });
    const wait = await f.human.wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: f.b.threadId, taskId: task }], timeoutMs: 0 });
    expect(wait.results[0]!.pendingProgress).toBe(36);
  });
});
