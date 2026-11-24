/** 1120 定向回归：受管终端身份、关闭布局、直输裁决、收尾门禁和模板映射。 */
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { IPty } from "node-pty";
import { attachManagedSessions, initialManagedLayout, leaves } from "../src/workspace";
import { ManagedTerminalHost } from "../src/managed-terminal-host";
import { OrchestrationStore, type ExecutionReference, type OrchestrationLedger, type OrchestrationRun } from "../src/orchestration-store";
import { OrchestrationService, orchestrationId, type RelationAction } from "../src/orchestration-service";
import { applyRelayAction, blockedExecutorInput, driveExecutorInputs, saveExecutorInput } from "../src/orchestration-relay";
import { driveFinishes, registerFinish, saveFinish } from "../src/orchestration-finish";
import { collectOrchestrationIntents, rebaseControllerCorrections } from "../src/orchestration-intents";
import { applyControllerDecision, saveControllerDecision } from "../src/orchestration-decisions";
import { assignmentInput } from "../src/orchestration-admission";
import { locateManagedSession, managedLayoutKey, managedTabRows, reconcileManagedLayout } from "../src/orchestration-layout";
import type { OrchestrationRunView } from "../src/orchestration-contract";
import { writeManagedRecord } from "../src/managed-runtime-store";
import type { ManagedRuntimeCommand, ManagedRuntimeIdentity } from "../src/managed-runtime-service";
import { ORCHESTRATION_TEMPLATES, orchestrationTemplateHeader, parseOrchestrationTemplate } from "../../cli/src/orchestration-templates";
import { ORCHESTRATION_REPORT_GUIDANCE, ORCHESTRATION_SKILL_HASH, ORCHESTRATION_SKILL_ID, withOrchestrationSkill } from "../src/orchestration-skill";

test("同工作区不同执行者的认证通道和代次隔离，切 Run 丢弃迟到输出", async function isolate(t) {
  const terminals: { env: Record<string, string>; writes: string[]; exit?: () => void }[] = [];
  const targets: string[] = [];
  const sockets: Socket[] = [];
  let selection = "run";
  let releaseRead!: () => void;
  let markReadEntered!: () => void;
  const readEntered = new Promise<void>(function mark(resolve) { markReadEntered = resolve; });
  const heldRead = new Promise<void>(function retain(resolve) { releaseRead = resolve; });
  const host = new ManagedTerminalHost(async function launch(env) {
    const terminal: typeof terminals[number] = { env, writes: [] };
    terminals.push(terminal);
    return {
      onData() {},
      onExit(listener: () => void) { terminal.exit = listener; },
      write(value: string) { terminal.writes.push(value); },
    } as unknown as IPty;
  }, async function request(_workspace, frame, runId, target) {
    assert.ok(target);
    targets.push(target.sessionId);
    if (frame.cursor === "late") { markReadEntered(); await heldRead; }
    return { runId, sessionId: target.sessionId };
  }, {
    async selected() { return selection; },
    async executor(_workspace, runId, assignmentId) { return { runId, assignmentId, sessionId: assignmentId + "-session" }; },
    ready() { assert.fail("执行者不能建立主控浏览器连接"); },
    closed() { assert.fail("执行者不能关闭主控浏览器连接"); },
  });
  t.after(async function clean() {
    releaseRead();
    for (const socket of sockets) socket.destroy();
    for (const terminal of terminals) terminal.exit?.();
    await host.close();
  });
  const [one, same, two] = await Promise.all([host.ensure("group", "run", "one"), host.ensure("group", "run", "one"), host.ensure("group", "run", "two")]);
  assert.deepEqual(one, same);
  assert.notEqual(one.id, two.id);
  assert.equal(terminals.length, 2);
  host.io("group", one.generation, "write", "first", undefined, one.id);
  host.io("group", two.generation, "write", "second", undefined, two.id);
  assert.deepEqual(terminals.map(function writes(p) { return p.writes; }).sort(), [["first"], ["second"]]);
  assert.throws(function outside() { host.io("other", one.generation, "write", "wrong", undefined, one.id); }, /DESKTOP_IPC_DENIED/);
  const frames: string[] = [];
  for (const terminal of terminals) {
    const socket = createConnection({ host: "127.0.0.1", port: Number(terminal.env.AUTOPILOT_MANAGED_PORT) });
    sockets.push(socket);
    socket.on("error", function stale() { /* 切换期间旧 socket 允许被撤销。 */ });
    if (socket === sockets[0]) socket.on("data", function response(chunk) { frames.push(String(chunk)); });
    socket.on("connect", function read() { socket.write(JSON.stringify({ id: "read", token: terminal.env.AUTOPILOT_MANAGED_TOKEN, operation: "read", cursor: socket === sockets[0] ? "late" : undefined }) + "\n"); });
  }
  await readEntered;
  for (const terminal of terminals) terminal.exit?.();
  await host.switchRun("group", async function select() { selection = "other-run"; });
  releaseRead();
  await tick();
  assert.throws(function late() { host.io("group", one.generation, "write", "stale", undefined, one.id); }, /MANAGED_TERMINAL_EXITED/);
  assert.deepEqual(frames, []);
  assert.ok(targets.every(function executor(session) { return ["one-session", "two-session"].includes(session); }));
});

test("两种布局后台补挂一次，手动关闭会话继续占用原编号", function layout() {
  const entries = [{ id: "b", sessionId: "session-b" }, { id: "c", sessionId: "session-c" }];
  const tabs = attachManagedSessions(initialManagedLayout(), entries, "tab");
  assert.deepEqual(tabs.tabs.map(function tab(t) { return t.number; }), [1, 2, 3]);
  assert.equal(tabs.activeTab, "controller");
  const split = attachManagedSessions(initialManagedLayout(), entries, "split");
  assert.equal(split.tabs.length, 1);
  assert.deepEqual(new Set(leaves(split.tabs[0].layout)), new Set(["controller", "b", "c"]));
  assert.equal(split.tabs[0].focused, "controller");
  split.sessions[1].closed = true;
  assert.equal(attachManagedSessions(split, entries, "tab"), split);
});

test("编排侧栏从可信状态汇总分屏并定位原 Tab，断线不显示运行", function sidebarTab() {
  const run: OrchestrationRunView = {
    id: "run-one", workspaceId: "workspace", revision: 1, goal: "完成页面", checkoutLabel: "test", controllerId: "controller-session",
    connected: true, paused: false, accepted: false, needsRecovery: false, current: true, controllerStatus: "idle", controllerExecution: "inactive",
    steps: [], pending: [], batches: [], assignments: [
      { id: "build", stepId: "build", content: "制作页面", state: "active", native: "running", source: "Core / H2", sessionId: "build-session", terminalSessionId: "build-session", takeover: false,
        occupied: true, local: { phase: "doing", source: "agent", handoff: false, obligations: [], skills: [], cooperation: [] }, results: [], controls: [], activity: [] },
    ],
  };
  const layout = reconcileManagedLayout(initialManagedLayout(), run, "split");
  assert.equal(layout.activeTab, "controller");
  assert.deepEqual(managedTabRows(run, layout).map(function state(t) { return [t.number, t.target, t.label, t.running]; }), [[1, "build", "执行中", true]]);
  const tabLayout = reconcileManagedLayout(initialManagedLayout(), run, "tab");
  assert.equal(managedTabRows(run, tabLayout)[1].target, "build");
  const next = locateManagedSession(tabLayout, "build");
  assert.equal(next.activeTab, "build");
  assert.equal(next.tabs[1].number, tabLayout.tabs[1].number);
  assert.equal(tabLayout.activeTab, "controller");
  assert.equal(locateManagedSession(initialManagedLayout(), "build").activeTab, "controller");
  assert.notEqual(managedLayoutKey(run), managedLayoutKey({ ...run, id: "run-two" }));
  assert.notEqual(managedLayoutKey(run), managedLayoutKey({ ...run, workspaceId: "next-workspace" }));
  run.interactions = [{ key: "gate", kind: "approval", sessionId: "controller-session", turnId: "turn", requestId: "gate", state: "pending" }];
  assert.deepEqual(managedTabRows(run, layout).map(function state(t) { return [t.target, t.label, t.running]; }), [["controller", "待审批", true]]);
  assert.equal(managedTabRows({ ...run, connected: false }, layout)[0].running, false);
  run.interactions = [];
  run.assignments[0].native = "completed";
  run.assignments[0].local.phase = "blocked";
  assert.equal(managedTabRows(run, layout)[0].label, "阻塞待处理");
});

test("旧阻塞决定只在原 Turn 与 Job 已核清后退役改派，并保留待独立复查", async function retryBlocked(t) {
  const previous = await setup(t);
  const { run, human, identity, channel } = previous;
  const trimmed = await human.command({ requestId: "cancel-other", expectedRevision: run.revision, action: { type: "cancelPlanned", assignmentId: "other" } });
  const started = await human.dispatch("source", trimmed.revision);
  const ref = started.assignments[0].execution!;
  let activeJobs = true, wrongTurn = false;
  let completedRef: ExecutionReference = ref;
  const service = new OrchestrationService(previous.service.store, { identity, async command(value) {
    if (value.operation === "activity" && value.sessionId === completedRef.sessionId) return {
      snapshot: { sessionId: completedRef.sessionId, execution: { turnId: wrongTurn ? "other-turn" : completedRef.turnId, execution: "inactive", result: "completed" } }, activeJobs,
    };
    return channel.command(value);
  } }, run.checkout);
  const controllerId = started.controller.execution!.sessionId;
  const controller = service.bind(run.id, { kind: "controller", sessionId: controllerId });
  const executor = service.bind(run.id, { kind: "executor", sessionId: ref.sessionId });
  const report = { id: "blocked", revision: 1, summary: "未完成", outcome: "blocked" as const, checks: [], unresolved: ["尚无真实产物"], evidence: [] };
  const local = { source: "agent" as const, phase: "blocked", handoff: false, obligations: ["制作页面"], skills: [], requiredSkills: [], cooperation: ["需继续制作"] };
  await executor.command({ requestId: "blocked-report", expectedRevision: started.revision, action: { type: "report", assignmentId: "source", execution: ref, revision: 1, local, result: report } });
  await service.store.update(function collect(ledger) { collectOrchestrationIntents(ledger.runs[0]); });
  const informed = await controller.snapshot();
  const intent = informed.pending!.find(function result(i) { return i.resultId === "blocked"; })!;
  await saveControllerDecision(service, run.id, controllerId, { intentId: intent.id, basis: intent.basis, expectedRevision: informed.revision, reason: "按阻塞报告重新制作", actions: [
    { kind: "release", assignmentId: "source" },
    { kind: "relation", action: { type: "replan", assignmentId: "source", resultId: "blocked", reason: "明确尚无可交付产物" } },
    { kind: "relation", action: { type: "assign", assignment: { id: "retry", stepId: "build", previousId: "source", purpose: "repair", access: "write", content: "继续制作页面" } } },
    { kind: "relation", action: { type: "seal" } },
    { kind: "dispatch", assignmentId: "retry" },
  ] });
  await service.store.update(function reopened(ledger) {
    const current = ledger.runs[0];
    current.pending!.find(function same(i) { return i.id === intent.id; })!.decision!.error = "ORCHESTRATION_RELEASE_UNCONFIRMED";
    current.revision++;
    rebaseControllerCorrections(current, current.revision - 1);
  });
  await applyControllerDecision(service, run.id, intent.id);
  const confirmPending = await controller.snapshot();
  assert.equal(confirmPending.pending!.find(function same(i) { return i.id === intent.id; })!.decision!.next, 0);
  assert.equal(confirmPending.assignments[0].state, "active");
  activeJobs = false;
  wrongTurn = true;
  await applyControllerDecision(service, run.id, intent.id);
  assert.equal((await controller.snapshot()).assignments[0].state, "active");
  wrongTurn = false;
  await assert.rejects(controller.release(confirmPending.revision, "source"), /ORCHESTRATION_RELEASE_HANDOFF_REQUIRED/);
  await applyControllerDecision(service, run.id, intent.id);
  await applyControllerDecision(service, run.id, intent.id);
  const repaired = await controller.snapshot();
  assert.equal(repaired.pending!.find(function same(i) { return i.id === intent.id; })!.decision!.state, "done");
  assert.equal(repaired.assignments[0].state, "cancelled");
  assert.deepEqual(repaired.assignments[0].retiredForRepair, { turnId: ref.turnId, resultId: report.id });
  assert.deepEqual(repaired.assignments[0].local, local);
  assert.deepEqual(repaired.assignments[0].results[0].unresolved, report.unresolved);
  assert.equal(repaired.assignments[0].completedReleaseTurnId, undefined);
  assert.equal(repaired.assignments[1].state, "planned");
  assert.equal(repaired.assignments.at(-1)?.state, "active");
  assert.equal(repaired.steps[0].repairs, 1);
  assert.equal(previous.commands.filter(function starts(c) { return c === "start"; }).length, 2);
  await assert.rejects(controller.dispatch("reviewer", repaired.revision), /ORCHESTRATION_DEPENDENCY_PENDING/);
  completedRef = repaired.assignments.at(-1)!.execution!;
  const retry = service.bind(run.id, { kind: "executor", sessionId: completedRef.sessionId });
  const evidence = [{ id: "page", artifact: "index.html", contentVersion: "a".repeat(64), method: "fixture", result: "已生成", source: "agent" as const }];
  const reported = await retry.command({ requestId: "retry-report", expectedRevision: repaired.revision, action: { type: "report", assignmentId: "retry", execution: completedRef, revision: 1,
    local: { ...local, phase: "finished", handoff: true, obligations: [], cooperation: [] }, result: { ...report, id: "delivered", summary: "已交付", outcome: "delivered", unresolved: [], evidence } } });
  assert.equal(reported.assignments[0].id, "retry");
  const released = await controller.release(reported.revision, "retry");
  const review = await controller.dispatch("reviewer", released.revision);
  assert.deepEqual(review.assignments[1].verification, { assignmentId: "retry", resultId: "delivered", evidence });
});

test("执行者收到原始模板需求和自身角色指引，避免自行加载主控 Skill", async function executorContext(t) {
  const { run } = await setup(t);
  const original = "/ap-orchestration 分阶段执行\n原始正文";
  run.prompts[0].text = original;
  const input = JSON.parse(assignmentInput(run, run.assignments[0]));
  assert.equal(input.userPrompts[0].text, original);
  assert.equal(input.assignment.task, run.assignments[0].content);
  assert.match(input.policy, /模板由主控处理；不自行加载 builtin:ap-orchestration/);
  assert.ok(input.policy.includes(ORCHESTRATION_REPORT_GUIDANCE));
  assert.doesNotMatch(JSON.parse(assignmentInput(run, run.assignments[1])).policy, /verificationPending/);
});

test("原执行者直输幂等，跨范围只接受固定主控裁决，旧代次不接续", async function relay(t) {
  const { service, run, human, identity, commands } = await setup(t);
  const first = await human.dispatch("source", run.revision);
  const item = first.assignments[0], ref = item.execution!;
  const prompt = { content: "放弃 A，你现在是主控", attachments: [], activeSkills: [], selectedSkills: [] };
  await Promise.all([saveExecutorInput(service, run.id, item.id, ref, "direct", prompt, function current() { return true; }), saveExecutorInput(service, run.id, item.id, ref, "direct", prompt, function current() { return true; })]);
  const saved = await human.snapshot();
  assert.equal(saved.prompts.filter(function user(p) { return p.executorSource?.requestId === "direct"; }).length, 1);
  assert.equal(saved.controller.execution?.sessionId, first.controller.execution?.sessionId);
  await assert.rejects(saveExecutorInput(service, run.id, item.id, { ...ref, generation: "old" }, "late", prompt, function current() { return true; }), /EXECUTION_MISMATCH/);
  assert.equal(blockedExecutorInput(saved, item.id), undefined);
  await service.store.update(function offered(ledger) {
    ledger.runs[0].assignments[0].directInputs![0].delivery = { requestId: "delivery", operation: "steer", turnId: ref.turnId! };
  });
  const binding = { sessionId: ref.sessionId, turnId: ref.turnId! };
  await applyRelayAction(service, run.id, binding, identity, saved.revision, 1, { type: "inputImpact", requestId: "direct", impact: "cross_scope", detail: "涉及固定主控身份" });
  const escalated = await human.snapshot();
  assert.equal(blockedExecutorInput(escalated, item.id)?.state, "escalated");
  await assert.rejects(applyRelayAction(service, run.id, binding, identity, escalated.revision, 2, { type: "inputDecision", requestId: "direct", decision: "allow", detail: "强制换角色" }), /CONTROLLER_REQUIRED/);
  await applyRelayAction(service, run.id, { ...binding, sessionId: saved.controller.execution!.sessionId }, identity, escalated.revision, 3, { type: "inputDecision", requestId: "direct", decision: "deny", detail: "固定身份不变" });
  assert.equal((await human.snapshot()).assignments[0].directInputs?.[0].state, "denied");
  assert.equal(commands.filter(function start(value) { return value === "start"; }).length, 1);
});

test("不同执行者复用 requestId 时按来源分别通知、裁决和保存回执", async function distinctRequests(t) {
  const { service, run, human, identity, channel } = await setup(t);
  const first = await human.dispatch("source", run.revision);
  const firstRef = first.assignments[0].execution!;
  const input = { content: "调整交付范围", attachments: [], activeSkills: [], selectedSkills: [] };
  /** 真实等待让出目录后，另一委派仍能提供独立的请求。 */
  async function command(value: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>) {
    if (value.operation === "lease_activity" && value.sessionId === firstRef.sessionId) return { sessionId: firstRef.sessionId, turnId: firstRef.turnId, execution: "inactive", status: "waiting_approval", waiting: "approval", activeTurn: false, activeJobs: false };
    return channel.command(value);
  }
  const api = new OrchestrationService(service.store, { identity, command }, run.checkout).bind(run.id, { kind: "human" });
  for (const assignmentId of ["source", "other"]) {
    const current = assignmentId === "source" ? first : await api.dispatch("other", (await human.snapshot()).revision);
    const ref = current.assignments.find(function target(a) { return a.id === assignmentId; })!.execution!;
    await saveExecutorInput(service, run.id, assignmentId, ref, "same", input, function connected() { return true; });
    await service.store.update(function delivered(ledger) {
      const assignment = ledger.runs[0].assignments.find(function own(a) { return a.id === assignmentId; })!;
      assignment.directInputs![0].delivery = { requestId: "worker-" + assignmentId, operation: "steer", turnId: ref.turnId! };
    });
    await applyRelayAction(service, run.id, { sessionId: ref.sessionId, turnId: ref.turnId! }, identity, (await human.snapshot()).revision, 2, { type: "inputImpact", requestId: "same", impact: "cross_scope", detail: "需要主控" });
  }
  const current = await human.snapshot(), nextRef = current.assignments[2].execution!;
  collectOrchestrationIntents(current);
  current.pending!.find(function legacy(i) { return i.assignmentId === "source" && i.detail?.startsWith("executor_input_impact: same ·"); })!.id = orchestrationId(run.id, "host", "same:impact", "");
  collectOrchestrationIntents(current);
  assert.deepEqual(current.pending?.filter(function impact(i) { return i.detail?.startsWith("executor_input_impact: same ·"); }).map(function owner(i) { return i.assignmentId; }), ["source", "other"]);
  const binding = { sessionId: current.controller.execution!.sessionId, turnId: "controller-turn" };
  const decision = { type: "inputDecision", requestId: "same", decision: "allow", detail: "仅补交现有范围" };
  await assert.rejects(applyRelayAction(service, run.id, binding, identity, current.revision, 3, decision), /ORCHESTRATION_REQUEST_CONFLICT/);
  await assert.rejects(applyRelayAction(service, run.id, binding, identity, current.revision, 3, { ...decision, assignmentId: "source", sessionId: nextRef.sessionId }), /ORCHESTRATION_EXECUTION_MISMATCH/);
  await applyRelayAction(service, run.id, binding, identity, current.revision, 3, { ...decision, assignmentId: "other", sessionId: nextRef.sessionId });
  const sent: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>[] = [];
  const replies = { identity, async command(value: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>) {
    if (value.operation === "activity") return { snapshot: { sessionId: nextRef.sessionId, execution: { turnId: nextRef.turnId, execution: "active" } }, activeJobs: false };
    if (value.operation === "steer") { sent.push(value); return { requestId: value.requestId, operation: "steer", state: "confirmed", sessionId: firstRef.sessionId, turnId: firstRef.turnId }; }
    if (value.operation === "query") return { requestId: value.targetRequestId, operation: "steer", state: "confirmed", sessionId: nextRef.sessionId, turnId: nextRef.turnId };
    return channel.command(value);
  } };
  await driveExecutorInputs(service, replies, await human.snapshot());
  assert.deepEqual(sent.map(function target(c) { return c.sessionId; }), [nextRef.sessionId]);
  assert.equal((await human.snapshot()).assignments[2].directInputs?.[0].returnDelivery?.receipt, undefined);
  await driveExecutorInputs(service, replies, await human.snapshot());
  const settled = await human.snapshot();
  assert.equal(settled.assignments[0].directInputs?.[0].state, "escalated");
  assert.equal(settled.assignments[0].directInputs?.[0].returnDelivery, undefined);
  assert.equal(settled.assignments[2].directInputs?.[0].returnDelivery?.receipt?.sessionId, nextRef.sessionId);
});

test("单项先冻结实现和独立复查，保留其他步骤并只结算一次", async function finishing(t) {
  const { service, run, human, channel } = await setup(t);
  const input = { requestId: "finish-source", source: run.controller.execution!, stepId: "build", text: "提前结束这项工作" };
  await saveFinish(service, run.id, input, function current() { return true; });
  await saveFinish(service, run.id, input, function current() { return true; });
  const stopped = await human.snapshot();
  assert.deepEqual(stopped.assignments.map(function state(a) { return a.state; }), ["cancelled", "cancelled", "planned"]);
  await assert.rejects(human.dispatch("reviewer", stopped.revision), /ORCHESTRATION_FINISHING/);
  await driveFinishes(service, channel, stopped);
  const settled = await human.snapshot();
  assert.equal(settled.finishes?.length, 1);
  assert.equal(settled.finishes?.[0].receipt?.results.length, 2);
  assert.ok(settled.finishes?.[0].receipt?.results.every(function unresolved(r) { return !r.accepted && r.unresolved.length > 0; }));
  const other = await human.dispatch("other", settled.revision);
  assert.equal(other.assignments[2].state, "active");
});

test("普通续跑预留后收尾先落盘时不发送，专用收尾通知仍能继续原会话", async function continueAfterFreeze(t) {
  const { service, run, human, identity, channel, commands } = await setup(t);
  const started = await human.dispatch("source", run.revision);
  const ref = started.assignments[0].execution!;
  const controller = started.controller.execution!;
  const finish = { requestId: "finish-racing", source: controller, stepId: "build", text: "结束实现" };
  const worker = { identity, async command(input: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>) {
    if (input.operation === "activity" && input.sessionId === ref.sessionId) return { snapshot: { sessionId: ref.sessionId, execution: { turnId: ref.turnId, execution: "inactive", result: "completed" } }, activeJobs: false };
    return channel.command(input);
  } };
  const racingStore = new OrchestrationStore(dirname(service.store.path), async function freezeBeforeSend(file, value) {
    const ledger = value as OrchestrationLedger;
    if (ledger.runs[0].assignments[0].execution?.requestId === "normal-continue" && !ledger.runs[0].finishes) registerFinish(ledger.runs[0], finish);
    await writeManagedRecord(file, ledger);
  });
  const racingService = new OrchestrationService(racingStore, worker, run.checkout);
  const api = racingService.bind(run.id, { kind: "controller", sessionId: controller.sessionId });
  await assert.rejects(api.continue("source", started.revision, "normal-continue", "另开新工作"), /ORCHESTRATION_FINISHING/);
  const frozen = await human.snapshot();
  assert.deepEqual(frozen.assignments[0].execution, ref);
  assert.equal(frozen.assignments[0].controls?.find(function same(c) { return c.requestId === "normal-continue"; })?.receipt.state, "rejected");
  await assert.rejects(api.continue("source", frozen.revision, "new-work", "另开新工作"), /ORCHESTRATION_FINISHING/);
  assert.equal(commands.filter(function start(c) { return c === "start"; }).length, 1);
  await driveFinishes(racingService, worker, frozen);
  const closing = await human.snapshot();
  const noticeId = frozen.finishes![0].targets[0].noticeId;
  assert.equal(closing.assignments[0].execution?.requestId, noticeId);
  assert.equal(closing.assignments[0].execution?.sessionId, ref.sessionId);
  assert.equal(commands.filter(function start(c) { return c === "start"; }).length, 2);
});

test("收尾核查已接纳未创建尝试的原请求，确证后释放且零 start", async function uncertainFinish(t) {
  const { service, run, human, identity, channel, commands } = await setup(t);
  await service.store.update(function admitted(ledger) {
    const current = ledger.runs[0];
    const item = current.assignments[0];
    const sessionId = orchestrationId(current.hostId, item.createRequestId);
    item.state = "submitted";
    item.submission = "create";
    item.execution = { ...identity, sessionId, requestId: item.startRequestId, turnId: orchestrationId(current.hostId, sessionId, item.startRequestId) };
    item.receipt = { requestId: item.createRequestId, state: "unconfirmed" };
    ledger.leases = [{ checkout: item.checkout, assignmentId: item.id, runId: current.id, access: "write" }];
  });
  await saveFinish(service, run.id, { requestId: "close-during-create", text: "结束整个 Run", source: run.controller.execution! }, function currentView() { return true; });
  const candidate = await human.snapshot();
  assert.equal(candidate.assignments[0].state, "submitted");
  let confirmedMissing = false;
  const verifier = { identity, async command(input: Parameters<Parameters<typeof driveFinishes>[1]["command"]>[0]) {
    if (input.operation === "query") return { requestId: input.targetRequestId, state: "unconfirmed", ...(confirmedMissing ? { code: "MANAGED_REQUEST_UNKNOWN" } : {}) };
    return channel.command(input);
  } };
  const finishService = new OrchestrationService(service.store, verifier, run.checkout);
  await driveFinishes(finishService, verifier, candidate);
  assert.equal((await human.snapshot()).finishes?.[0].receipt, undefined);
  assert.equal((await service.store.read()).leases?.length, 1);
  confirmedMissing = true;
  await driveFinishes(finishService, verifier, await human.snapshot());
  const done = await human.snapshot();
  assert.equal(done.assignments[0].state, "cancelled");
  assert.equal((await service.store.read()).leases?.length, 0);
  assert.ok(done.finishes?.[0].receipt);
  assert.equal(commands.includes("start"), false);
});

test("启动回执不移交职责，只有目标执行者的原 Turn 确认后接手", async function receive(t) {
  const { service, run, human, identity } = await setup(t, true);
  const active = await human.dispatch("source", run.revision);
  const ref = active.assignments[0].execution!;
  assert.equal(active.handoffs?.[0].received, undefined);
  const action = { type: "handoffReceived", requestId: "handoff" };
  await assert.rejects(applyRelayAction(service, run.id, { sessionId: ref.sessionId, turnId: "wrong-turn" }, identity, active.revision, 2, action));
  const binding = { sessionId: ref.sessionId, turnId: ref.turnId! };
  await applyRelayAction(service, run.id, binding, identity, active.revision, 3, action);
  const accepted = await human.snapshot();
  assert.equal(accepted.handoffs?.[0].received?.sessionId, ref.sessionId);
  assert.equal(accepted.controller.execution?.sessionId, run.controller.execution?.sessionId);
});

test("四模板精确匹配首行且保留 @ 文件正文，内置限定名校验正文 hash", async function template() {
  for (const flow of ORCHESTRATION_TEMPLATES) {
    const header = orchestrationTemplateHeader(flow.label);
    assert.deepEqual(parseOrchestrationTemplate(header + "\r\n核查 @docs/page.md\n"), { flow: flow.id, body: "核查 @docs/page.md\n" });
    assert.equal(parseOrchestrationTemplate("引用示例\n" + header), undefined);
    assert.equal(parseOrchestrationTemplate(header + " 附加标记"), undefined);
  }
  const loaded = await withOrchestrationSkill().loadSkill({ skill: ORCHESTRATION_SKILL_ID });
  assert.equal(loaded.contentHash, ORCHESTRATION_SKILL_HASH);
  assert.match(loaded.content, /handoffReceived/u);
  assert.ok(loaded.content.includes(ORCHESTRATION_REPORT_GUIDANCE));
  const guidance = JSON.parse(ORCHESTRATION_REPORT_GUIDANCE.split("\n\n")[1]);
  assert.deepEqual([guidance.local.handoff, guidance.local.obligations, guidance.local.cooperation], [true, [], []]);
  assert.deepEqual([guidance.result.outcome, guidance.result.verificationPending, guidance.result.unresolved], ["partial", true, []]);
  assert.match(ORCHESTRATION_REPORT_GUIDANCE, /新 Turn 用新 resultId/u);
});

/** 创建最小 schema 1 有依赖 Run，Runtime 命令由局部夹具回执承接。 */
async function setup(t: TestContext, withHandoff = false) {
  const directory = await mkdtemp(join(tmpdir(), "ap-1120-orchestration-"));
  t.after(async function clean() { await rm(directory, { recursive: true, force: true }); });
  const checkout = await realpath(directory);
  const identity = { protocol: 1 as const, hostId: "host", owner: "owner", generation: "generation" };
  const commands: string[] = [];
  const channel = { identity, async command(input: { operation: string; requestId: string; sessionId?: string }) {
    commands.push(input.operation);
    if (input.operation === "create") return { requestId: input.requestId, state: "confirmed", sessionId: orchestrationId(identity.hostId, input.requestId) };
    if (input.operation === "start") return { requestId: input.requestId, state: "started", sessionId: input.sessionId, turnId: orchestrationId(identity.hostId, input.sessionId!, input.requestId) };
    if (input.operation === "activity") return { snapshot: { sessionId: input.sessionId, execution: null }, activeJobs: false };
    return {};
  } };
  const service = new OrchestrationService(new OrchestrationStore(directory), channel, checkout);
  const initial = await service.open("workspace", checkout, "原始目标", { settingsVersion: "1", permissionVersion: "1", responsibility: "local", automaticDispatch: true, maxConcurrent: 3, versions: { app: "1", core: "1", protocol: "1", schema: "1" } });
  const human = service.bind(initial.id, { kind: "human" });
  let run: OrchestrationRun = await human.initialize();
  const step = { goal: "目标", scope: ".", dependencies: [], deliverables: ["产物"], acceptance: ["核查"] };
  const assignment = { purpose: "initial" as const, access: "read" as const, content: "任务" };
  const actions: RelationAction[] = [
    { type: "step", step: { ...step, id: "build" } },
    { type: "step", step: { ...step, id: "review", dependencies: ["build"], verifies: { stepId: "build" } } },
    { type: "step", step: { ...step, id: "other-step" } },
    { type: "assign", assignment: { ...assignment, id: "source", stepId: "build" } },
    { type: "assign", assignment: { ...assignment, id: "reviewer", stepId: "review" } },
    { type: "assign", assignment: { ...assignment, id: "other", stepId: "other-step" } },
  ];
  for (const action of actions) run = await human.command({ requestId: "setup-" + run.revision, expectedRevision: run.revision, action });
  if (withHandoff) run = await service.bind(initial.id, { kind: "controller", sessionId: run.controller.execution!.sessionId }).command({ requestId: "handoff", expectedRevision: run.revision, action: { type: "handoff", handoff: { assignmentId: "source", goal: "接手实现", background: "当前实现已冻结", artifacts: [], unresolved: ["检查"], scope: "." } } });
  run = await human.command({ requestId: "seal", expectedRevision: run.revision, action: { type: "seal" } });
  run = await human.command({ requestId: "approve", expectedRevision: run.revision, action: { type: "batchDecision", planVersion: run.planVersion, digest: run.batches![0].digest, approve: true } });
  return { service, run, human, identity, commands, channel };
}
