/** 隔离账本回归：迟到释放、原计划接续、重复驱动与严格证据门。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assignmentInput } from "../src/orchestration-admission";
import { applyControllerDecision, saveControllerDecision, type DecisionAction } from "../src/orchestration-decisions";
import { OrchestrationHost } from "../src/orchestration-host";
import { collectOrchestrationIntents } from "../src/orchestration-intents";
import { OrchestrationService, orchestrationId, type RelationAction } from "../src/orchestration-service";
import { ORCHESTRATION_DELIVERY_GUIDANCE, ORCHESTRATION_PHASED_GUIDANCE, ORCHESTRATION_SKILL_BODY } from "../src/orchestration-skill";
import { OrchestrationStore, type OrchestrationIntent, type OrchestrationLedger, type OrchestrationRun } from "../src/orchestration-store";
import type { ManagedFactsHost, ManagedFactsLedger } from "../src/managed-facts-host";
import type { ManagedRuntimeHost } from "../src/managed-runtime-host";
import type { ManagedRuntimeCommand, ManagedRuntimeReceipt } from "../src/managed-runtime-service";

/** 用真实服务和 Host 配合可控 Worker，所有文件和状态仅存在临时目录。 */
async function fixture(t: TestContext, review = false) {
  const root = await mkdtemp(join(tmpdir(), "ap-continuation-"));
  t.after(async function cleanup() { await rm(root, { recursive: true, force: true }); });
  const identity = { protocol: 1 as const, hostId: "host", owner: "owner", generation: "generation" };
  const receipts = new Map<string, ManagedRuntimeReceipt>();
  const commands: Omit<ManagedRuntimeCommand, keyof typeof identity>[] = [];
  const turns = new Map<string, string>();
  let builderSession = "", controllerSession = "", completed = false;
  const ledger: ManagedFactsLedger = { protocol: 1, hostId: identity.hostId, connection: { source: "host", state: "connected", ...identity }, sessions: {} };
  const facts = { subscribe() { return function unsubscribe() {}; }, async register() {}, async refresh() {}, status() { return { ledger }; } } as unknown as ManagedFactsHost;
  let handler: ((binding: { sessionId: string; turnId: string }, operation: string, input: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  const channel = {
    identity, orchestrationTools: true,
    subscribe() { return function unsubscribe() {}; },
    registerToolHandler(_workspace: string, tool: typeof handler) { handler = tool; return function unregister() { handler = undefined; }; },
    async command(input: Omit<ManagedRuntimeCommand, keyof typeof identity>) {
      commands.push(input);
      if (input.operation === "query") return receipts.get(input.targetRequestId!) ?? { requestId: input.targetRequestId, state: "unconfirmed" };
      if (input.operation === "create") {
        const receipt: ManagedRuntimeReceipt = { requestId: input.requestId, state: "confirmed", sessionId: orchestrationId(identity.hostId, input.requestId) };
        receipts.set(input.requestId, receipt); return receipt;
      }
      if (input.operation === "start" || input.operation === "steer") {
        const turnId = input.turnId ?? orchestrationId(identity.hostId, input.sessionId!, input.requestId);
        turns.set(input.sessionId!, turnId);
        const receipt: ManagedRuntimeReceipt = { requestId: input.requestId, state: input.operation === "start" ? "started" : "confirmed", sessionId: input.sessionId, turnId, operation: input.operation };
        receipts.set(input.requestId, receipt); return receipt;
      }
      const execution = { turnId: turns.get(input.sessionId!) ?? "idle-turn", status: "completed", execution: "inactive", result: "completed", lastSeq: 1 };
      if (input.sessionId === builderSession && !completed) Object.assign(execution, { execution: "active", status: "running", result: undefined });
      const snapshot = { protocol: 1, sessionId: input.sessionId, consistency: "overlap", execution };
      if (input.operation === "snapshot") return snapshot;
      if (input.operation === "activity") return { snapshot, activeJobs: false };
      assert.fail(`意外命令 ${input.operation}`);
    },
  } as unknown as ManagedRuntimeHost;
  const store = new OrchestrationStore(root);
  const service = new OrchestrationService(store, channel, root, facts);
  const initial = await service.open("fixture", root, "分阶段网页与手册", { settingsVersion: "1", permissionVersion: "1", maxConcurrent: 2, automaticDispatch: true, responsibility: "controller", versions: { app: "1", core: "1", protocol: "1", schema: "1" } });
  const human = service.bind(initial.id, { kind: "human" });
  let run: OrchestrationRun = await human.initialize();
  controllerSession = run.controller.execution!.sessionId;
  /** 关系操作始终通过真实 CAS 边界。 */
  async function relate(action: RelationAction) {
    run = await human.command({ requestId: randomUUID(), expectedRevision: (await human.snapshot()).revision, action });
    return run;
  }
  const step = { scope: ".", deliverables: ["页面"], acceptance: ["可核实证据"] };
  await relate({ type: "step", step: { id: "page", goal: "网页", dependencies: [], ...step } });
  await relate({ type: "step", step: { id: "manual", goal: review ? "独立复核" : "手册", dependencies: ["page"], ...(review ? { verifies: { stepId: "page" } } : {}), ...step } });
  await relate({ type: "assign", assignment: { id: "page-maker", stepId: "page", content: "制作网页", purpose: "initial", access: "write" } });
  await relate({ type: "assign", assignment: { id: "manual-writer", stepId: "manual", content: review ? "复核网页" : "编写手册", purpose: "initial", access: "read" } });
  await relate({ type: "seal" });
  run = await human.dispatch("page-maker", run.revision);
  const item = run.assignments[0]; builderSession = item.execution!.sessionId;
  await service.bind(run.id, { kind: "executor", sessionId: builderSession }).command({ requestId: randomUUID(), expectedRevision: run.revision, action: { type: "report", assignmentId: item.id, execution: item.execution!, revision: item.revision, local: { source: "agent", phase: "done", handoff: true, obligations: [], cooperation: [], skills: [], requiredSkills: [] }, result: { id: "new-turn-result", revision: item.revision, summary: "网页交付", outcome: review ? "partial" : "delivered", ...(review ? { verificationPending: true } : {}), unresolved: [], checks: ["检查文件与版本"], evidence: [{ id: "page-evidence", artifact: "index.html", contentVersion: "a".repeat(64), method: "sha256", result: "已核实", source: "agent" }] } } });
  const host = new OrchestrationHost(service, channel, facts, run.id);
  t.after(function close() { host.close(); });
  await host.open();
  /** 把初始输入与通知视为已处理，只保留本次真实结果意图。 */
  await store.update(function prior(state) { for (const intent of state.runs[0].pending!) if (intent.resultId !== "new-turn-result") intent.state = "decided"; });
  /** 按最新查询保存指定意图决定。 */
  async function decide(intent: OrchestrationIntent, actions: DecisionAction[]) {
    const current = await human.snapshot();
    await saveControllerDecision(service, run.id, controllerSession, { intentId: intent.id, basis: intent.basis, expectedRevision: current.revision, reason: "按真实证据继续", actions });
  }
  /** 返回当前未结清接续项。 */
  async function continuation() { return (await human.snapshot()).pending!.filter(function pending(i) { return i.state === "pending" && !!i.continuation; }); }
  return { root, store, service, human, host, channel, facts, commands, relate, decide, continuation,
    async resultIntent() { return (await human.snapshot()).pending!.find(function result(i) { return i.kind === "result" && i.resultId === "new-turn-result"; })!; },
    complete() { completed = true; },
    loseReceipt(requestId: string) { receipts.delete(requestId); },
    async reopen() { host.close(); const next = new OrchestrationHost(new OrchestrationService(new OrchestrationStore(root), channel, root, facts), channel, facts, run.id); await next.open(); t.after(function close() { next.close(); }); return next; },
    async queryContract() { return handler!({ sessionId: controllerSession, turnId: turns.get(controllerSession) ?? "idle-turn" }, "orchestration_query", {}, AbortSignal.timeout(3000)) as Promise<{ contract: { decide: string } }>; },
  };
}

const release: DecisionAction = { kind: "release", assignmentId: "page-maker" };
const accept: DecisionAction = { kind: "relation", action: { type: "accept", assignmentId: "page-maker", resultId: "new-turn-result", evidenceIds: ["page-evidence"] } };
const dispatch: DecisionAction = { kind: "dispatch", assignmentId: "manual-writer" };

test("迟到释放在同次 drive 补持久接续，重复 drive 与重开只派原下游一次", async function delayed(t) {
  const f = await fixture(t);
  const original = await f.resultIntent();
  await f.decide(original, [release]);
  await f.host.drive();
  let run = await f.human.snapshot();
  assert.equal(run.pending!.find(function source(i) { return i.id === original.id; })!.decision!.error, "ORCHESTRATION_RELEASE_UNCONFIRMED");
  assert.equal((await f.continuation()).length, 0);
  f.complete();
  await f.host.drive();
  const [next] = await f.continuation();
  assert.ok(next?.wake, "无需下一外部事件即可持久登记并唤醒");
  assert.equal((await f.human.snapshot()).assignments[1].state, "planned");
  const wake = next.wake.requestId;
  f.loseReceipt(wake);
  await f.host.drive();
  const reopened = await f.reopen();
  await reopened.drive();
  assert.equal((await f.continuation())[0].wake!.requestId, wake);
  await f.decide(next, [accept, dispatch]);
  await reopened.drive();
  await reopened.drive();
  run = await f.human.snapshot();
  assert.equal(run.steps[0].verdict?.accepted, true);
  assert.equal(run.assignments[1].state, "active");
  assert.equal(f.commands.filter(function started(c) { return c.operation === "start" && c.requestId === run.assignments[1].startRequestId; }).length, 1);
  assert.equal((await f.continuation()).length, 0);
});

test("完整 release accept dispatch 批次不额外唤醒，分次验收后仍能接续派单", async function batch(t) {
  for (const split of [0, 1, 2]) {
    const f = await fixture(t);
    f.complete();
    await f.decide(await f.resultIntent(), split === 2 ? [release] : split ? [release, accept] : [release, accept, dispatch]);
    await f.host.drive();
    if (!split) {
      assert.equal((await f.continuation()).length, 0);
      assert.equal(f.commands.filter(function wake(c) { return c.operation === "start" && c.content?.includes('"intentIds"'); }).length, 0);
    } else {
      let [next] = await f.continuation();
      assert.ok(next?.wake);
      if (split === 2) {
        await f.decide(next, [accept]);
        await f.host.drive();
        const [afterAcceptance] = await f.continuation();
        assert.ok(afterAcceptance?.wake);
        assert.notEqual(afterAcceptance.id, next.id);
        next = afterAcceptance;
      }
      await f.decide(next, [dispatch]);
      await f.host.drive();
      assert.equal((await f.human.snapshot()).assignments[1].state, "active");
    }
  }
});

test("历史 decided 快照重开可补，暂停和 controlOnly 不消费也不重复投递", async function history(t) {
  const f = await fixture(t);
  f.complete();
  let run = await f.human.snapshot();
  await f.human.release(run.revision, "page-maker");
  await f.store.update(function old(state) { for (const intent of state.runs[0].pending!) intent.state = "decided"; });
  const reopened = await f.reopen();
  const [unwoken] = await f.continuation();
  assert.ok(unwoken);
  assert.equal(unwoken.wake, undefined);
  await f.store.update(function pause(state) { state.runs[0].paused = true; state.runs[0].controlOnly = true; });
  await reopened.drive();
  assert.equal((await f.continuation())[0].wake, undefined);
  await f.store.update(function resume(state) { state.runs[0].paused = false; state.runs[0].controlOnly = false; });
  await reopened.drive();
  const [next] = await f.continuation();
  assert.ok(next?.wake);
  await f.store.update(function pause(state) { state.runs[0].paused = true; state.runs[0].controlOnly = true; });
  await reopened.drive();
  assert.equal((await f.continuation())[0].id, next.id);
  await f.store.update(function resume(state) { state.runs[0].paused = false; state.runs[0].controlOnly = false; });
  await reopened.drive();
  assert.equal((await f.continuation())[0].wake!.requestId, next.wake!.requestId);
  run = await f.human.snapshot();
  assert.equal(run.assignments[1].state, "planned");
});

test("过期或不确定交付、退役与取消下游不生成接续，条件变化阻断已保存决定", async function boundaries(t) {
  const f = await fixture(t);
  f.complete();
  await f.decide(await f.resultIntent(), [release]);
  await applyControllerDecision(f.service, (await f.human.snapshot()).id, (await f.resultIntent()).id);
  const original = await f.store.read();
  /** 每种情况从同一已释放、已处理原报告快照单独收集。 */
  function collect(change: (state: OrchestrationLedger) => void) {
    const state = structuredClone(original); change(state); collectOrchestrationIntents(state.runs[0], undefined, state);
    return state.runs[0].pending!.filter(function next(i) { return i.state === "pending" && !!i.continuation; });
  }
  assert.equal(collect(function unchanged() {}).length, 1);
  const changes: Array<(state: OrchestrationLedger) => void> = [
    function wrongTurn(s) { s.runs[0].assignments[0].completedReleaseTurnId = "old"; },
    function unknown(s) { s.runs[0].assignments[0].receipt!.state = "unconfirmed"; },
    function oldPrompt(s) { s.runs[0].assignments[0].results[0].promptVersion = 0; },
    function unresolved(s) { s.runs[0].assignments[0].results[0].unresolved = ["未完成"]; },
    function staleReport(s) { s.runs[0].assignments[0].results[0].turnId = "old"; },
    function retirement(s) { s.runs[0].assignments[0].retiredForRepair = { turnId: "old", resultId: "old" }; },
    function replacement(s) { s.runs[0].steps[0].currentAssignmentId = "replacement"; },
    function replan(s) { s.runs[0].planVersion++; },
    function cancelDownstream(s) { s.runs[0].assignments[1].state = "cancelled"; },
    function cancelBatch(s) { s.runs[0].batches![0].state = "cancelled"; },
    function pendingBatch(s) { s.runs[0].batches![0].state = "pending"; },
    function manual(s) { s.runs[0].assignments[0].takeover = true; },
    function removed(s) { s.runs[0].navigationRemoved = true; },
    function lease(s) { s.leases = [{ checkout: s.runs[0].checkout, runId: s.runs[0].id, assignmentId: "page-maker", access: "write" }]; },
  ];
  for (const change of changes) assert.equal(collect(change).length, 0, change.name);
  await f.host.drive();
  const [next] = await f.continuation();
  await f.decide(next, [accept, dispatch]);
  await f.store.update(function changed(s) { s.runs[0].assignments[1].state = "cancelled"; });
  await applyControllerDecision(f.service, (await f.human.snapshot()).id, next.id);
  const current = await f.human.snapshot();
  assert.equal(current.pending!.find(function same(i) { return i.id === next.id; })!.decision!.state, "stale");
  assert.equal(current.steps[0].verdict, undefined);
});

test("独立复核接续沿原证据门，普通下游仍须正式验收且新合同覆盖两条路线", async function review(t) {
  const f = await fixture(t, true);
  f.complete();
  await f.decide(await f.resultIntent(), [release]);
  await f.host.drive();
  const [next] = await f.continuation();
  assert.ok(next?.wake);
  await assert.rejects(f.relate(accept.kind === "relation" ? accept.action : { type: "acceptRun" }), /INDEPENDENT_VERIFICATION_REQUIRED/);
  await f.decide(next, [dispatch]);
  await f.host.drive();
  const run = await f.human.snapshot();
  assert.equal(run.steps[0].verdict, undefined);
  assert.equal(run.assignments[1].verification?.resultId, "new-turn-result");
  assert.equal(run.assignments[1].state, "active");
  const normal = await fixture(t);
  assert.match(JSON.parse(assignmentInput(await normal.human.snapshot(), (await normal.human.snapshot()).assignments[0])).policy, /outcome:delivered/);
  assert.ok(ORCHESTRATION_SKILL_BODY.includes(ORCHESTRATION_DELIVERY_GUIDANCE));
  assert.ok(ORCHESTRATION_SKILL_BODY.includes(ORCHESTRATION_PHASED_GUIDANCE));
  assert.ok((await normal.queryContract()).contract.decide.includes(ORCHESTRATION_PHASED_GUIDANCE));
  await assert.rejects(normal.human.dispatch("manual-writer", (await normal.human.snapshot()).revision), /DEPENDENCY_PENDING/);
});
