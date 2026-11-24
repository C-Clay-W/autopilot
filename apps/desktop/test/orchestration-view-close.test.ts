/** 用隔离账本和薄客户端替身验证编排视图的关闭保护。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { IPty } from "node-pty";
import { ManagedTerminalHost, type ManagedCloseTarget } from "../src/managed-terminal-host";
import type { ManagedLeaseActivity, ManagedRuntimeCommand, ManagedRuntimeIdentity } from "../src/managed-runtime-service";
import { OrchestrationDesktop } from "../src/orchestration-desktop";
import { OrchestrationService } from "../src/orchestration-service";
import type { OrchestrationAssignment, OrchestrationRun } from "../src/orchestration-store";
import { saveViewCloseProgress } from "../src/orchestration-view-close";
import { closeManagedSessions, locateManagedSession } from "../src/orchestration-layout";
import { attachManagedSessions, initialManagedLayout, leaves, type DesktopWorkspace } from "../src/workspace";

/** 使用独立账本保留真实事务，Worker 只替代状态查询和持久报告的投递。 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ap-view-close-"));
  const workspace: DesktopWorkspace = { id: "group", directory: root, name: "夹具", number: 1, activeTab: null, mode: "orchestration" };
  const identity = { protocol: 1, hostId: "host", owner: "owner", generation: "generation" } as const;
  const controller = { ...identity, sessionId: "controller-session", requestId: "con-start" };
  const worker = { ...identity, sessionId: "worker-session", requestId: "exec-start", turnId: "worker-turn" };
  const assignment: OrchestrationAssignment = { id: "worker", stepId: "step", revision: 1, planVersion: 1, promptVersion: 1, execution: worker,
    createRequestId: "create", startRequestId: "exec-start", purpose: "initial", content: "实现", checkout: root, access: "write", state: "active", takeover: false,
    local: { source: "agent", phase: "working", obligations: ["完成验证"], handoff: false, skills: [], requiredSkills: [], cooperation: [] }, results: [] };
  const run: OrchestrationRun = { id: "run", workspaceId: workspace.id, hostId: identity.hostId, checkout: root, goal: "任务", revision: 3, planVersion: 1,
    policy: { settingsVersion: "test", permissionVersion: "test", responsibility: "controller", maxConcurrent: 2, repairLimit: 2, automaticDispatch: false, versions: { app: "test", core: "test", protocol: "1", schema: "1" } },
    controller: { createRequestId: "main-create", execution: controller, threadPolicy: "disabled", executor: "ap" }, prompts: [], steps: [], assignments: [assignment], paused: false, acceptance: "pending", records: [] };
  const current = new Map<string, ManagedLeaseActivity>([{ ...controller, turnId: "controller-turn" }, worker].map(function activity(ref) {
    return [ref.sessionId, { sessionId: ref.sessionId, turnId: ref.turnId, status: "running", execution: "active", activeTurn: true, activeJobs: false }];
  }));
  const activity = current.get(worker.sessionId)!;
  const steers: string[] = [];
  const queries: string[] = [];
  let delivered = true;
  let sendReport: Promise<void> | undefined;
  let beforeReceipt: (() => Promise<void>) | undefined;
  const desktop = new OrchestrationDesktop(root, function groups() { return [workspace]; }, async function unexpectedLaunch() { assert.fail("关闭不得启动 Worker"); }, "test");
  const channel = { identity, isConnected() { return true; }, async command(input: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>, human?: boolean) {
    if (input.operation === "lease_activity") return current.get(input.sessionId!);
    if (input.operation === "active_turns") return [];
    if (input.operation === "steer") {
      assert.equal(human, undefined);
      assert.equal(input.sessionId, worker.sessionId);
      assert.equal(input.turnId, worker.turnId);
      assert.match(input.content!, new RegExp(input.requestId));
      steers.push(input.requestId);
      await beforeReceipt?.();
      if (delivered) sendReport = setImmediate().then(async function report() {
        const payload = { requestId: input.requestId, progress: "实现已落盘", completed: ["修改"], remaining: ["验证"], conclusion: "正在验证" };
        await assert.rejects(saveViewCloseProgress(service, run.id, assignment.id, { ...worker, turnId: "old-turn" }, payload), /EXECUTION_MISMATCH/);
        await saveViewCloseProgress(service, run.id, assignment.id, worker, payload);
      });
      return { requestId: input.requestId, operation: "steer", sessionId: input.sessionId, turnId: input.turnId, state: delivered ? "accepted" : "unconfirmed" };
    }
    if (input.operation === "query") {
      assert.equal(input.targetRequestId, steers.at(-1));
      assert.notEqual(input.requestId, input.targetRequestId);
      queries.push(input.requestId);
      return { requestId: input.targetRequestId, state: queries.length === 1 ? "submitted" : "unconfirmed" };
    }
    assert.fail(`未预期的 Worker 操作 ${input.operation}`);
  } };
  const service = new OrchestrationService(desktop.store, channel, root);
  const runtimes = (desktop as unknown as { runtimes: Map<string, { service: OrchestrationService; channel: typeof channel }> }).runtimes;
  runtimes.set(root, { service, channel });
  const lease = { checkout: root, runId: run.id, assignmentId: assignment.id, access: "write" as const };
  await desktop.store.update(function seed(ledger) { ledger.runs.push(run); ledger.leases = [lease]; });
  t.after(async function clean() { try { await sendReport; } finally { await rm(root, { recursive: true, force: true }); } });
  return { desktop, activity, steers, queries, run, lease, worker, runtimes, loseReceipt() { delivered = false; }, holdReceipt(wait: () => Promise<void>) { beforeReceipt = wait; } };
}

const workerView: ManagedCloseTarget = { id: "worker", viewId: "view-1", sessionId: "worker-session" };

test("整批最后视图与删除工作区阻止待审批、待回答、活动 Job 和未知身份", async function protection(t) {
  const { desktop, activity, runtimes, run } = await fixture(t);
  for (const status of [
    { status: "waiting_approval", waiting: "approval", activeJobs: false },
    { status: "waiting_user_input", waiting: "user_input", activeJobs: false },
    { status: "completed", waiting: undefined, activeJobs: true },
    { status: "unknown", waiting: undefined, activeJobs: false },
  ]) {
    Object.assign(activity, { execution: "inactive", activeTurn: false }, status);
    await assert.rejects(desktop.prepareViewsClose("group", "run", [workerView], function last() { return false; }, function open() { return true; }, async function confirm() { assert.fail("不应确认最后活动视图"); }), /ORCHESTRATION_(?:LAST_ACTIVE_TERMINAL|VIEW_CLOSE_UNKNOWN)/);
    await assert.rejects(desktop.removeWorkspace("group", async function stop() { assert.fail("不应删除包含受保护终端的工作区"); }), /ORCHESTRATION_WORKSPACE_TERMINALS_ACTIVE/);
  }
  runtimes.delete(run.checkout);
  await assert.rejects(desktop.removeWorkspace("group", async function stop() { assert.fail("离线不能确认现有 Session 安全"); }), /ORCHESTRATION_WORKSPACE_TERMINALS_ACTIVE/);
});

test("取消关闭不入账，受理 steer 后必须收到同执行进度，保留业务关系", async function audit(t) {
  const { desktop, steers, run, lease } = await fixture(t);
  /** 场景中的 IPC 已绑定原视图且仍有另一窗格。 */
  function open() { return true; }
  assert.equal(await desktop.prepareViewsClose("group", "run", [workerView], open, open, async function cancel() { return false; }), false);
  assert.deepEqual(steers, []);
  assert.equal((await desktop.store.read()).runs[0].assignments[0].viewCloseReports, undefined);
  assert.equal(await desktop.prepareViewsClose("group", "run", [workerView], open, open, async function confirm() { return true; }), "active");
  const ledger = await desktop.store.read();
  const { viewCloseReports, ...assignment } = ledger.runs[0].assignments[0];
  assert.deepEqual({ ...ledger.runs[0], assignments: [assignment] }, run);
  assert.deepEqual(ledger.leases, [lease]);
  assert.equal(viewCloseReports?.[0].receipt?.state, "accepted");
  assert.equal(viewCloseReports?.[0].report?.conclusion, "正在验证");
  assert.equal(steers.length, 1);
  assert.equal(await desktop.prepareViewsClose("group", "run", [{ ...workerView, viewId: "reopened" }], open, open, async function confirm() { return true; }), "active");
  assert.notEqual(steers[0], steers[1]);
});

test("原执行变化或回执未知时保留视图，重复请求只核查原回执", async function stale(t) {
  const { desktop, activity, steers, queries, loseReceipt } = await fixture(t);
  /** 确认期间保留另一视图和本地代次。 */
  function open() { return true; }
  await assert.rejects(desktop.prepareViewsClose("group", "run", [workerView], open, open, async function replace() {
    activity.turnId = "replacement-turn";
    return true;
  }), /VIEW_CLOSE_UNKNOWN/);
  assert.deepEqual(steers, []);
  activity.turnId = "worker-turn";
  loseReceipt();
  for (let i = 0; i < 3; i++) await assert.rejects(desktop.prepareViewsClose("group", "run", [workerView], open, open, async function confirm() { return true; }), /VIEW_CLOSE_REPORT_UNCONFIRMED/);
  assert.equal(steers.length, 1);
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0], queries[1]);
});

test("关闭等待 Worker 回执时不占用审批与收尾的关系写入锁", { timeout: 10000 }, async function nonBlocking(t) {
  const { desktop, holdReceipt } = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(function start(resolve) { enter = resolve; });
  const held = new Promise<void>(function wait(resolve) { release = resolve; });
  holdReceipt(function awaitingAck() { enter(); return held; });
  /** 保持原认证视图及其他窗格。 */
  function open() { return true; }
  const closing = desktop.prepareViewsClose("group", "run", [workerView], open, open, async function confirm() { return true; });
  try {
    await entered;
    await desktop.store.update(function concurrent(ledger) { ledger.runs[0].revision++; });
    assert.equal((await desktop.store.read()).runs[0].revision, 4);
  } finally { release(); }
  assert.equal(await closing, "active");
});

test("并发关闭合并同批，异批重算主控和分屏，并以原角色重开主控", async function concurrency(t) {
  const roles: string[] = [];
  const exits: Array<() => void> = [];
  const environments: Record<string, string>[] = [];
  const sockets: Socket[] = [];
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(function retain(resolve) { release = resolve; });
  const started = new Promise<void>(function enter(resolve) { entered = resolve; });
  let checks = 0;
  const host = new ManagedTerminalHost(async function launch(env) {
    roles.push(env.AUTOPILOT_MANAGED_ROLE);
    environments.push(env);
    return { onData() {}, onExit(listener: () => void) { exits.push(listener); }, write() {} } as unknown as IPty;
  }, async function request(_workspace, _frame, runId, target) { return { runId, sessionId: target?.sessionId ?? "controller-session" }; }, {
    async selected() { return "run"; },
    async executor(_workspace, runId, assignmentId) { return { runId, assignmentId, sessionId: `session-${assignmentId}` }; },
    async prepareClose(_workspace, _run, _targets, remaining) {
      if (++checks === 1) { entered(); await held; }
      if (!remaining()) throw new Error("ORCHESTRATION_LAST_ACTIVE_TERMINAL");
      return "active";
    },
    ready() {},
    closed() {},
  });
  t.after(async function cleanup() { release(); for (const socket of sockets) socket.destroy(); for (const exit of exits) exit(); await host.close(); });
  /** 通过真实附着握手将假 PTY 标记为可用视图。 */
  async function attach(id?: string) {
    const pane = await host.ensure("group", "run", id);
    const env = environments.at(-1)!;
    const socket = createConnection({ host: "127.0.0.1", port: Number(env.AUTOPILOT_MANAGED_PORT) });
    sockets.push(socket);
    await once(socket, "connect");
    for (const operation of ["read", "ready"]) {
      const reply = once(socket, "data");
      socket.write(JSON.stringify({ id: operation, operation, token: env.AUTOPILOT_MANAGED_TOKEN }) + "\n");
      const [frame] = await reply;
      assert.equal(JSON.parse(frame.toString()).id, operation);
    }
    await host.io("group", pane.generation, "waitReady", undefined, undefined, pane.id);
    return pane;
  }
  const main = await attach();
  await attach("left");
  await attach("right");
  const first = host.closeViews("group", "run", ["left", "controller"]);
  assert.equal(host.closeViews("group", "run", ["controller", "left"]), first);
  await started;
  const last = assert.rejects(host.closeViews("group", "run", ["right"]), /LAST_ACTIVE_TERMINAL/);
  release();
  assert.equal(await first, true);
  await last;
  assert.equal(checks, 2);
  exits[0]();
  exits[1]();
  const reopened = await attach();
  assert.equal(reopened.id, main.id);
  assert.equal(reopened.generation, main.generation + 1);
  assert.deepEqual(roles, ["controller", "executor", "executor", "controller"]);
  const layout = attachManagedSessions(initialManagedLayout(), [{ id: "left", sessionId: "left-id" }, { id: "right", sessionId: "right-id" }], "split");
  const closed = closeManagedSessions(layout, ["left", "controller"]);
  assert.deepEqual(leaves(closed.tabs[0].layout), ["right"]);
  const placed = locateManagedSession(closed, "controller");
  assert.equal(placed.tabs[0].focused, "controller");
  assert.equal(placed.sessions[0].number, layout.sessions[0].number);
});

test("旧确认结束后拒绝关闭同位置的新薄客户端", async function replacement(t) {
  const exits: Array<() => void> = [];
  let host: ManagedTerminalHost;
  host = new ManagedTerminalHost(async function launch() {
    return { onData() {}, onExit(listener: () => void) { exits.push(listener); }, write() {} } as unknown as IPty;
  }, async function request() { return { runId: "run", sessionId: "controller-session" }; }, {
    async selected() { return "run"; },
    async prepareClose(_workspace, _run, _targets, _remaining, isCurrent) {
      assert.equal(isCurrent(), true);
      exits[0]();
      await host.ensure("group", "run");
      assert.equal(isCurrent(), false);
      return "inactive";
    },
    ready() {},
    closed() {},
  });
  t.after(async function cleanup() { for (const exit of exits) exit(); await host.close(); });
  const before = await host.ensure("group", "run");
  await assert.rejects(host.closeViews("group", "run", ["controller"]), /VIEW_CLOSE_STALE/);
  const after = await host.ensure("group", "run");
  assert.equal(after.generation, before.generation + 1);
  assert.equal(exits.length, 2);
});

test("最后空闲视图保存可接续记录后才撤销，落盘失败仍可使用原终端", async function checkpoint(t) {
  const { desktop, activity, run, worker, lease } = await fixture(t);
  Object.assign(activity, { execution: "inactive", status: "completed", result: "completed", activeTurn: false });
  let exit!: () => void;
  const writes: string[] = [];
  const host = new ManagedTerminalHost(async function launch() {
    return { onData() {}, onExit(listener: () => void) { exit = listener; }, write(text: string) { writes.push(text); } } as unknown as IPty;
  }, async function request() { return { runId: run.id, sessionId: worker.sessionId }; }, {
    async selected() { return run.id; },
    async executor(_workspace, runId, assignmentId) { return { runId, assignmentId, sessionId: worker.sessionId }; },
    async prepareClose(workspace, runId, targets, remaining, isCurrent, lastRecorded) {
      return desktop.prepareViewsClose(workspace, runId, targets, remaining, isCurrent, async function confirm() { assert.fail("静止视图无需二次确认"); }, lastRecorded);
    },
    ready() {},
    closed() {},
  });
  t.after(async function cleanup() { exit?.(); await host.close(); });
  const pane = await host.ensure("group", run.id, "worker");
  const persist = desktop.store.update;
  desktop.store.update = async function unavailable() { throw new Error("test save failure"); };
  try { await assert.rejects(host.closeViews("group", run.id, ["worker"]), /VIEW_CLOSE_RECORD_FAILED/); }
  finally { desktop.store.update = persist; }
  host.io("group", pane.generation, "write", "still open", undefined, pane.id);
  assert.deepEqual(writes, ["still open"]);
  assert.equal((await desktop.store.read()).runs[0].records.length, 0);
  assert.equal(await host.closeViews("group", run.id, ["worker"]), true);
  assert.throws(function detached() { host.io("group", pane.generation, "write", "closed", undefined, pane.id); }, /MANAGED_TERMINAL_EXITED/);
  exit();
  const view = await new OrchestrationService(desktop.store, { identity: worker, async command() { assert.fail("接续查询应直接读取原关系账本"); } }, run.checkout).bind(run.id, { kind: "controller", sessionId: run.controller.execution!.sessionId }).snapshot();
  const [record] = view.records;
  assert.equal(record.action, "human_last_view_close");
  assert.deepEqual(record.viewClose, { revision: run.revision, targets: [{ id: "worker", sessionId: worker.sessionId, turnId: worker.turnId, status: "completed", result: "completed" }] });
  const ledger = await desktop.store.read();
  assert.deepEqual(ledger.leases, [lease]);
  assert.deepEqual({ ...ledger.runs[0], records: [] }, run);
});
