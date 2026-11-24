/** 编排实现交付、独立复核及浏览器精确权限的定向回归。 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { BrowserAccess } from "../src/browser-access";
import { openBrowserDocument } from "../src/browser-document";
import { OrchestrationBrowser } from "../src/orchestration-browser";
import { applyControllerDecision, saveControllerDecision } from "../src/orchestration-decisions";
import { collectOrchestrationIntents } from "../src/orchestration-intents";
import { OrchestrationService, orchestrationId, type RelationAction } from "../src/orchestration-service";
import { OrchestrationStore, type AssignmentResult, type OrchestrationRun } from "../src/orchestration-store";

const identity = { protocol: 1 as const, hostId: "host", generation: "generation", owner: "owner" };

test("independent verification stages start before formal build acceptance", async function handoff(t) {
  const root = await mkdtemp(join(tmpdir(), "ap-orchestration-handoff-"));
  t.after(async function clean() { await rm(root, { recursive: true, force: true }); });
  const target = process.env.AP_ORCHESTRATION_REVIEW_FIXTURE;
  const checkout = target ? dirname(target) : root;
  const artifact = target ? basename(target) : "delivered.html";
  const version = target ? createHash("sha256").update(await readFile(target)).digest("hex") : "a".repeat(64);
  const terminal = new Map<string, { turnId: string; execution: "inactive"; result: "completed" | "failed" }>();
  let activeJobs = false;
  let releaseSession: string | undefined;
  const channel = { identity, async command(input: { operation: string; sessionId?: string; requestId: string }) {
    if (input.operation === "create") return { requestId: input.requestId, state: "confirmed", sessionId: orchestrationId(identity.hostId, input.requestId) };
    if (input.operation === "start") {
      const turnId = orchestrationId(identity.hostId, input.sessionId!, input.requestId);
      terminal.set(input.sessionId!, { turnId, execution: "inactive", result: "completed" });
      return { requestId: input.requestId, state: "started", sessionId: input.sessionId, turnId };
    }
    if (input.operation === "activity") return { snapshot: { sessionId: releaseSession ?? input.sessionId, execution: terminal.get(input.sessionId!) }, activeJobs };
    return {};
  } };
  const store = new OrchestrationStore(root);
  const service = new OrchestrationService(store, channel, checkout);
  const initial = await service.open("example-workspace-fixture", checkout, "交付本地页面，交给另一个执行者独立检查", { settingsVersion: "1", permissionVersion: "1", maxConcurrent: 3, automaticDispatch: true, responsibility: "controller", versions: { app: "1", core: "1", protocol: "1", schema: "1" } });
  const control = service.bind(initial.id, { kind: "human" });
  let run: OrchestrationRun = await control.initialize();
  /** 每个关系动作使用自身新请求、最新 Run 版本。 */
  async function relate(action: RelationAction) {
    run = await control.command({ requestId: randomUUID(), expectedRevision: run.revision, action });
  }
  const setup = { scope: ".", deliverables: ["页面"], acceptance: ["证据"] };
  await relate({ type: "step", step: { id: "build", goal: "交付页面", dependencies: [], ...setup } });
  const reviewStep = { id: "review", goal: "独立复核", dependencies: ["build"], verifies: { stepId: "build" }, ...setup };
  await relate({ type: "step", step: reviewStep });
  await relate({ type: "step", step: { id: "consume", goal: "普通依赖", dependencies: ["build"], ...setup } });
  await relate({ type: "step", step: { id: "unrelated", goal: "无关执行者", dependencies: [], ...setup } });
  await relate({ type: "assign", assignment: { id: "builder", stepId: "build", purpose: "initial", content: "build", access: "write" } });
  await relate({ type: "assign", assignment: { id: "reviewer", stepId: "review", purpose: "initial", content: "review", access: "read" } });
  await relate({ type: "assign", assignment: { id: "consumer", stepId: "consume", purpose: "initial", content: "consume", access: "read" } });
  await relate({ type: "assign", assignment: { id: "unrelated-writer", stepId: "unrelated", purpose: "initial", content: "other", access: "write" } });
  await relate({ type: "seal" });
  await relate({ type: "batchDecision", planVersion: run.planVersion, digest: run.batches![0].digest, approve: true });
  run = await control.dispatch("builder", run.revision);
  const builder = run.assignments.find(function builder(a) { return a.id === "builder"; })!;
  const local = { source: "agent" as const, phase: "done", obligations: [], handoff: true, skills: [], requiredSkills: [], cooperation: [] };
  const evidence = { id: "built", artifact, contentVersion: version, method: "sha256", result: "created", source: "agent" as const };
  /** 记录指定委派的精确局部报告，重复结果历史由产品服务检查。 */
  async function report(assignmentId: string, result: Omit<AssignmentResult, "revision">) {
    const item = run.assignments.find(function current(a) { return a.id === assignmentId; })!;
    const self = service.bind(run.id, { kind: "executor", sessionId: item.execution!.sessionId });
    run = await self.command({ requestId: randomUUID(), expectedRevision: run.revision, action: { type: "report", assignmentId, execution: item.execution!, revision: item.revision, local, result: { ...result, revision: item.revision } } });
  }
  const built = { id: "built-result", summary: "已交付", outcome: "partial", verificationPending: true, checks: ["局部自测"], unresolved: [], evidence: [evidence] } as const;
  const verified = { id: "verified", summary: "复核完成", outcome: "delivered", checks: ["独立检查"], unresolved: [], evidence: [{ ...evidence, id: "verified-evidence", result: "checked" }] } satisfies Omit<AssignmentResult, "revision">;
  const accept = { type: "accept", assignmentId: "builder", resultId: built.id, evidenceIds: ["built"], verificationAssignmentId: "reviewer" } as const;
  await assert.rejects(control.dispatch("reviewer", run.revision), /DEPENDENCY_PENDING/);
  await assert.rejects(report("builder", { ...built, checks: [], evidence: [evidence], unresolved: ["实现缺项"] }), /INVALID_REPORT/);
  await report("builder", { ...built, checks: [...built.checks], unresolved: [], evidence: [evidence] });
  await assert.rejects(control.dispatch("reviewer", run.revision), /DEPENDENCY_PENDING/);
  activeJobs = true;
  await assert.rejects(control.release(run.revision, "builder"), /RELEASE_UNCONFIRMED/);
  activeJobs = false;
  releaseSession = "wrong-session";
  await assert.rejects(control.release(run.revision, "builder"), /RELEASE_UNCONFIRMED/);
  releaseSession = undefined;
  terminal.get(builder.execution!.sessionId)!.result = "failed";
  run = await control.release(run.revision, "builder");
  await assert.rejects(control.dispatch("reviewer", run.revision), /DEPENDENCY_PENDING/);
  terminal.get(builder.execution!.sessionId)!.result = "completed";
  run = await control.release(run.revision, "builder");
  await assert.rejects(relate({ ...accept, evidenceIds: ["built"] }), /INDEPENDENT_VERIFICATION_REQUIRED/);
  await assert.rejects(control.dispatch("consumer", run.revision), /DEPENDENCY_PENDING/);
  run = await control.dispatch("unrelated-writer", run.revision);
  await assert.rejects(control.dispatch("reviewer", run.revision), /CHECKOUT_BUSY/);
  await report("unrelated-writer", verified);
  run = await control.release(run.revision, "unrelated-writer");
  await assert.rejects(relate({ ...accept, evidenceIds: ["built"], verificationAssignmentId: "unrelated-writer" }), /INDEPENDENT_VERIFICATION_REQUIRED/);
  await store.update(function sourceResult(ledger) { collectOrchestrationIntents(ledger.runs[0]); });
  run = await control.snapshot();
  const intent = run.pending!.find(function delivered(item) { return item.resultId === built.id; })!;
  await saveControllerDecision(service, run.id, run.controller.execution!.sessionId,
    { intentId: intent.id, basis: intent.basis, expectedRevision: run.revision, reason: "独立检查已经完成交接的同版交付", actions: [{ kind: "dispatch", assignmentId: "reviewer" }] });
  await applyControllerDecision(service, run.id, intent.id);
  run = await control.snapshot();
  assert.equal(run.pending!.find(function same(item) { return item.id === intent.id; })?.decision?.state, "done");
  assert.equal(run.acceptance, "pending");
  const review = run.assignments.find(function named(a) { return a.id === "reviewer"; })!;
  assert.notEqual(review.execution?.sessionId, builder.execution?.sessionId);
  assert.equal(review.verification?.resultId, built.id);
  assert.deepEqual(review.verification?.evidence, [evidence]);
  await report("reviewer", verified);
  await assert.rejects(relate({ ...accept, evidenceIds: ["built"] }), /INDEPENDENT_VERIFICATION_REQUIRED/);
  await report("reviewer", { ...verified, id: "wrong-version", evidence: [{ ...verified.evidence[0], contentVersion: "wrong" }] });
  run = await control.release(run.revision, "reviewer");
  await assert.rejects(relate({ ...accept, evidenceIds: ["built"] }), /INDEPENDENT_VERIFICATION_REQUIRED/);
  // 此处撤回合成错误报告，只用原来同版报告验证正式验收的正例。
  await store.update(function useSuccessfulEvidence(ledger) { ledger.runs[0].assignments.find(function same(item) { return item.id === "reviewer"; })!.results.pop(); });
  await relate({ ...accept, evidenceIds: ["built"] });
  await relate({ type: "accept", assignmentId: "reviewer", resultId: verified.id, evidenceIds: ["verified-evidence"] });
  assert.equal(run.steps[0].verdict?.accepted, true);
  assert.equal(run.steps[1].verdict?.accepted, true);
  assert.equal(run.assignments[0].results[0].outcome, "partial");
  await assert.rejects(relate({ type: "acceptRun" }), /HANDOFF_INCOMPLETE/);
});

test("managed executor has a separately scoped browser execution segment", async function browserScope(t) {
  const root = await mkdtemp(join(tmpdir(), "ap-orchestration-browser-"));
  t.after(async function clean() { await rm(root, { recursive: true, force: true }); });
  const target = process.env.AP_ORCHESTRATION_REVIEW_FIXTURE ?? join(root, "doc.html");
  if (!process.env.AP_ORCHESTRATION_REVIEW_FIXTURE) await writeFile(target, "<title>复核样本</title>");
  const expected = await readFile(target);
  const evidence = { id: "built-evidence", artifact: basename(target), contentVersion: createHash("sha256").update(expected).digest("hex"), method: "sha256", result: "created", source: "agent" as const };
  await assert.rejects(openBrowserDocument(await realpath(target), AbortSignal.timeout(3000), "0".repeat(64)), /BROWSER_DOCUMENT_CHANGED/);
  const pageId = randomUUID();
  let cleanup: (() => Promise<void>) | undefined;
  let previewUrl: string | undefined;
  t.after(async function close() { await cleanup?.(); });
  const access = new BrowserAccess({
    preferences() { return { permission: "follow_ap", historyDays: 30, askDownload: false }; },
    target(operation, principal) {
      return operation.type === "document" ? { url: operation.path } : { url: previewUrl ?? "https://example.test", approvedLocal: principal?.review ? true : undefined };
    },
    async execute(principal, _turn, operation, signal) {
      if (operation.type === "list") return { owner: principal.id };
      if (operation.type === "document") {
        assert.equal(principal.label, "Autopilot · reviewer");
        assert.equal(operation.path, await realpath(target));
        const preview = await openBrowserDocument(operation.path, signal, evidence.contentVersion);
        cleanup = preview.close;
        previewUrl = preview.url;
        assert.deepEqual(Buffer.from(await (await fetch(preview.url)).arrayBuffer()), expected);
        return { id: pageId, revision: 1 };
      }
      return { owner: principal.id, operation: operation.type };
    },
    async release(principal) { if (principal.review) await cleanup?.(); },
  });
  const browser = new OrchestrationBrowser(access);
  const binding = { sessionId: "review-session", turnId: "review-turn" };
  const run = {
    id: "run", hostId: identity.hostId, workspaceId: "example-workspace", checkout: dirname(target), controller: { execution: { sessionId: "controller-session", ...identity } },
    steps: [{ id: "review", currentAssignmentId: "reviewer" }],
    assignments: [{ id: "reviewer", stepId: "review", state: "active", local: { handoff: false }, execution: { ...binding, ...identity }, verification: { assignmentId: "builder", resultId: "built", evidence: [evidence], browser: true } }],
  } as unknown as OrchestrationRun;
  browser.connect(run.workspaceId, run.id);
  const main = { sessionId: "controller-session", turnId: "controller-turn" };
  const mainKey = browser.register(run, main, identity.generation, "example-workspace");
  const key = browser.register(run, binding, identity.generation, "example-workspace");
  assert.ok(key);
  const signal = AbortSignal.timeout(3000);
  const authorization = { mode: "full_access", approvedOnce: true };
  const open = { key, callId: "unapproved-open", operation: { type: "open", url: "https://example.test" }, authorization };
  await assert.rejects(browser.request(run, binding, identity.generation, open, signal), /SCOPE/);
  await assert.rejects(browser.request(run, binding, identity.generation, { ...open, key: mainKey }, signal), /TURN_UNAVAILABLE/);
  await assert.rejects(browser.request(run, binding, identity.generation, open, signal, "old-owner"), /TURN_UNAVAILABLE/);
  await assert.rejects(browser.request(run, binding, "old-generation", open, signal), /TURN_UNAVAILABLE/);
  await assert.rejects(browser.request(run, binding, identity.generation, { ...open, callId: "unknown-page", operation: { type: "snapshot", pageId, revision: 1 } }, signal), /SCOPE/);
  const outside = join(root, "outside.md");
  await writeFile(outside, "只有合成测试数据");
  await assert.rejects(browser.request(run, binding, identity.generation, { ...open, callId: "other-file", operation: { type: "document", path: outside } }, signal), /SCOPE/);
  const pending = browser.request(run, binding, identity.generation, { ...open, callId: "document", operation: { type: "document", path: basename(target) } }, signal);
  while (!access.snapshot().length && !signal.aborted) await tick();
  const [approval] = access.snapshot();
  assert.equal(approval.target, await realpath(target));
  assert.equal(approval.caller, "Autopilot · reviewer");
  assert.equal(approval.singleUse, true);
  assert.throws(function cannotBroaden() { access.answer(approval.id, "always"); }, /单次确认/);
  access.answer(approval.id, "once");
  assert.deepEqual(await pending, { id: pageId, revision: 1 });
  assert.deepEqual(browser.observations(run, binding, identity.generation, identity.owner), []);
  const observed = await browser.request(run, binding, identity.generation, { ...open, callId: "snapshot", operation: { type: "snapshot", pageId, revision: 1 } }, signal) as { owner: string };
  const controller = await browser.request(run, main, identity.generation, { ...open, key: mainKey, callId: "list", operation: { type: "list" } }, signal) as { owner: string };
  assert.notEqual(observed.owner, controller.owner);
  assert.equal(browser.observations(run, binding, identity.generation, identity.owner)?.[0].contentVersion, evidence.contentVersion);
  run.assignments[0].takeover = true;
  browser.reconcile(run, identity.generation, identity.owner);
  await assert.rejects(browser.request(run, binding, identity.generation, open, signal), /TURN_UNAVAILABLE/);
  await assert.rejects(fetch(previewUrl!));
});
