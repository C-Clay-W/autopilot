/** r011执行边界回归：合法写入审批暂停必须在消费者继续迭代之前提交状态。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../../src/runtime/protocol";
import { createThreadService } from "../../../src/runtime/application/thread-service";

/** 使用任务专属目录与fake sampler，审批前不写业务文件，不访问Provider。 */
async function fixture(two = false) {
  const workspaceRoot = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r011", randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  const ports = createMemoryPorts(workspaceRoot);
  const session = await createSessionService(ports).create({ title: "r011行为" });
  let samples = 0;
  const defaultRunConfig = { workspaceRoot, workspaceTrusted: true, permissionMode: "ask" as const, maxSteps: 12, modelSampler: { async sample() {
    samples += 1;
    if (samples <= (two ? 2 : 1)) return { content: "", toolCalls: [{ id: `write-${samples}`, name: "write_file", input: { path: `file-${samples}.txt`, content: `value-${samples}` } }], reasoningSummary: "写入审批" };
    if (samples === (two ? 3 : 2)) return { content: "", toolCalls: Array.from({ length: two ? 2 : 1 }, function read(_, n) { return { id: `read-${n}`, name: "read_file", input: { path: `file-${n + 1}.txt` } }; }), reasoningSummary: "验证写入" };
    return { content: "已完成验证", toolCalls: [], reasoningSummary: "完成" };
  } } };
  const runtime = createAgentRuntime({ ports, defaultRunConfig });
  return { ports, session, runtime, defaultRunConfig };
}

/** 只消费到指定公开事件，故意保留生成器finally尚未执行的真实窗口。 */
async function through(stream: AsyncGenerator<AgentEvent>, type: AgentEvent["type"]) {
  while (true) { const next = await stream.next(); if (next.done) throw Error(`missing ${type}`); if (next.value.type === type) return next.value; }
}

/** 按Core安全投影的来源请求提交决定。 */
async function allow(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.runtime.turns.getExecutionState({ sessionId: f.session.id });
  const event = view?.interaction?.approval?.event;
  if (event?.type !== "approval_required") throw Error("missing current request");
  await f.runtime.approvals.submit({ sessionId: f.session.id, turnId: view!.turnId, approvalId: event.result.approval.approvalId, decision: "allow_once" });
  return { sessionId: f.session.id, turnId: view!.turnId, approval: { approvalId: event.result.approval.approvalId, decision: "allow" as const } };
}

it("write_file暂停已落盘时摘要不能等待消费者再次next", async function committedPauseBeforeYield() {
  const ports = createMemoryPorts(process.cwd());
  const session = await createSessionService(ports).create({ title: "r011隔离暂停" });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), permissionMode: "ask", modelSampler: { async sample() { return { content: "", toolCalls: [{ id: "write-r011", name: "write_file", input: { path: "r011-never-created.txt", content: "isolated" } }], reasoningSummary: "请求审批" }; } } } });
  const stream = runtime.turns.start({ sessionId: session.id, content: "隔离写入" });
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) throw Error("missing pause");
      if (next.value.type !== "turn_paused") continue;
      expect((await ports.checkpointStore.getLatest(session.id))?.status).toBe("awaiting_approval");
      expect((await ports.sessionStore.get(session.id))?.status).toBe("waiting_approval");
      expect((await ports.turnStore.getLatest(session.id))?.status).toBe("waiting_approval");
      break;
    }
  } finally { await stream.return(undefined); }
});

it("同Turn多次审批中旧生成器return不能清新执行代次或覆盖checkpoint", async function oldFinallyCannotRegress() {
  const f = await fixture(true);
  const first = f.runtime.turns.start({ sessionId: f.session.id, content: "两次独立写入" });
  let second: AsyncGenerator<AgentEvent> | undefined;
  try {
    await through(first, "turn_paused");
    const input = await allow(f);
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.interaction?.state).toBe("decided");
    second = f.runtime.turns.continue(input);
    await through(second, "turn_started");
    const lease = await f.ports.leaseStore.readCurrent!(f.session.id);
    await first.return(undefined);
    expect(await f.ports.leaseStore.readCurrent!(f.session.id)).toEqual(lease);
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.execution).toBe("active");
    await through(second, "turn_paused");
    const nextInput = await allow(f);
    expect(nextInput.approval.approvalId).not.toBe(input.approval.approvalId);
    const third = f.runtime.turns.continue(nextInput);
    const events = [];
    for await (const event of third) events.push(event);
    const checkpoint = await f.ports.checkpointStore.getLatest(f.session.id);
    await second.return(undefined);
    expect(await f.ports.checkpointStore.getLatest(f.session.id)).toEqual(checkpoint);
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.result).toBe("completed");
    expect(events.some(function done(event) { return event.type === "turn_completed"; })).toBe(true);
    const all = await f.ports.transcriptStore.getEvents(f.session.id);
    expect(all.filter(function writes(item) { return item.event.type === "tool_started" && item.event.toolName === "write_file"; })).toHaveLength(2);
    expect(new Set(all.map(function seq(item) { return item.seq; })).size).toBe(all.length);
  } finally { await first.return(undefined); await second?.return(undefined); }
});

it("暂停摘要存储失败明确上抛但保留可审批请求并能直接continue", async function failedSummaryDoesNotLoseRequest() {
  const f = await fixture();
  const saveSession = f.ports.sessionStore.save.bind(f.ports.sessionStore);
  const saveTurn = f.ports.turnStore.save.bind(f.ports.turnStore);
  let reject = true;
  f.ports.sessionStore.save = async function failWaiting(session) { if (reject && session.status === "waiting_approval") throw Error("injected-session-save"); await saveSession(session); };
  f.ports.turnStore.save = async function failWaiting(turn) { if (reject && turn.status === "waiting_approval") throw Error("injected-turn-save"); await saveTurn(turn); };
  const events = [];
  await expect(async function consume() { for await (const event of f.runtime.turns.start({ sessionId: f.session.id, content: "测试错误反馈" })) events.push(event); }).rejects.toThrow("injected-session-save");
  expect((await f.ports.sessionStore.get(f.session.id))?.status).toBe("running");
  expect((await f.ports.turnStore.getLatest(f.session.id))?.status).toBe("running");
  const view = await f.runtime.turns.getExecutionState({ sessionId: f.session.id });
  expect(view).toMatchObject({ execution: "inactive", waiting: "approval", interaction: { state: "pending" } });
  reject = false;
  const input = await allow(f);
  for await (const _event of f.runtime.turns.continue(input)) { /* 精确审批后直接续跑。 */ }
  expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.result).toBe("completed");
});

it("宿主暂停sink延迟不能阻断跨宿主审批也不能迟到回退终态", async function delayedSinkAcrossHosts() {
  const f = await fixture();
  let release: () => void = function noop() {};
  const held = new Promise<void>(function hold(resolve) { release = resolve; });
  let entered: () => void = function noop() {};
  const reached = new Promise<void>(function signal(resolve) { entered = resolve; });
  const write = f.ports.eventSink.write.bind(f.ports.eventSink);
  f.ports.eventSink.write = async function delayed(envelope) { await write(envelope); if (envelope.event.type === "turn_paused") { entered(); await held; } };
  const first = f.runtime.turns.start({ sessionId: f.session.id, content: "暂停sink" });
  const pending = through(first, "turn_paused");
  try {
    await reached;
    const other = createAgentRuntime({ ports: f.ports, defaultRunConfig: f.defaultRunConfig });
    expect(await other.turns.getExecutionState({ sessionId: f.session.id })).toMatchObject({ execution: "inactive", waiting: "approval", interaction: { state: "pending" } });
    const input = await allow(f);
    // 后继仍使用已冻结sampler；第二Runtime拥有独立activeTurns。
    for await (const _event of other.turns.continue(input)) { /* 独立宿主完成原任务。 */ }
    release(); await pending; await first.return(undefined);
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.result).toBe("completed");
  } finally { release(); await pending; await first.return(undefined); }
});

it("审批过期/错误目标/冻结参数改变/重复/取消分别保留安全边界", async function requestSafety() {
  const f = await fixture();
  const stream = f.runtime.turns.start({ sessionId: f.session.id, content: "安全边界" });
  try {
    await through(stream, "turn_paused");
    const view = (await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))!;
    const event = view.interaction!.approval!.event;
    if (event.type !== "approval_required") throw Error("missing request");
    const input = { sessionId: f.session.id, turnId: view.turnId, approvalId: event.result.approval.approvalId, decision: "allow_once" as const };
    await expect(f.runtime.approvals.submit({ ...input, sessionId: "wrong" })).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    const original = (await f.ports.checkpointStore.getLatest(f.session.id))!;
    const changed = structuredClone(original);
    changed.pendingCalls![0]!.input = { path: "different.txt", content: "changed" };
    await f.ports.checkpointStore.save(f.session.id, changed);
    await expect(f.runtime.approvals.submit(input)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await f.ports.checkpointStore.save(f.session.id, original);
    const now = f.ports.clock.now;
    f.ports.clock.now = function expired() { return Date.parse(event.result.approval.expiresAt) + 1; };
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.interaction?.state).toBe("expired");
    expect((await f.runtime.turns.getRecoverableState({ sessionId: f.session.id }))?.approval).toBeUndefined();
    await expect(f.runtime.approvals.submit(input)).rejects.toBeDefined();
    f.ports.clock.now = now;
    await f.runtime.approvals.submit(input);
    await expect(f.runtime.approvals.submit(input)).rejects.toMatchObject({ code: "APPROVAL_ALREADY_SUBMITTED" });
    expect((await f.runtime.turns.getRecoverableState({ sessionId: f.session.id }))?.interactionState).toBe("decided");
    await f.runtime.turns.cancel({ sessionId: f.session.id, turnId: view.turnId });
    await stream.return(undefined);
    expect(await f.runtime.turns.getExecutionState({ sessionId: f.session.id })).toMatchObject({ result: "interrupted", execution: "inactive" });
    await f.ports.checkpointStore.save(f.session.id, { ...original, status: "running" });
    expect(await f.runtime.turns.getExecutionState({ sessionId: f.session.id })).toMatchObject({ result: "interrupted", execution: "inactive" });
  } finally { await stream.return(undefined); }
});

it("无执行所有权或失联不冒称运行/成功，终态不被旧running快照覆盖", async function ownershipAndLateSnapshot() {
  const f = await fixture();
  const stream = f.runtime.turns.start({ sessionId: f.session.id, content: "执行所有权" });
  try {
    await through(stream, "turn_started");
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.execution).toBe("active");
    const lease = (await f.ports.leaseStore.readCurrent!(f.session.id))!;
    const now = f.ports.clock.now;
    f.ports.clock.now = function stale() { return lease.lease.heartbeatAt + 45001; };
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.execution).toBe("lost");
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.result).toBeUndefined();
    f.ports.clock.now = now;
    await f.ports.leaseStore.release({ sessionId: f.session.id, lease: lease.lease });
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.execution).toBe("unconfirmed");
    await stream.return(undefined);
  } finally { await stream.return(undefined); }
});

it("父wait共用暂停事实，Session/Turn摘要落后时仍返回attention审批", async function waitUsesSameFacts() {
  const f = await fixture();
  const root = await createSessionService(f.ports).create({ title: "父会话" });
  const threads = createThreadService(f.ports, f.ports.threadStore, { workspaceId: "w", stateRootId: "s", projectId: root.projectId!, actor: { kind: "human", principalId: "user" }, allowedTools: [], modelCatalog: [] });
  const group = await threads.enable({ rootThreadId: root.id, requestId: "enable-r011" });
  await threads.associate({ groupId: group.group.groupId, threadId: f.session.id, requestId: "associate-r011" });
  const stream = f.runtime.turns.start({ sessionId: f.session.id, content: "等待审批" });
  try {
    await through(stream, "turn_paused");
    const session = (await f.ports.sessionStore.get(f.session.id))!;
    const turn = (await f.ports.turnStore.getLatest(f.session.id))!;
    await f.ports.sessionStore.save({ ...session, status: "running", activeTurnId: turn.id });
    await f.ports.turnStore.save({ ...turn, status: "running" });
    const result = await threads.wait({ groupId: group.group.groupId, targets: [{ threadId: f.session.id }], timeoutMs: 0 });
    expect(result.results[0]).toMatchObject({ reason: "attention", summary: { turnStatus: "waiting_approval", waiting: "approval", interactionState: "pending" } });
  } finally { await stream.return(undefined); }
});
