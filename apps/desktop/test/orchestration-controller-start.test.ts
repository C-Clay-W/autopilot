/** 用隔离账本与替身 Worker 验证编排主控首次附着、重试与历史切换。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeTrustPolicy } from "@autopilot-agent/adapters";
import { canonicalCheckout } from "../src/orchestration-admission";
import { OrchestrationDesktop } from "../src/orchestration-desktop";
import { batchDigest, orchestrationId } from "../src/orchestration-service";
import * as presentation from "../src/orchestration-presentation";
import type { OrchestrationRunView, OrchestrationUiCommand } from "../src/orchestration-contract";
import { ManagedTerminalHost } from "../src/managed-terminal-host";
import { ManagedRuntimeService, type ManagedRuntimeCommand, type ManagedRuntimeIdentity, type ManagedRuntimeReceipt } from "../src/managed-runtime-service";
import type { ManagedFactsHost } from "../src/managed-facts-host";
import type { ExecutionReference, OrchestrationAssignment, OrchestrationStep } from "../src/orchestration-store";
import type { DesktopWorkspace } from "../src/workspace";

/** 保留真实 Host 和事实账本，以可记录的 Worker 回执替代进程与模型。 */
async function fixture(trusted = true, target?: string) {
  const root = await mkdtemp(join(tmpdir(), "ap-controller-start-"));
  const directory = target ?? join(root, "checkout");
  const appRoot = join(root, "app");
  if (!target) await mkdir(directory);
  const checkout = await canonicalCheckout(directory);
  const workspace: DesktopWorkspace = { id: "workspace", name: "测试工作区", number: 1, directory, mode: "orchestration", activeTab: null };
  const creates: string[] = [];
  const commands: string[] = [];
  const handlers = new Set<(id?: string) => void>();
  const approvals: { operation: string; sessionId?: string; turnId?: string; approvalId?: string; questionId?: string; requestId: string; decision?: string }[] = [];
  const approvalState = new Map<string, "pending" | "decided" | "expired" | "running">();
  const questions = new Map<string, string>();
  let beforeResume: (() => Promise<void>) | undefined;
  let activeJobs = false;
  let acknowledgeApproval = true;
  let gapFor: string | undefined;
  let launches = 0;
  const approvalDecisions = new Map<string, string>();
  let failCreate = false;
  const desktop = new OrchestrationDesktop(appRoot, function workspaces() { return [workspace]; }, async function launch(channel) {
    launches++;
    channel.orchestrationTools = true;
    channel.isConnected = function connected() { return true; };
    channel.subscribe = function subscribe(listener) { handlers.add(listener); return function dispose() { handlers.delete(listener); }; };
    /** 模拟稳定的 create 身份和空闲 Session 的只读结果。 */
    channel.command = async function command(input: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>) {
      commands.push(`${input.operation}:${input.sessionId ?? ""}`);
      if (input.operation === "create") {
        creates.push(input.requestId);
        if (failCreate) { failCreate = false; throw new Error("MANAGED_REPLY_UNKNOWN"); }
        return { state: "confirmed", sessionId: orchestrationId(channel.identity.hostId, input.requestId) };
      }
      const approval = input.sessionId ? approvalState.get(input.sessionId) : undefined;
      const questionId = input.sessionId ? questions.get(input.sessionId) : undefined;
      const approvalId = `approval-${input.sessionId}`;
      const turnId = approval ? `turn-${input.sessionId}` : undefined;
      const status = approval === "running" ? "running" : approval ? questionId ? "waiting_user_input" : "waiting_approval" : "idle";
      const execution = approval === "running" ? "active" : "inactive";
      const interaction = approval && approval !== "running" ? { state: approval, ...(questionId ? { requestId: questionId } : { approvalId }) } : undefined;
      const waiting = questionId ? "user_input" : "approval";
      const snapshot = { protocol: 1, sessionId: input.sessionId, consistency: "overlap", execution: approval ? { turnId, status, execution, lastSeq: approval === "running" ? 2 : 1, ...(interaction ? { waiting, interaction } : {}) } : null };
      if (input.operation === "snapshot") return snapshot;
      if (input.operation === "read" && gapFor && input.sessionId === gapFor) { gapFor = undefined; throw new Error("THREAD_CURSOR_EXPIRED"); }
      if (input.operation === "read" || input.operation === "transcript") return { items: [] };
      if (input.operation === "inspect") return { lastSeq: snapshot.execution?.lastSeq, turnId, status, execution, activeJobs: !!approval && activeJobs, recoverable: !!interaction, checkpoint: !!interaction, threadPolicy: "disabled", jobs: [], ...(interaction ? { interaction: { state: interaction.state, ...(questionId ? { question: { requestId: questionId, questions: [] } } : { approval: { approvalId, decision: approvalDecisions.get(input.sessionId!), toolName: "write_file", reason: "test", display: { operation: "write" } } }) } } : {}) };
      if (input.operation === "activity") return { snapshot, activeJobs };
      if (input.operation === "lease_activity") return { sessionId: input.sessionId, turnId, status, execution, activeTurn: approval === "running", activeJobs, ...(interaction ? { waiting } : {}) };
      if (input.operation === "approval" || input.operation === "answer" || input.operation === "resume") {
        approvals.push(input);
        if (input.operation === "approval" && input.decision) approvalDecisions.set(input.sessionId!, input.decision);
        if (input.operation === "resume") await beforeResume?.();
        const state = input.operation === "resume" ? "started" : acknowledgeApproval ? "confirmed" : "unconfirmed";
        if (state !== "unconfirmed") approvalState.set(input.sessionId!, input.operation === "resume" ? "running" : "decided");
        return { requestId: input.requestId, sessionId: input.sessionId, turnId: input.turnId, operation: input.operation, state };
      }
      if (input.operation === "active_turns") return [];
      assert.fail(`意外的 Worker 操作 ${input.operation}`);
    };
  }, "test");
  const trust = createNodeTrustPolicy({ stateRoot: join(appRoot, "runtimes", orchestrationId(checkout)) });
  if (trusted) await trust.grantTrust(checkout);
  return {
    desktop, workspace, checkout, trust, creates, commands, approvals, approvalState, get launches() { return launches; },
    /** 模拟可信 Worker 通知和控制回执状态。 */
    notify(sessionId?: string) { for (const handler of handlers) handler(sessionId); },
    /** 发布可答问题并等真实事实宿主提交。 */
    async askQuestion(sessionId: string) {
      const id = `question-${sessionId}`;
      questions.set(sessionId, id);
      approvalState.set(sessionId, "pending");
      let unsubscribe!: () => void;
      const observed = new Promise<void>(function wait(resolve) { unsubscribe = desktop.subscribe(function changed(changedId) { if (changedId === sessionId) resolve(); }); });
      try { for (const handler of handlers) handler(sessionId); await observed; } finally { unsubscribe(); }
      return id;
    },
    /** 暂停单次 Worker 恢复以观察 GUI 决定回执已保存的中间状态。 */
    onResume(callback: () => Promise<void>) { beforeResume = callback; },
    /** 检查活动 Job 仍阻止自动恢复。 */
    keepJob() { activeJobs = true; },
    /** 未确认不能撤卡或开始续跑。 */
    loseApprovalReceipt() { acknowledgeApproval = false; },
    /** 拒绝一次原游标，以检验低频对账如何标记缺口。 */
    expireCursor(id: string) { gapFor = id; },
    /** 模拟创建回执未确认，下一次附着须按原请求恢复。 */
    failNextCreate() { failCreate = true; },
    /** 通过终端正常入口读取固定 Run 的首屏快照。 */
    async read(runId?: string) { return await desktop.terminalRequest(workspace.id, { operation: "read" }, runId) as { runId?: string; sessionId?: string; trustRequired?: boolean }; },
  };
}

/** 构造通过持久关系账本投影的计划委派。 */
function planned(checkout: string, id: string, predecessor?: string): { assignment: OrchestrationAssignment; step: OrchestrationStep } {
  return { assignment: { id, stepId: `step-${id}`, revision: 1, planVersion: 1, promptVersion: 1, createRequestId: `create-${id}`, startRequestId: `start-${id}`, checkout, access: predecessor ? "read" : "write", purpose: "initial", content: `执行 ${id}`, state: "planned", takeover: false, results: [], local: { source: "unknown", phase: "unknown", obligations: [], handoff: false, skills: [], requiredSkills: [], cooperation: [] } },
    step: { id: `step-${id}`, revision: 1, goal: `目标 ${id}`, scope: `范围 ${id}`, dependencies: predecessor ? [`step-${predecessor}`] : [], deliverables: [`${id}.txt`], acceptance: [], repairs: 0, currentAssignmentId: id } };
}

/** 同一 Run 绑定精确 Session/Turn 并用已登记 H2 事实驱动测试。 */
async function approvalFixture(t: import("node:test").TestContext, decision: "allow_once" | "deny" = "allow_once") {
  const fixtureState = await fixture(true, process.env.AP_ORCHESTRATION_TEST_CHECKOUT);
  const { desktop, workspace, checkout, read, approvalState } = fixtureState;
  t.after(function teardown() { desktop.close(); });
  const terminal = await read();
  const plan = planned(checkout, "executor");
  const execution = await desktop.store.update(function assign(ledger) {
    const run = ledger.runs.find(function same(r) { return r.id === terminal.runId; })!;
    const ref: ExecutionReference = { ...run.controller.execution!, sessionId: "executor-session", turnId: "turn-executor-session", requestId: "executor-start" };
    run.planVersion = 1;
    run.steps.push(plan.step);
    run.assignments.push({ ...plan.assignment, execution: ref, state: "active", checkoutYielded: true });
    return ref;
  });
  const runtime = (desktop as unknown as { runtimes: Map<string, { facts: ManagedFactsHost }> }).runtimes.get(checkout)!;
  await runtime.facts.register(execution.sessionId);
  const command = { type: "control", workspaceId: workspace.id, runId: terminal.runId, assignmentId: plan.assignment.id, revision: 0, executionToken: orchestrationId(JSON.stringify(execution)), requestId: "approval-command", operation: "approval", approvalId: "approval-executor-session", decision, continueAfterApproval: true } satisfies OrchestrationUiCommand;
  /** 模拟审批到达时等待受信通知，避免定时轮询掩盖缺失推送的回归。 */
  async function pendingApproval() {
    let unsubscribe!: () => void;
    const observed = new Promise<string | undefined>(function wait(resolve) { unsubscribe = desktop.subscribe(resolve); });
    approvalState.set(execution.sessionId, "pending");
    const started = performance.now();
    fixtureState.notify(execution.sessionId);
    try { assert.equal(await observed, execution.sessionId); } finally { unsubscribe(); }
    fixtureState.commands.length = 0;
    const view = (await desktop.snapshot(false, [execution.sessionId])).runs.find(function same(run) { return run.id === terminal.runId; })!;
    assert.ok(fixtureState.commands.filter(function inspect(operation) { return operation.startsWith("inspect:"); }).every(function exact(operation) { return operation === `inspect:${execution.sessionId}`; }));
    assert.equal(view.interactions?.[0]?.kind, "approval");
    assert.equal(view.interactions[0].state, "pending");
    assert.equal(view.assignments[0].inspection?.interaction?.approval?.approvalId, command.approvalId);
    t.diagnostic(`fixture: received and projected approval in ${(performance.now() - started).toFixed(1)} ms`);
  }
  return { ...fixtureState, execution, terminal, command, pendingApproval };
}

test("Desktop 定向：左栏优先显示当前执行者待审批，旧 Run 或断连不冒充待审批", function sidebarAction() {
  const run = { current: true, connected: true, controllerStatus: "completed", controllerExecution: "inactive", interactions: [{ assignmentId: "executor", state: "pending", kind: "approval" }] } as OrchestrationRunView;
  assert.match(presentation.workspaceRunStatus(run), /待审批/);
  assert.doesNotMatch(presentation.workspaceRunStatus({ ...run, current: false }), /待审批/);
  assert.doesNotMatch(presentation.workspaceRunStatus({ ...run, connected: false }), /待审批/);
});

test("执行者终端 Enter 复用精确审批与续跑，旧身份与重复请求不再次写入", { timeout: 15000 }, async function executorApproval(t) {
  const { desktop, workspace, execution, terminal, command, approvals, pendingApproval } = await approvalFixture(t);
  await pendingApproval();
  const target = { runId: terminal.runId!, assignmentId: command.assignmentId, sessionId: execution.sessionId };
  const expected = { sessionId: execution.sessionId, turnId: execution.turnId!, approvalId: command.approvalId };
  const approve = { operation: "cli", requestId: "enter-approval", executionToken: command.executionToken, action: { type: "approve", decision: "allow_once", expected } } as const;
  await assert.rejects(desktop.terminalRequest(workspace.id, { ...approve, action: { ...approve.action, expected: { ...expected, turnId: "old-turn" } } }, terminal.runId, target), /DESKTOP_IPC_DENIED/);
  const illegal = await desktop.terminalRequest(workspace.id, { ...approve, action: { ...approve.action, decision: "allow_workspace" } }, terminal.runId, target) as { kind: string };
  assert.equal(illegal.kind, "error");
  const response = await desktop.terminalRequest(workspace.id, approve, terminal.runId, target) as { lines: string[] };
  assert.match(response.lines[0], /已批准.*(决定已保存|正在核查|等待原请求回执|原任务已恢复)/);
  await desktop.terminalRequest(workspace.id, approve, terminal.runId, target);
  const stale = await desktop.terminalRequest(workspace.id, { ...approve, requestId: "duplicate-key" }, terminal.runId, target) as { lines: string[] };
  assert.match(stale.lines[0], /已批准/);
  assert.deepEqual(approvals.map(function operation(item) { return [item.operation, item.sessionId, item.turnId]; }), [["approval", expected.sessionId, expected.turnId], ["resume", expected.sessionId, expected.turnId]]);
});

test("执行者终端 Enter 区分已保存与续跑待核查", { timeout: 15000 }, async function executorApprovalPending(t) {
  const { desktop, workspace, execution, terminal, command, approvals, pendingApproval, keepJob } = await approvalFixture(t);
  await pendingApproval();
  keepJob();
  const target = { runId: terminal.runId!, assignmentId: command.assignmentId, sessionId: execution.sessionId };
  const response = await desktop.terminalRequest(workspace.id, { operation: "cli", requestId: "enter-approval", executionToken: command.executionToken,
    action: { type: "approve", decision: "deny", expected: { sessionId: execution.sessionId, turnId: execution.turnId!, approvalId: command.approvalId } } }, terminal.runId, target) as { lines: string[] };
  assert.match(response.lines[0], /已拒绝.*(决定已保存|正在核查|原任务已恢复)/);
  await desktop.command({ type: "inspect", workspaceId: command.workspaceId, runId: command.runId, revision: 0, assignmentId: command.assignmentId, executionToken: command.executionToken });
  assert.equal((await desktop.snapshot(false)).runs[0].approvalContinuations?.[0].resume?.code, "ORCHESTRATION_CONTINUE_PENDING");
  assert.deepEqual(approvals.map(function operation(item) { return item.operation; }), ["approval"]);
});

test("Desktop r003：Run 用精确待处理和委派活动状态，清除、历史或断连不会报活动", function runSummary() {
  const approval = { key: "req", assignmentId: "worker", sessionId: "session", turnId: "turn", requestId: "approval", state: "pending", kind: "approval" } as const;
  const run = { id: "run", current: true, connected: true, controllerStatus: "completed", controllerExecution: "inactive", assignments: [], pending: [], batches: [], interactions: [approval, approval] } as unknown as OrchestrationRunView;
  assert.equal(presentation.runStatus(run), "1 项待审批");
  assert.equal(presentation.workspaceRunStatus(run), presentation.runStatus(run));
  assert.equal(presentation.summarizeRunPending([run]).total, 1);
  const active = { ...run, controllerStatus: "waiting_approval", interactions: [], assignments: [{ native: "running" }] } as unknown as OrchestrationRunView;
  assert.equal(presentation.workspaceRunStatus(active), "执行中");
  assert.equal(presentation.summarizeRunPending([active]).total, 0);
  assert.doesNotMatch(presentation.workspaceRunStatus({ ...active, current: false }), /执行中/);
  const disconnected = { ...run, connected: false };
  assert.equal(presentation.runStatus(disconnected), "状态待核查");
  assert.equal(presentation.summarizeRunPending([disconnected]).approvals, 0);
  assert.equal(presentation.summarizeRunPending([disconnected]).unconfirmed, 1);
  assert.equal(presentation.summarizeRunPending([disconnected, run]).total, 1);
  const controllerQuestion = { ...approval, key: "question", assignmentId: undefined, kind: "question" as const };
  const questions = { ...run, interactions: [controllerQuestion], pending: [{ id: "intent", source: "host", reason: "controller_waiting" }] };
  assert.deepEqual(presentation.summarizeRunPending([questions]), { approvals: 0, questions: 1, unconfirmed: 0, intents: 0, batches: 0, total: 1 });
});

for (const role of ["controller", "executor"] as const) {
  test(`Desktop r003：${role} 保存原回答后只续跑一次，旧问题不能提交`, { timeout: 15000 }, async function answerOriginalTurn(t) {
    const setup = await approvalFixture(t);
    const sessionId = role === "executor" ? setup.execution.sessionId : setup.terminal.sessionId!;
    const questionId = await setup.askQuestion(sessionId);
    const view = (await setup.desktop.snapshot(false, [sessionId])).runs[0];
    assert.equal(view.interactions?.[0]?.kind, "question");
    const base = { workspaceId: setup.workspace.id, runId: setup.terminal.runId, requestId: "answer-command", operation: "answer" as const, continueAfterAnswer: true as const, questionId, answers: [{ id: "answer", selected: ["yes"] }] };
    const command: OrchestrationUiCommand = role === "executor" ? { ...base, type: "control", assignmentId: setup.command.assignmentId, revision: view.revision, executionToken: setup.command.executionToken } : { ...base, type: "controller", executionToken: view.controllerToken! };
    await assert.rejects(setup.desktop.command({ ...command, questionId: "old-question" }), /ORCHESTRATION_QUESTION_CHANGED/);
    assert.equal(setup.approvals.length, 0);
    await setup.desktop.command(command);
    if (role === "executor") await setup.desktop.command(command);
    else await assert.rejects(setup.desktop.command(command), /ORCHESTRATION_QUESTION_CHANGED/);
    assert.deepEqual(setup.approvals.map(function request(item) { return [item.operation, item.sessionId, item.turnId, item.questionId]; }), [
      ["answer", sessionId, `turn-${sessionId}`, questionId], ["resume", sessionId, `turn-${sessionId}`, questionId],
    ]);
    assert.equal((await setup.desktop.snapshot()).runs[0].interactions?.length, 0);
  });
}

test("Desktop r003：原回答未确认或活动 Job 阻拦时不续跑", { timeout: 15000 }, async function answerBoundaries(t) {
  for (const missingReceipt of [true, false]) {
    const setup = await approvalFixture(t);
    const questionId = await setup.askQuestion(setup.execution.sessionId);
    if (missingReceipt) setup.loseApprovalReceipt(); else setup.keepJob();
    const { approvalId, decision, continueAfterApproval, ...base } = setup.command;
    const command = { ...base, operation: "answer", questionId, answers: [{ id: "answer", selected: ["yes"] }], continueAfterAnswer: true };
    await assert.rejects(setup.desktop.command(command), missingReceipt ? /ORCHESTRATION_ANSWER_NOT_CONFIRMED/ : /ORCHESTRATION_ANSWER_SAVED_RESUME_PENDING/);
    assert.deepEqual(setup.approvals.map(function operation(item) { return item.operation; }), ["answer"]);
    assert.equal((await setup.desktop.snapshot()).runs[0].interactions?.length, missingReceipt ? 1 : 0);
  }
});

test("Desktop r003：Worker 执行前重新检查原问题、保存和 Job，原续跑只接纳一次", async function workerQuestionGuard() {
  const root = await mkdtemp(join(tmpdir(), "ap-question-worker-"));
  const identity = { protocol: 1, hostId: "host", owner: "owner", generation: "generation" } satisfies ManagedRuntimeIdentity;
  let state = "pending", jobs = false;
  const requests: string[] = [];
  const runtime = {
    sessions: { async get() { return { managedExecution: { hostId: identity.hostId, threadPolicy: "disabled" } }; } },
    facts: { async snapshot() { return { execution: { turnId: "turn", interaction: { requestId: "original", state } } }; } },
    jobs: { async hasActiveJobs() { return jobs; } },
    turns: { async *continue(input: { requestId: string }) { requests.push(input.requestId); yield { type: "turn_started" }; } },
  } as unknown as ConstructorParameters<typeof ManagedRuntimeService>[0];
  const worker = new ManagedRuntimeService(runtime, identity, join(root, "commands.json"), process.env.AP_ORCHESTRATION_TEST_CHECKOUT ?? root);
  const request = { ...identity, operation: "resume", sessionId: "session", turnId: "turn", questionId: "original" };
  /** 每种情况都进入真实受管 Worker 命令账本。 */
  async function resume(requestId: string, overrides?: Partial<typeof request>) {
    return await worker.dispatch({ ...request, requestId, ...overrides }, "human") as ManagedRuntimeReceipt;
  }
  assert.equal((await resume("pending")).code, "MANAGED_QUESTION_RESUME_UNAVAILABLE");
  state = "decided";
  assert.equal((await resume("changed", { questionId: "wrong" })).code, "MANAGED_QUESTION_RESUME_UNAVAILABLE");
  jobs = true;
  assert.equal((await resume("jobs")).code, "MANAGED_QUESTION_RESUME_UNAVAILABLE");
  jobs = false;
  assert.equal((await resume("original")).state, "started");
  assert.equal((await resume("original")).state, "started");
  assert.deepEqual(requests, ["original"]);
});

test("Desktop r003：主控和委派图形审批与问答保持原按钮，独立恢复无图形入口", async function graphicalInteraction() {
  const load = createRequire(__filename);
  const reactPath = load.resolve("react");
  const react = load(reactPath);
  const module = load.cache[reactPath]!;
  let cursor = 0;
  const states: unknown[] = [];
  module.exports = { ...react, useRef: function ref(initial: unknown) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index]; }, useState: function state(initial: unknown) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], function update(value: unknown) { states[index] = value; }];
  } };
  type Element = { props: { children?: unknown; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void } };
  /** 在 React element tree 中取可交互的图形控件。 */
  function elements(value: unknown): Element[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const element = value as Element;
    return [element, ...elements(element.props.children)];
  }
  try {
    const { OrchestrationActions, RunApprovals } = load("../src/OrchestrationActions.tsx") as typeof import("../src/OrchestrationActions");
    const run = { id: "run", workspaceId: "workspace", connected: true } as OrchestrationRunView;
    const approval = { state: "pending", approval: { approvalId: "approval", toolName: "write_file", reason: "test", display: {} } };
    const question = { state: "pending", question: { requestId: "question", questions: [{ id: "answer", header: "选择", question: "需要继续吗", options: [{ label: "是", description: "确认" }] }] } };
    for (const controller of [true, false]) {
      const controls: OrchestrationUiCommand[] = [];
      /** 由同一真实组件渲染不同交互阶段。 */
      function render(interaction?: typeof approval | typeof question, status = "waiting_approval") {
        cursor = 0;
        return elements(OrchestrationActions({ run, assignment: { id: "executor", state: "active", takeover: false, executionToken: "token", inspection: { turnId: "turn", status, execution: "inactive", recoverable: true, activeJobs: false, checkpoint: true, threadPolicy: "disabled", jobs: [], interaction } }, controller, controllerView: "question", async command(value) { controls.push(value); return true; } }));
      }
      states.length = 0;
      for (const snapshot of [render(approval), render({ ...approval, state: "decided" }), render(undefined, "interrupted")]) {
        assert.ok(!snapshot.some(function independentResume(item) { return item.props.children === "继续原 Turn"; }));
      }
      const showApproval = { turnId: "turn", status: "waiting_approval", execution: "inactive", recoverable: true, activeJobs: false, checkpoint: true, threadPolicy: "disabled", jobs: [], interaction: approval } as const;
      const full = { ...run, current: true, controllerId: "session", controllerToken: "token", controllerInspection: showApproval, assignments: controller ? [] : [{ id: "executor", sessionId: "session", state: "active", executionToken: "token", inspection: showApproval }],
        interactions: [{ key: "approval-key", assignmentId: controller ? undefined : "executor", sessionId: "session", turnId: "turn", requestId: "approval", kind: "approval", state: "pending" }] } as unknown as OrchestrationRunView;
      assert.equal(RunApprovals({ run: { ...full, connected: false }, id: "region", async command() { return true; } }), null);
      assert.equal(RunApprovals({ run: { ...full, current: false }, id: "region", async command() { return true; } }), null);
      assert.equal(RunApprovals({ run: { ...full, interactions: [{ ...full.interactions![0], state: "unconfirmed" }] }, id: "region", async command() { return true; } }), null);
      for (const label of ["仅本次批准", "拒绝"]) {
        states.length = 0; cursor = 0;
        const region = RunApprovals({ run: full, id: "region", async command(value) { controls.push(value); return true; } });
        const child = elements(region).find(function card(item) { return typeof (item as { type?: unknown }).type === "function"; }) as unknown as { type: (props: unknown) => unknown; props: unknown };
        const trigger = elements(child.type(child.props)).find(function button(item) { return item.props.children === label; })!.props.onClick!;
        trigger(); trigger();
      }
      states.length = 0;
      const questionView = render(question, "waiting_user_input");
      questionView.find(function field(item) { return !!item.props.onChange; })!.props.onChange!({ target: { value: "是" } });
      render(question, "waiting_user_input").find(function save(item) { return item.props.children === "保存答案"; })!.props.onClick!();
      assert.deepEqual(controls.map(function handoff(value) { return "operation" in value && [value.operation, "continueAfterApproval" in value, "continueAfterAnswer" in value]; }), [["approval", true, false], ["approval", true, false], ["answer", false, true]]);
    }
  } finally { module.exports = react; }
});

test("Desktop 定向：读取快照不会重复扫描空闲历史 Run 的 Worker", async function noIdleHistoryScan(t) {
  const { desktop, workspace, read, commands } = await fixture(true, process.env.AP_ORCHESTRATION_TEST_CHECKOUT);
  t.after(function close() { desktop.close(); });
  const first = await read();
  assert.ok(first.sessionId);
  await desktop.command({ type: "newTask", workspaceId: workspace.id, runId: first.runId });
  await desktop.snapshot();
  commands.length = 0;
  await desktop.snapshot();
  assert.deepEqual(commands.filter(function history(command) { return command.endsWith(`:${first.sessionId}`); }), []);
});

test("Desktop 定向：换代丢弃旧的尺寸请求，仍拒绝旧输入并暴露本代尺寸错误", async function staleResize() {
  const terminal = new ManagedTerminalHost(async function launch() { throw new Error("unexpected launch"); }, async function command() {});
  assert.equal(terminal.io("workspace", 1, "prepareResize", 90, 24), null);
  assert.equal(terminal.io("workspace", 1, "resize", 90, 24), undefined);
  assert.throws(function staleInput() { terminal.io("workspace", 1, "write", "text"); }, /MANAGED_TERMINAL_STALE/);
  assert.throws(function malformedResize() { terminal.io("workspace", 1, "resize", 0, 24); }, /DESKTOP_IPC_DENIED/);
  const clients = (terminal as unknown as { clients: Map<string, unknown> }).clients;
  const current = { generation: 2, exited: false, server: { close() {} }, sockets: [], pty: { resize() { throw new Error("real resize failure"); } } };
  clients.set("workspace", current);
  assert.throws(function currentResize() { terminal.io("workspace", 2, "resize", 90, 24); }, /real resize failure/);
  current.exited = true;
  let dimensions: [number, number] | undefined;
  const switched = terminal.switchRun("workspace", async function selectRun() {
    clients.set("workspace", { generation: 3, exited: false, pty: { resize(cols: number, rows: number) { dimensions = [cols, rows]; } } });
  });
  assert.equal(terminal.io("workspace", 2, "prepareResize", 95, 30), null);
  await switched;
  terminal.io("workspace", 2, "resize", 96, 30);
  assert.equal(dimensions, undefined);
  terminal.io("workspace", 3, "resize", 97, 30);
  assert.deepEqual(dimensions, [97, 30]);
});

for (const decision of ["allow_once", "deny"] as const) {
  test(`Desktop 定向：执行者 ${decision} 同击保存后立即撤卡，原 Turn 只恢复一次`, { timeout: 15000 }, async function continueApproval(t) {
    const { desktop, pendingApproval, command, execution, approvals, onResume } = await approvalFixture(t, decision);
    await pendingApproval();
    let started!: () => void;
    let release!: () => void;
    const resumeStarted = new Promise<void>(function notice(resolve) { started = resolve; });
    const resumeRelease = new Promise<void>(function hold(resolve) { release = resolve; });
    t.after(release);
    onResume(async function holdResume() { started(); await resumeRelease; });
    const begin = performance.now();
    const action = desktop.command(command);
    await Promise.race([resumeStarted, action]);
    try {
      const saved = (await desktop.snapshot(false)).runs[0];
      assert.deepEqual(saved.interactions, []);
      assert.notEqual(saved.assignments[0].inspection?.interaction?.state, "pending");
      assert.doesNotMatch(presentation.workspaceRunStatus(saved), /待审批/);
      t.diagnostic(`fixture: confirmation no longer pending before held resume finished, ${ (performance.now() - begin).toFixed(1)} ms since click`);
    } finally { release(); }
    await action;
    await desktop.command(command);
    assert.deepEqual(approvals.map(function exact(input) { return [input.operation, input.sessionId, input.turnId, input.approvalId, input.decision]; }), [
      ["approval", execution.sessionId, execution.turnId, command.approvalId, decision],
      ["resume", execution.sessionId, execution.turnId, command.approvalId, undefined],
    ]);
    const { leases } = await desktop.store.read();
    assert.ok(leases?.some(function resumed(lease) { return lease.assignmentId === command.assignmentId && lease.runId === command.runId; }));
  });
}

test("Desktop 定向：执行者审批过期、未知保存、活动 Job 分别保留安全边界", { timeout: 15000 }, async function approvalBoundaries(t) {
  const { desktop, execution, command, approvals, approvalState, pendingApproval, keepJob, loseApprovalReceipt } = await approvalFixture(t);
  await pendingApproval();
  approvalState.set(execution.sessionId, "expired");
  const expired = (await desktop.snapshot()).runs[0];
  assert.deepEqual(expired.interactions, []);
  await assert.rejects(desktop.command(command), /ORCHESTRATION_APPROVAL_CHANGED/);
  assert.equal(approvals.length, 0);
  await pendingApproval();
  keepJob();
  await desktop.command(command);
  await desktop.command({ type: "inspect", workspaceId: command.workspaceId, runId: command.runId, revision: 0, assignmentId: command.assignmentId, executionToken: command.executionToken });
  assert.equal((await desktop.snapshot(false)).runs[0].approvalContinuations?.[0].resume?.code, "ORCHESTRATION_CONTINUE_PENDING");
  assert.deepEqual(approvals.map(function operation(op) { return op.operation; }), ["approval"]);
  assert.deepEqual((await desktop.snapshot()).runs[0].interactions, []);
  assert.equal((await desktop.snapshot(false)).runs[0].assignments[0].inspection?.interaction?.state, "decided");
  const unknown = await approvalFixture(t);
  await unknown.pendingApproval();
  unknown.loseApprovalReceipt();
  await assert.rejects(unknown.desktop.command(unknown.command), /ORCHESTRATION_APPROVAL_NOT_CONFIRMED/);
  assert.deepEqual(unknown.approvals.map(function operation(op) { return op.operation; }), ["approval"]);
  assert.equal((await unknown.desktop.snapshot(false)).runs[0].interactions?.[0]?.state, "pending");
});

test("Desktop 定向：CLI 执行者批准后宿主自动继续原任务", { timeout: 15000 }, async function manualCliApproval(t) {
  const { desktop, workspace, terminal, command, approvals, pendingApproval } = await approvalFixture(t);
  await pendingApproval();
  const reply = await desktop.terminalRequest(workspace.id, { operation: "input", text: `/agent ${command.assignmentId} approve ${command.approvalId}`, requestId: "cli-approval" }, terminal.runId);
  assert.match(String(reply), /已批准/);
  for (let check = 0; check < 100 && !approvals.some(function resumed(c) { return c.operation === "resume"; }); check++) await new Promise(function wait(resolve) { setTimeout(resolve, 25); });
  assert.deepEqual(approvals.map(function operation(op) { return op.operation; }), ["approval", "resume"]);
});

test("Desktop 定向：待审批游标缺口按原 Session 对账，卡片降为待核查", { timeout: 15000 }, async function cursorGap(t) {
  const { desktop, execution, expireCursor, pendingApproval } = await approvalFixture(t);
  await pendingApproval();
  expireCursor(execution.sessionId);
  const view = (await desktop.snapshot()).runs[0];
  assert.equal(view.interactions?.[0]?.state, "unconfirmed");
  assert.equal(view.assignments[0].inspection, undefined);
  assert.doesNotMatch(presentation.workspaceRunStatus(view), /待审批/);
});

test("Desktop 定向：三人批次展示整份计划，校验版本摘要并在取消前后零派工", { timeout: 15000 }, async function batchConfirmation(t) {
  const { desktop, checkout, workspace, read, creates } = await fixture(true, process.env.AP_ORCHESTRATION_TEST_CHECKOUT);
  t.after(function close() { desktop.close(); });
  const terminal = await read();
  await desktop.store.update(function seal(ledger) {
    const run = ledger.runs[0];
    run.planVersion = 1;
    const plan = [planned(checkout, "alpha"), planned(checkout, "beta", "alpha"), planned(checkout, "gamma", "beta")];
    run.steps.push(...plan.map(function step(item) { return item.step; }));
    run.assignments.push(...plan.map(function assignment(item) { return item.assignment; }));
    const assignmentIds = run.assignments.map(function id(item) { return item.id; });
    run.batches = [{ assignmentIds, planVersion: 1, digest: batchDigest(run, assignmentIds), state: "pending" }];
  });
  const view = (await desktop.snapshot(false)).runs[0];
  const batch = view.batches[0];
  assert.equal(batch.reason, undefined);
  assert.equal(creates.length, 1);
  assert.deepEqual(batch.tasks.map(function task(task) { return [task.id, task.stepId, task.stepGoal, task.checkout, task.dependencies, task.deliverables, task.access, task.scope]; }), [
    ["alpha", "step-alpha", "目标 alpha", checkout, [], ["alpha.txt"], "write", "范围 alpha"],
    ["beta", "step-beta", "目标 beta", checkout, ["step-alpha"], ["beta.txt"], "read", "范围 beta"],
    ["gamma", "step-gamma", "目标 gamma", checkout, ["step-beta"], ["gamma.txt"], "read", "范围 gamma"],
  ]);
  await desktop.store.update(function recordReason(ledger) {
    const run = ledger.runs[0];
    const decision = { reason: "先实现、再由后继成员验证", digest: "decision", actions: [{ kind: "relation", action: { type: "seal" } }] as const, next: 1, expectedRevision: run.revision, state: "done" as const };
    run.pending = [{ id: "old-intent", at: "test", source: "human", kind: "prompt", state: "decided", basis: "old", promptVersion: 0, policyVersion: "test", decision: { ...decision, actions: [...decision.actions], reason: "其他任务的理由" } },
      { id: "current-intent", at: "test", source: "human", kind: "prompt", state: "decided", basis: "current", promptVersion: 0, policyVersion: "test", decision: { ...decision, actions: [...decision.actions] } }];
    run.records.push({ requestId: orchestrationId("current-intent", "0"), digest: "seal", at: "test", action: "seal" });
  });
  assert.equal((await desktop.snapshot(false)).runs[0].batches[0].reason, "先实现、再由后继成员验证");
  const approve = { type: "batch", workspaceId: workspace.id, runId: terminal.runId, revision: view.revision, planVersion: batch.planVersion, digest: batch.digest, approve: true } as const;
  await assert.rejects(desktop.command({ ...approve, digest: "old-digest" }), /ORCHESTRATION_BATCH_STALE/);
  await assert.rejects(desktop.command({ ...approve, planVersion: 0 }), /ORCHESTRATION_BATCH_STALE/);
  assert.equal((await desktop.snapshot(false)).runs[0].batches[0].state, "pending");
  await desktop.command({ ...approve, approve: false });
  const after = (await desktop.snapshot(false)).runs[0];
  assert.equal(after.batches[0].state, "cancelled");
  assert.equal(creates.length, 1);
  assert.ok(after.assignments.every(function unstarted(item) { return item.state === "planned" && !item.sessionId; }));
  await assert.rejects(desktop.command({ ...approve, revision: after.revision }), /ORCHESTRATION_BATCH_STALE/);
});

test("首次进入编排时，Run 显示后并发附着等待同一主控 Session", { timeout: 10_000 }, async function attachDuringInitialization(t) {
  const { desktop, workspace, read, creates } = await fixture();
  t.after(function close() { desktop.close(); });
  let publish!: () => void;
  let release!: () => void;
  const published = new Promise<void>(function observe(resolve) { publish = resolve; });
  const released = new Promise<void>(function hold(resolve) { release = resolve; });
  t.after(release);
  const update = desktop.store.update.bind(desktop.store);
  desktop.store.update = async function pauseAfterPublishing(mutate) {
    const result = await update(mutate);
    if (result && typeof result === "object" && "workspaceId" in result && result.workspaceId === workspace.id) {
      publish();
      await released;
    }
    return result;
  };

  const first = read();
  await Promise.race([published, first]);
  const before = await desktop.store.read();
  const runId = await desktop.selectedTerminalRunId(workspace.id);
  assert.ok(runId);
  assert.equal(before.runs[0].controller.execution, undefined);
  const readLedger = t.mock.method(desktop.store, "read", async function publishedLedger() { return structuredClone(before); });
  const reattached = read(runId);
  const repeated = read();
  await setImmediate();
  readLedger.mock.restore();
  release();
  const [original, explicit, implicit] = await Promise.all([first, reattached, repeated]);
  assert.equal(original.runId, runId);
  assert.ok(original.sessionId);
  assert.deepEqual(explicit, original);
  assert.deepEqual(implicit, original);
  const { runs } = await desktop.store.read();
  assert.equal(runs.length, 1);
  assert.equal(creates.length, 1);
  assert.equal(!!runs[0].controlOnly, false);
  assert.equal(runs[0].paused, false);
});

test("首次主控创建回执未确认后，重试复用 Worker、Run 和创建请求", async function retryIncompleteRun(t) {
  const controller = await fixture();
  t.after(function close() { controller.desktop.close(); });
  controller.failNextCreate();
  await assert.rejects(controller.read(), /MANAGED_REPLY_UNKNOWN/);
  const runId = await controller.desktop.selectedTerminalRunId(controller.workspace.id);
  assert.ok(runId);
  await controller.trust.revokeTrust(controller.checkout);
  await assert.rejects(controller.read(runId), /ORCHESTRATION_TRUST_REQUIRED/);
  assert.equal(controller.creates.length, 1);
  await controller.trust.grantTrust(controller.checkout);
  const terminal = await controller.read(runId);
  assert.equal(terminal.runId, runId);
  assert.strictEqual(controller.creates.length, 2);
  assert.equal(controller.creates[0], controller.creates[1]);
  assert.equal(controller.launches, 1);
  assert.ok(terminal.sessionId);
  assert.equal((await controller.desktop.store.read()).runs.length, 1);
});

test("Trust 后首次输入前只建空会话，显式新任务和历史切换保持各自主控", async function trustAndSwitch(t) {
  const { desktop, workspace, read, creates } = await fixture(false);
  t.after(function close() { desktop.close(); });
  assert.equal((await read()).trustRequired, true);
  assert.equal(creates.length, 0);
  await desktop.terminalRequest(workspace.id, { operation: "input", text: "/trust", requestId: "trust" });
  const first = await read();
  assert.ok(first.runId && first.sessionId);
  await desktop.command({ type: "newTask", workspaceId: workspace.id });
  const next = await read();
  assert.ok(next.runId && next.sessionId);
  assert.notEqual(next.runId, first.runId);
  assert.notEqual(next.sessionId, first.sessionId);
  await assert.rejects(read(first.runId), /ORCHESTRATION_RUN_MISMATCH/);
  await desktop.command({ type: "selectRun", workspaceId: workspace.id, runId: first.runId });
  assert.deepEqual(await read(first.runId), first);
  assert.equal(creates.length, 2);
});
