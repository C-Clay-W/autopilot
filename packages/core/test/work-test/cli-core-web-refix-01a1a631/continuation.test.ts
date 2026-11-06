/** S2 真实Node持久交互交接回归，采样受控，模拟宿主重建与首事件前失败。 */
import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createThreadDeliveryService } from "../../../src/runtime/application/thread-delivery-service";
import { createNodeRuntimePorts } from "../../../../adapters/src/node/create-node-runtime-ports";
import { createNodeThreadRunner } from "../../../../adapters/src/node/thread-runner";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";

/** 有界等待自有Runner的持久事实，失败不重复提交输入。 */
async function until(probe: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await probe()) return;
    await new Promise(function wait(resolve) { setTimeout(resolve, 20); });
  }
  throw new Error("controlled continuation timeout");
}

/** 建立独占Node状态根，源Runtime产生合法暂停，外端只能保存决定及持久交接。 */
async function fixture(kind: "approval" | "question", followup = false) {
  const evidence = path.resolve("../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/s23-states");
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(evidence, `${kind}-`));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const options = { stateRoot: path.join(root, "state"), workspaceRoot, env: {}, userSettingsPath: path.join(root, "settings.json"), trustRoot: path.join(root, "trust") };
  const ports = createNodeRuntimePorts(options);
  await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot, createdAt: Date.now(), updatedAt: Date.now() });
  await ports.sessionStore.save({ id: "target", productMode: "work", projectId: "project", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: "project", allowedTools: [], modelCatalog: [], humanPrincipalId: "user" };
  let samples = 0;
  let instance = 100;
  const sampler = { async sample() {
    samples++;
    if (samples === 1 || (followup && samples === 2)) return kind === "approval"
      ? { content: "", toolCalls: [{ id: `todo-${samples}`, name: "todo_write", input: { todos: [], fileTargets: [{ path: `controlled-${samples}.txt`, operation: "create" }] } }], reasoningSummary: "controlled" }
      : { content: "", toolCalls: [{ id: `question-${samples}`, name: "ask_user_question", input: { questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "小", description: "最小范围" }, { label: "全", description: "全部范围" }] }] } }], reasoningSummary: "controlled" };
    return { content: "done", toolCalls: [], reasoningSummary: "controlled" };
  } };
  /** 使用同一持久根重建宿主，冻结执行配置保持原样。 */
  function reopen(host = "web") {
    const nextPorts = createNodeRuntimePorts(options);
    const runtime = createAgentRuntime({ ports: nextPorts, enableUserQuestions: host === "web", defaultRunConfig: { modelSampler: sampler, permissionMode: "ask", workspaceRoot, workspaceTrusted: true, sandboxMode: "workspace-write", threads: { ...capability, executionHost: `${host}-work-v1` } } });
    const delivery = createThreadDeliveryService(nextPorts, nextPorts.threadStore, { workspaceId: "workspace", stateRootId: "state", executionHost: `${host}-work-v1`, ownerId: `${host}:workspace:${++instance}` });
    const errors: unknown[] = [];
    const runner = createNodeThreadRunner({ runtime, ports: nextPorts, delivery, pollIntervalMs: 25, onError: function error(error) { errors.push(error); } });
    return { runtime, ports: nextPorts, delivery, runner, errors };
  }
  const initial = reopen();
  const human = initial.runtime.threads.bind({ ...capability, executionHost: "web-work-v1", actor: { kind: "human", principalId: "user" } });
  const group = await human.enable({ protocolVersion: 1, rootThreadId: "target", requestId: "enable" });
  const events = [];
  for await (const event of initial.runtime.turns.start({ sessionId: "target", content: "controlled" })) events.push(event);
  const view = (await initial.runtime.turns.getExecutionState({ sessionId: "target" }))!;
  const request = events.find(function request(event) { return event.type === "approval_required" || event.type === "question_required"; })!;
  const identity = { sessionId: "target", turnId: view.turnId, ...(request.type === "approval_required" ? { approvalId: request.result.approval.approvalId } : request.type === "question_required" ? { requestId: request.requestId } : {}) };
  const foreign = reopen("cli");
  /** 两种人类决定均通过原服务持久校验。 */
  async function save() {
    if (identity.approvalId) await foreign.runtime.approvals.submit({ ...identity, approvalId: identity.approvalId, decision: "allow_once" });
    else await foreign.runtime.questions.submit({ ...identity, requestId: identity.requestId!, answers: [{ id: "scope", selected: ["小"] }] });
  }
  return { ...initial, foreign, identity, save, reopen, stateRoot: options.stateRoot, groupId: group.group.groupId };
}

it.each(["approval", "question"] as const)("S2 %s 保存后尚未交接即重开，两个入口同意图且原Turn只执行一次", async function savedBeforeHandoff(kind) {
  const f = await fixture(kind);
  await f.save();
  // 原直接跨宿主链确实拒绝，不能把S1门禁当成已自动恢复。
  await expect(f.foreign.runtime.turns.continue({ sessionId: "target", turnId: f.identity.turnId, requestId: f.identity.requestId })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  const reopened = f.reopen("cli");
  const receipts = await Promise.all([reopened.runtime.turns.requestInteractionContinuation!(f.identity), f.runtime.turns.requestInteractionContinuation!(f.identity)]);
  expect(receipts[0]).toMatchObject({ queued: true, controlId: receipts[1].controlId });
  expect((await reopened.runtime.turns.getExecutionState(f.identity))?.interaction?.continuation?.state).toBe("pending");
  const owner = f.reopen();
  try {
    await reopened.runner.start();
    expect((await reopened.ports.turnStore.get(f.identity.turnId))?.status).not.toBe("completed");
    await owner.runner.start();
    await until(async function completed() { return (await owner.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
    const events = await owner.ports.transcriptStore.getEvents("target");
    expect(events.filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === (kind === "approval" ? "todo-1" : "question-1"); })).toHaveLength(1);
    expect((await owner.ports.threadStore.readControl(f.groupId))!.controls.filter(function exact(item) { return item.kind === "continue_interaction"; })).toHaveLength(1);
    expect(owner.errors).toEqual([]);
  } finally { await reopened.runner.stop(); await owner.runner.stop(); }
});

it("S2 已领取首事件前失联，重建Runner仅在原边界安全重领", async function recoversClaimBeforeStart() {
  const f = await fixture("question");
  await f.save();
  const receipt = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  expect(await f.delivery.claimInteractionContinuation({ groupId: f.groupId, controlId: receipt.controlId! })).toBe(true);
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, controls: current.controls.map(function elapsed(item) { return { ...item, updatedAt: Date.now() - 60_000 }; }) });
  const owner = f.reopen();
  try {
    await owner.runner.start();
    await until(async function completed() { return (await owner.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
    const events = await owner.ports.transcriptStore.getEvents("target");
    expect(events.filter(function start(item) { return item.event.type === "turn_started"; })).toHaveLength(2);
  } finally { await owner.runner.stop(); }
});

it("S2 宿主首事件前失败显示failed，重试复用原决定并完成唯一工具结果", async function retriesFailedHandoff() {
  const f = await fixture("approval");
  await f.save();
  const receipt = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  const original = f.runtime.turns.continue;
  vi.spyOn(f.runtime.turns, "continue").mockImplementationOnce(async function* failBeforeStart() { throw new Error("injected-before-first-event"); });
  try {
    await f.runner.start();
    await until(async function failed() { return (await f.ports.threadStore.readControl(f.groupId))!.controls[0].status === "failed"; });
    expect((await f.runtime.turns.getExecutionState(f.identity))?.interaction?.continuation).toMatchObject({ state: "failed", failureCode: "CONTINUE_FAILED" });
    f.runtime.turns.continue = original;
    const retry = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
    expect(retry.controlId).toBe(receipt.controlId);
    f.runner.kick();
    await until(async function completed() { return (await f.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
    expect((await f.ports.transcriptStore.getEvents("target")).filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === "todo-1"; })).toHaveLength(1);
  } finally { await f.runner.stop(); vi.restoreAllMocks(); }
});

it("S2 宿主在已领取但首事件前退出，意图回pending后兼容Runner接手", async function stopsBeforeFirstEvent() {
  const f = await fixture("approval");
  await f.save();
  await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  const decision = await f.ports.approvalStore.getDecision({ ...f.identity, approvalId: f.identity.approvalId! });
  let release!: () => void;
  const gate = new Promise<void>(function wait(resolve) { release = resolve; });
  vi.spyOn(f.ports.approvalStore, "getDecision").mockImplementationOnce(async function delayedDecision() { await gate; return decision; });
  await f.runner.start();
  const stopping = f.runner.stop();
  release();
  await stopping;
  expect((await f.ports.threadStore.readControl(f.groupId))!.controls[0].status).toBe("pending");
  const owner = f.reopen();
  try {
    await owner.runner.start();
    await until(async function completed() { return (await owner.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
  } finally { await owner.runner.stop(); vi.restoreAllMocks(); }
});

it("S2 同Turn新问题已暂停，旧请求与旧checkpoint迟到不得重复继续", async function rejectsOldBoundary() {
  const f = await fixture("question", true);
  await f.save();
  await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  try {
    await f.runner.start();
    await until(async function nextQuestion() { const view = await f.runtime.turns.getExecutionState(f.identity); return view?.interaction?.state === "pending" && Boolean(view.interaction.requestId) && view.interaction.requestId !== f.identity.requestId; });
    const next = await f.runtime.turns.getExecutionState(f.identity);
    expect(next?.interaction?.state).toBe("pending");
    expect(next?.continuation).toBeUndefined();
    expect(next?.interaction?.continuation).toBeUndefined();
    // 等原交接运输结算后再注入迟到意图，避免夹具重写仍在结算的活动控制。
    await until(async function originalSettled() { return (await f.ports.threadStore.readControl(f.groupId))!.controls[0].status === "completed"; });
    const current = (await f.ports.threadStore.readControl(f.groupId))!;
    await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, controls: current.controls.map(function delayed(item) { return { ...item, status: "pending" }; }) });
    f.runner.kick();
    await until(async function settled() { return (await f.ports.threadStore.readControl(f.groupId))!.controls[0].status === "completed"; });
    await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
    expect((await f.runtime.turns.getExecutionState(f.identity))?.interaction?.requestId).toBe(next?.interaction?.requestId);
    expect((await f.ports.transcriptStore.getEvents("target")).filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === "question-1"; })).toHaveLength(1);
  } finally { await f.runner.stop(); }
});

it("S2 Node旧控制记录兼容，新交互控制读写校验拒绝损坏且保留原字节", async function controlCodec() {
  const f = await fixture("question");
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  const legacy = { ...current, revision: current.revision + 1, controls: [{ controlId: "old-resume", kind: "resume", threadId: "target", expectedTurnId: f.identity.turnId, status: "pending", createdAt: 1, updatedAt: 1 }] } as typeof current;
  expect(await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, legacy)).toBe(true);
  expect((await f.reopen().ports.threadStore.readControl(f.groupId))!.controls[0]).not.toHaveProperty("requestId");
  const invalid = { ...legacy, revision: legacy.revision + 1, controls: [{ ...legacy.controls[0], kind: "continue_interaction", requestId: f.identity.requestId }] } as typeof legacy;
  await expect(f.ports.threadStore.compareAndSetControl(f.groupId, legacy.revision, invalid)).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
  expect((await f.ports.threadStore.readControl(f.groupId))!.revision).toBe(legacy.revision);
  const controlPath = path.join(f.stateRoot, "threads/groups", f.groupId, "control.json");
  const corrupted = JSON.stringify(invalid);
  await writeFile(controlPath, corrupted);
  await expect(f.reopen().ports.threadStore.readControl(f.groupId)).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
  expect(await readFile(controlPath, "utf8")).toBe(corrupted);
});

it("S2 新交互控制遵守原组容量预算，失败不改旧数据或schema", async function controlCapacity() {
  const f = await fixture("question");
  await f.save();
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  const full = { ...current, revision: current.revision + 1, sharedState: { controlledPadding: "x".repeat(3 * 1024 * 1024) } };
  expect(await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, full)).toBe(true);
  await expect(f.foreign.runtime.turns.requestInteractionContinuation!(f.identity)).rejects.toMatchObject({ code: "THREAD_STORAGE_FULL" });
  const after = (await f.ports.threadStore.readControl(f.groupId))!;
  expect(after.revision).toBe(full.revision);
  expect(after.controls).toEqual([]);
  expect(JSON.parse(await readFile(path.join(f.stateRoot, "schema.json"), "utf8")).schemaVersion).toBe(8);
});

it.each(["approval", "question"] as const)("S2 %s 已写新lease但尚无turn_started，失联重建可恢复原暂停且唯一执行", async function recoversInitialCheckpoint(kind) {
  const f = await fixture(kind);
  await f.save();
  const receipt = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  expect(await f.delivery.claimInteractionContinuation({ groupId: f.groupId, controlId: receipt.controlId! })).toBe(true);
  const checkpoint = (await f.ports.checkpointStore.getLatest("target"))!;
  await f.ports.checkpointStore.save("target", { ...checkpoint, lease: { ...checkpoint.lease!, leaseId: "orphan-lease", ownerId: "orphan-owner", heartbeatAt: Date.now() - 60_000, safeBoundarySeq: 0 } });
  expect((await f.runtime.turns.getExecutionState(f.identity))?.continuation?.state).toBe("claimed");
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, controls: current.controls.map(function stale(item) { return { ...item, updatedAt: Date.now() - 60_000 }; }) });
  const owner = f.reopen();
  try {
    await owner.runner.start();
    await until(async function processed() { const control = (await owner.ports.threadStore.readControl(f.groupId))!.controls[0]; return control.status === "completed" || control.status === "failed"; });
    expect((await owner.ports.turnStore.get(f.identity.turnId))?.status).toBe("completed");
    const events = await owner.ports.transcriptStore.getEvents("target");
    expect(events.filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === (kind === "approval" ? "todo-1" : "question-1"); })).toHaveLength(1);
  } finally { await owner.runner.stop(); }
});

it("S2 兼容checkpoint迁移只改变预算元数据，不使已存交互意图永久失效", async function compatibleCheckpointMetadata() {
  const f = await fixture("question");
  await f.save();
  await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  const checkpoint = (await f.ports.checkpointStore.getLatest("target"))!;
  await f.ports.checkpointStore.save("target", { ...checkpoint, safetyBudgetVersion: undefined, runtimeBudget: { ...checkpoint.runtimeBudget!, startedAt: Date.now() } });
  const owner = f.reopen();
  try {
    await owner.runner.start();
    await until(async function processed() { const control = (await owner.ports.threadStore.readControl(f.groupId))!.controls[0]; return control.status === "completed" || control.status === "failed"; });
    expect((await owner.ports.turnStore.get(f.identity.turnId))?.status).toBe("completed");
  } finally { await owner.runner.stop(); }
});

it("S2 新执行事件已落盘而结果未确认时保留原决定并拒绝自动重放", async function keepsUnknownOutcome() {
  const f = await fixture("approval");
  await f.save();
  await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  const checkpoint = (await f.ports.checkpointStore.getLatest("target"))!;
  const events = await f.ports.transcriptStore.getEvents("target");
  const seq = events.at(-1)!.seq + 1;
  await f.ports.checkpointStore.save("target", { ...checkpoint, lease: { ...checkpoint.lease!, leaseId: "orphan-started", ownerId: "orphan-owner", heartbeatAt: Date.now() - 60_000, safeBoundarySeq: 0 } });
  await f.ports.transcriptStore.append("target", { sessionId: "target", turnId: f.identity.turnId, seq, timestamp: new Date().toISOString(), event: { type: "turn_started", turnId: f.identity.turnId, stepCount: checkpoint.stepCount } } as never);
  const continued = vi.spyOn(f.runtime.turns, "continue");
  try {
    await f.runner.start();
    const control = (await f.ports.threadStore.readControl(f.groupId))!.controls[0];
    expect(control).toMatchObject({ status: "failed", failureCode: "BOUNDARY_CHANGED" });
    expect(continued).not.toHaveBeenCalled();
    expect(await f.ports.approvalStore.getDecision({ ...f.identity, approvalId: f.identity.approvalId! })).toBeTruthy();
  } finally { await f.runner.stop(); vi.restoreAllMocks(); }
});

it("S2 Chat安全执行视图保持独立，不读取Work协作控制Store", async function chatScopeIndependent() {
  const ports = createMemoryPorts();
  await ports.sessionStore.save({ id: "chat", productMode: "chat", persistenceMode: "durable", status: "completed", createdAt: 1, updatedAt: 1 });
  await ports.turnStore.save({ id: "chat-turn", sessionId: "chat", status: "completed", startedAt: 1, frozenRunConfig: {} });
  await ports.checkpointStore.save("chat", { turnId: "chat-turn", status: "completed", stepCount: 1, messages: [], completedCallIds: [] });
  await ports.transcriptStore.append("chat", { sessionId: "chat", turnId: "chat-turn", timestamp: new Date().toISOString(), seq: 1, event: { type: "turn_completed", turnId: "chat-turn", stepCount: 1 } } as never);
  const groups = vi.spyOn(ports.threadStore, "listGroups").mockRejectedValue(new Error("THREADS_UNAVAILABLE"));
  const runtime = createAgentRuntime({ ports });
  expect((await runtime.turns.getExecutionState({ sessionId: "chat" }))?.result).toBe("completed");
  expect(groups).not.toHaveBeenCalled();
});
