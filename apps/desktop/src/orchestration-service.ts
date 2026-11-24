/** Desktop 唯一编排命令边界；调用者身份由受信宿主绑定，查询及关系重放不启动执行。 */
import { intentBasis, isTerminalInputTurn, rebaseControllerCorrections } from "./orchestration-intents";
import { createHash, randomUUID } from "node:crypto";
import { isReviewDocument } from "./browser-document";
import type { ManagedRuntimeHost } from "./managed-runtime-host";
import type { ManagedFactsHost } from "./managed-facts-host";
import type { ManagedLeaseActivity, ManagedRuntimeCommand, ManagedRuntimeIdentity, ManagedRuntimeReceipt } from "./managed-runtime-service";
import type { RuntimeFactSnapshot } from "@autopilot-agent/core";
import { canonicalCheckout, checkoutOverlaps, continuationAction, assignmentPrompts, assignmentInput, finishCoversStep, requireCompatibleWorkflow, reserveBudget, reserveCheckout, releaseCheckout, releasedDelivery, matchingEvidence, visibleRunPrompts } from "./orchestration-admission";
import { OrchestrationStore, type OrchestrationLedger, type OrchestrationRun, type OrchestrationPolicy, type ExecutionReference, type OrchestrationStep, type OrchestrationAssignment, type LocalWorkflow, type AssignmentResult, type EvidenceReference, type BusinessHandoff } from "./orchestration-store";

type Channel = Pick<ManagedRuntimeHost, "identity" | "command">;
export interface CheckoutHolder {
  workspaceId?: string; runId: string; assignmentId?: string; execution?: ExecutionReference;
  activity?: ManagedLeaseActivity; resuming: boolean; disconnected: boolean;
  available?: "failed" | "waiting" | "settled";
}
export type OrchestrationActor = { kind: "human" } | { kind: "controller" | "executor"; sessionId: string };
export type RelationAction =
  | { type: "step"; step: Pick<OrchestrationStep, "id" | "goal" | "scope" | "dependencies" | "deliverables" | "acceptance" | "verifies"> }
  | { type: "assign"; assignment: Pick<OrchestrationAssignment, "id" | "stepId" | "content" | "purpose" | "previousId" | "access"> }
  | { type: "handoff"; handoff: Omit<BusinessHandoff, "requestId" | "revision" | "received"> }
  | { type: "report"; assignmentId: string; execution: ExecutionReference; revision: number; promptVersion?: number; local: LocalWorkflow; result?: AssignmentResult; browserObservations?: EvidenceReference[] }
  | { type: "accept"; assignmentId: string; resultId: string; evidenceIds: string[]; verificationAssignmentId?: string }
  | import("./orchestration-store").OrchestrationPromptAttachments & { type: "prompt"; text: string; scope: "run" | "step" | "assignment"; targetId: string; independentVerification?: boolean; terminalInput?: boolean; queue?: import("./orchestration-store").OrchestrationQueuedPrompt; fileMentions?: import("./orchestration-store").OrchestrationTerminalFileMentions }
  | { type: "revise"; assignmentId: string; content: string }
  | { type: "seal" }
  | { type: "replan"; assignmentId: string; resultId: string; reason: string }
  | { type: "cancelPlanned"; assignmentId: string }
  | { type: "acceptRun" }
  | { type: "batchDecision"; planVersion: number; digest: string; approve: boolean };
export interface RelationCommand { requestId: string; expectedRevision: number; action: RelationAction }
export interface AssignmentControl {
  assignmentId: string; expectedRevision: number; execution: ExecutionReference;
  command: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity | "sessionId" | "turnId">;
}

/** 稳定身份沿 Core 创建算法，无随机重派。 */
export function orchestrationId(...parts: string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }

/** 原生身份逐字段比较，JSON 属性顺序不是身份组成部分。 */
function sameExecution(left: ExecutionReference, right: ExecutionReference): boolean {
  return !!right && left.hostId === right.hostId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.requestId === right.requestId && left.owner === right.owner && left.generation === right.generation;
}

/** 受信调用优先按 Run ID 固定定位；旧工作区绑定兼容最后创建项。 */
export function requireRun(runs: OrchestrationRun[], workspaceId: string): OrchestrationRun {
  const run = runs.find(function exact(item) { return item.id === workspaceId; }) ?? runs.filter(function same(item) { return item.workspaceId === workspaceId; }).at(-1);
  if (!run) throw new Error("ORCHESTRATION_RUN_MISSING");
  if (run.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
  return run;
}

/** 批次摘要绑定具体任务、Step 依赖、目录、交付和资源，不能只确认人数。 */
export function batchDigest(run: OrchestrationRun, assignmentIds: string[]): string {
  return orchestrationId(JSON.stringify(assignmentIds.map(function item(id) {
    const a = run.assignments.find(function target(a) { return a.id === id; })!;
    const step = run.steps.find(function target(s) { return s.id === a.stepId; })!;
    const handoff = run.handoffs?.find(function exact(h) { return h.assignmentId === a.id; });
    return { id: a.id, step: { id: step.id, revision: step.revision, goal: step.goal, scope: step.scope, dependencies: step.dependencies, deliverables: step.deliverables, acceptance: step.acceptance, verifies: step.verifies }, content: a.content, checkout: a.checkout, access: a.access, purpose: a.purpose, promptVersion: a.promptVersion, maxConcurrent: run.policy.maxConcurrent, handoff: handoff?.requestId };
  })));
}

/** 旧清单只有能还原每个 Step 和任务时才可验证摘要。 */
function matchesBatch(run: OrchestrationRun, batch: NonNullable<OrchestrationRun["batches"]>[number]) {
  return batch.assignmentIds.length > 0 && batch.assignmentIds.every(function present(id) {
    const item = run.assignments.find(function target(a) { return a.id === id; });
    return item && run.steps.some(function step(s) { return s.id === item.stepId; });
  }) && batch.digest === batchDigest(run, batch.assignmentIds);
}

/** 仅原封批决定的未提交派工游标可由该清单批准解锁。旧记录按封批顺序核对。 */
export function linkBatchDispatch(run: OrchestrationRun, batch: NonNullable<OrchestrationRun["batches"]>[number], revision: number) {
  const sealId = originalSeal(run, batch);
  if (batch.state !== "approved" || batch.planVersion !== run.planVersion || !matchesBatch(run, batch)) return;
  for (const intent of run.pending ?? []) {
    const decision = intent.decision;
    if (!decision || decision.state !== "saved" && !(decision.state === "blocked" && decision.error === "ORCHESTRATION_BATCH_NOT_APPROVED")) continue;
    const action = decision.actions[decision.next];
    if (action?.kind !== "dispatch" || !batch.assignmentIds.includes(action.assignmentId)) continue;
    const waiting = decision.waitingBatch;
    const originalGate = waiting && waiting.next === decision.next && waiting.digest === batch.digest && run.batches?.some(function same(b) {
      return b.planVersion === waiting.planVersion && (b === batch || !!sealId && b.sealRequestId === sealId);
    });
    if (!originalGate && !decision.actions.slice(0, decision.next).some(function seal(a, index) {
      return a.kind === "relation" && a.action.type === "seal" && orchestrationId(intent.id, String(index)) === sealId;
    })) continue;
    const item = run.assignments.find(function original(a) { return a.id === action.assignmentId; });
    if (!item || item.state !== "planned" || item.execution || item.receipt || item.takeover || item.promptVersion !== assignmentPrompts(run, item).at(-1)?.version) continue;
    const basis = intentBasis(run, intent.assignmentId);
    if (intent.basis !== basis && (intent.basis !== intentBasis({ ...run, prompts: run.prompts.slice(0, intent.promptVersion) }, intent.assignmentId) || !run.prompts.slice(intent.promptVersion).length || !run.prompts.slice(intent.promptVersion).every(function operational(p) { return !!continuationAction(p); }) || intent.policyVersion !== run.policy.settingsVersion || intent.assignmentId)) continue;
    if (batch.dispatch && (batch.dispatch.intentId !== intent.id || batch.dispatch.digest !== decision.digest || batch.dispatch.next !== decision.next)) continue;
    batch.dispatch = { intentId: intent.id, digest: decision.digest, next: decision.next };
    // 已用原游标承接的历史批准通知仅作审计，保留迟到的 steer 和原回执。
    for (const notice of run.pending ?? []) if (notice.kind === "host" && notice.state === "pending" && !notice.decision &&
      [`batch:${batch.digest}:approved`, `batch:${batch.planVersion}:${batch.digest}:approved`].some(function original(key) { return notice.id === orchestrationId(run.id, "host", key, notice.basis); })) notice.state = "decided";
    intent.basis = basis; intent.state = "pending"; decision.state = "saved"; decision.error = undefined; decision.expectedRevision = revision;
    return;
  }
}

/** 解析历史封批记录的顺序；新提审直接保留原 seal 请求身份。 */
function originalSeal(run: OrchestrationRun, batch: NonNullable<OrchestrationRun["batches"]>[number]) {
  const seals = run.records.filter(function seal(r) { return r.action === "seal"; });
  return batch.sealRequestId ?? (seals.length === run.batches?.length ? seals[run.batches.indexOf(batch)]?.requestId : undefined);
}

/** 旧版处理操作口令时也会升计划；要求每个差额都能由审批之后的原文记录解释。 */
function onlyControlChanges(run: OrchestrationRun, planVersion: number) {
  const difference = run.planVersion - planVersion;
  const lastDecision = run.records.map(function type(r) { return r.action; }).lastIndexOf("batchDecision");
  if (difference <= 0 || lastDecision < 0) return false;
  const later = run.records.slice(lastDecision + 1);
  const prompts = later.filter(function prompt(r) { return r.action === "prompt"; });
  return later.every(function unchanged(r) { return ["prompt", "continue", "resubmit"].includes(r.action); }) && prompts.length === difference
    && run.prompts.slice(-difference).every(function operation(p) { return !p.queue && !!continuationAction(p) && prompts.some(function recorded(r) { return r.promptVersion === p.version; }); });
}

/** 按原合同重提完整清单；跨版本沿用旧批准须证明仅发生操作口令并找到原游标。 */
function continueBatch(run: OrchestrationRun, control: "continue" | "resubmit") {
  const batch = run.batches?.at(-1);
  if (!batch || !matchesBatch(run, batch)) return;
  if (batch.planVersion === run.planVersion && control === "continue") { linkBatchDispatch(run, batch, run.revision); return; }
  if (batch.planVersion === run.planVersion && (batch.state === "pending" || batch.state === "approved" && batch.dispatch)) return;
  const adopt = control === "continue";
  const approvedId = orchestrationId(run.id, String(batch.planVersion), batch.digest, "true");
  const legacyId = orchestrationId(batch.digest, "true");
  if (adopt && (batch.state !== "approved" || !batch.decidedByHuman || !onlyControlChanges(run, batch.planVersion)
    || !run.records.some(function approval(r) { return r.action === "batchDecision" && (r.requestId === approvedId || r.requestId === legacyId); }))) return;
  const tasks = batch.assignmentIds.map(function original(id) { return run.assignments.find(function task(a) { return a.id === id; }); });
  if (!tasks.every(function current(a) {
    return !!a && a.state === "planned" && !a.execution && !a.receipt && !a.takeover && a.checkout === run.checkout
      && run.steps.some(function step(s) { return s.id === a.stepId && s.currentAssignmentId === a.id; }) && a.promptVersion === assignmentPrompts(run, a).at(-1)?.version;
  })) return;
  const sealRequestId = originalSeal(run, batch);
  if (batch.planVersion === run.planVersion) run.planVersion++;
  const current = { ...batch, planVersion: run.planVersion, state: adopt ? "approved" as const : "pending" as const, decidedByHuman: adopt || undefined, sealRequestId, dispatch: undefined };
  for (const a of tasks) a!.planVersion = run.planVersion;
  run.batches!.push(current);
  for (const notice of run.pending ?? []) if (notice.kind === "host" && notice.source === "human" && !notice.decision && notice.state === "pending" &&
    [`batch:${batch.digest}:${batch.state}`, `batch:${batch.planVersion}:${batch.digest}:${batch.state}`].some(function original(key) { return notice.id === orchestrationId(run.id, "host", key, notice.basis); })) notice.state = "stale";
  run.revision++;
  if (adopt) {
    linkBatchDispatch(run, current, run.revision);
    if (!current.dispatch) { current.state = "pending"; current.decidedByHuman = undefined; }
  }
}

/** 封批前不能部分创建；一次确认只覆盖该版完整清单。 */
export function requireBatch(run: OrchestrationRun, assignment: OrchestrationAssignment): void {
  const batch = run.batches?.find(function target(b) { return b.planVersion === assignment.planVersion && b.assignmentIds.includes(assignment.id); });
  if (!batch || batch.state !== "approved" || batch.planVersion !== run.planVersion || batch.digest !== batchDigest(run, batch.assignmentIds)) throw new Error("ORCHESTRATION_BATCH_NOT_APPROVED");
}

/** 仅为指定独立复核读取当前上游已完整释放的交付物，普通 partial 不具有此资格。 */
function reviewSource(ledger: OrchestrationLedger, run: OrchestrationRun, stepId: string) {
  const source = run.steps.find(function step(s) { return s.id === stepId; });
  const item = run.assignments.find(function current(a) { return a.id === source?.currentAssignmentId; });
  const result = releasedDelivery(ledger, run, item);
  if (item && result && (result.outcome === "delivered" || result.outcome === "partial" && result.verificationPending === true)) return { item, result };
}

/** 正式验收只消费当前独立委派对冻结交付物的实际同版结果。 */
function completedReview(ledger: OrchestrationLedger, run: OrchestrationRun, stepId: string, verification: OrchestrationAssignment | undefined, item: OrchestrationAssignment, result: AssignmentResult, evidence: EvidenceReference[]): boolean {
  const step = run.steps.find(function current(s) { return s.id === verification?.stepId; });
  const reviewed = releasedDelivery(ledger, run, verification);
  const documents = evidence.filter(function document(e) { return isReviewDocument(e.artifact, e.contentVersion); });
  return !!verification?.execution && step?.verifies?.stepId === stepId && step.currentAssignmentId === verification.id
    && verification.execution.sessionId !== item.execution?.sessionId && verification.verification?.assignmentId === item.id
    && verification.verification.resultId === result.id && reviewed?.outcome === "delivered"
    && matchingEvidence(reviewed.evidence, evidence)
    && (!step.verifies.browser || documents.length > 0 && matchingEvidence(reviewed.browserObservations ?? [], documents));
}

/** 接续提示和正式派工共用依赖证据门；此处只读，不取得租约或启动执行。 */
function dispatchVerification(ledger: OrchestrationLedger, run: OrchestrationRun, item: OrchestrationAssignment) {
  const step = run.steps.find(function target(s) { return s.id === item.stepId; })!;
  if (step.currentAssignmentId !== item.id || step.dependencies.some(function unmet(id) { return id !== step.verifies?.stepId && !run.steps.find(function target(s) { return s.id === id; })?.verdict?.accepted; })) throw new Error("ORCHESTRATION_DEPENDENCY_PENDING");
  if (!step.verifies) return undefined;
  const source = reviewSource(ledger, run, step.verifies.stepId);
  if (!source) throw new Error("ORCHESTRATION_DEPENDENCY_PENDING");
  if (step.verifies.browser && !source.result.evidence.some(function document(e) { return isReviewDocument(e.artifact, e.contentVersion); })) throw new Error("ORCHESTRATION_VERIFICATION_DOCUMENT_REQUIRED");
  return { assignmentId: source.item.id, resultId: source.result.id, evidence: source.result.evidence, browser: step.verifies.browser };
}

/** 只为当前已释放交付的待验收或原计划下游生成接续身份，不替主控作决定。 */
export function releasedContinuationKey(ledger: OrchestrationLedger, run: OrchestrationRun, item?: OrchestrationAssignment): string | undefined {
  if (!item || run.navigationRemoved || run.acceptance === "accepted" || item.takeover || item.retiredForRepair
    || item.planVersion !== run.planVersion || finishCoversStep(run, item.stepId)) return;
  const step = run.steps.find(function current(s) { return s.id === item.stepId && s.currentAssignmentId === item.id && s.revision === item.revision; });
  const result = releasedDelivery(ledger, run, item);
  if (!step || !result || !(result.outcome === "delivered" || result.outcome === "partial" && result.verificationPending)) return;
  const waiting = run.assignments.filter(function waiting(a) {
    const dependent = run.steps.find(function target(s) { return s.id === a.stepId; });
    if (a.state !== "planned" || a.takeover || a.retiredForRepair || a.planVersion !== run.planVersion || dependent?.currentAssignmentId !== a.id
      || !dependent.dependencies.includes(step.id) || finishCoversStep(run, a.stepId) || a.promptVersion !== assignmentPrompts(run, a).at(-1)?.version) return false;
    try { requireBatch(run, a); requireCompatibleWorkflow(a); return true; }
    catch { return false; }
  });
  if (!waiting.length) return;
  const reviews = run.steps.filter(function reviewer(s) { return s.verifies?.stepId === step.id; });
  const accepted = step.verdict?.accepted && step.verdict.assignmentId === item.id && step.verdict.resultId === result.id;
  const source = step.verifies && reviewSource(ledger, run, step.verifies.stepId);
  const canAccept = !accepted && (reviews.length
    ? reviews.some(function verified(s) { return completedReview(ledger, run, step.id, run.assignments.find(function current(a) { return a.id === s.currentAssignmentId; }), item, result, result.evidence); })
    : !step.verifies && result.outcome === "delivered" && !assignmentPrompts(run, item).some(function independent(p) { return p.independentVerification; })
      || !!source && completedReview(ledger, run, step.verifies!.stepId, item, source.item, source.result, source.result.evidence));
  const downstream = waiting.filter(function ready(a) {
    try { dispatchVerification(ledger, run, a); return true; }
    catch { return false; }
  }).map(function identity(a) { return [a.id, a.revision, a.promptVersion, a.startRequestId]; });
  if (!canAccept && !downstream.length) return;
  return orchestrationId(JSON.stringify({ planVersion: run.planVersion, step: step.id, revision: step.revision, execution: item.execution, result: result.id, canAccept, waiting: waiting.map(function identity(a) { return [a.id, a.revision, a.startRequestId]; }), downstream }));
}

/** 仅供 main 内受信装配；不把此对象、原始 channel 或 actor 参数暴露给 Renderer/模型。 */
export class OrchestrationService {
  private resuming = new Set<string>();
  constructor(readonly store: OrchestrationStore, private channel: Channel, private checkoutRoot: string, private facts?: ManagedFactsHost,
    private checkoutNotice?: (runId: string, holders: CheckoutHolder[], acquired: boolean) => void) {}

  /** 在同一关系事务内核实持有者、释放已静止的精确租约、立即登记新持有者。 */
  private async reserveExecutionCheckout(ledger: OrchestrationLedger, run: OrchestrationRun, claim: Pick<OrchestrationAssignment, "id" | "checkout">): Promise<CheckoutHolder[]> {
    const leases = ledger.leases ?? [];
    if (leases.some(function own(lease) { return lease.runId === run.id && lease.assignmentId === claim.id; })) return [];
    const conflicts = leases.filter(function overlap(lease) { return checkoutOverlaps(lease, claim.checkout); });
    const service = this;
    const observed = await Promise.all(conflicts.map(async function describe(lease) {
      const holder = ledger.runs.find(function original(candidate) { return candidate.id === lease.runId; });
      const assignment = !lease.controllerExecution ? holder?.assignments.find(function original(item) { return item.id === lease.assignmentId; }) : undefined;
      const execution = lease.controllerExecution ?? assignment?.execution;
      const detail: CheckoutHolder = { workspaceId: holder?.workspaceId, runId: lease.runId, assignmentId: lease.controllerExecution ? undefined : lease.assignmentId,
        execution, resuming: !!execution && service.resuming.has(execution.sessionId), disconnected: false };
      if (!execution || holder?.hostId !== service.channel.identity.hostId || execution.hostId !== service.channel.identity.hostId || holder.checkout !== service.checkoutRoot) {
        detail.disconnected = !!execution;
        return { lease, holder, assignment, detail };
      }
      try {
        const activity = await service.channel.command({ operation: "lease_activity", requestId: randomUUID(), sessionId: execution.sessionId }) as ManagedLeaseActivity;
        if (activity?.sessionId === execution.sessionId) detail.activity = activity;
      } catch (error) {
        detail.disconnected = error instanceof Error && error.message === "MANAGED_NOT_CONNECTED";
      }
      const activity = detail.activity;
      if (execution.turnId && activity?.turnId === execution.turnId && activity.execution === "inactive" && activity.activeTurn === false && activity.activeJobs === false
        && !detail.resuming && (!assignment || assignment.state === "active" || assignment.state === "submitted")) {
        if ((activity.status === "waiting_user_input" && activity.waiting === "user_input") || (activity.status === "waiting_approval" && activity.waiting === "approval")) detail.available = "waiting";
        else if (!activity.waiting && activity.result === "failed") detail.available = "failed";
        else if (!assignment && !activity.waiting && ["completed", "interrupted", "limit_reached"].includes(activity.result ?? "")) detail.available = "settled";
      }
      return { lease, holder, assignment, detail };
    }));
    const holders = observed.map(function detail(item) { return item.detail; });
    if (holders.some(function held(holder) { return !holder.available; })) {
      this.checkoutNotice?.(run.id, holders, false);
      throw new Error("ORCHESTRATION_CHECKOUT_BUSY");
    }
    for (const { holder, assignment, detail } of observed) {
      if (assignment) {
        if (detail.available === "waiting") assignment.checkoutYielded = true;
        else { assignment.state = "released"; assignment.checkoutYielded = undefined; }
      }
      const action = detail.available === "waiting" ? "checkout_yield_waiting" : detail.available === "failed" ? "checkout_reclaim_failed" : "checkout_reclaim_settled";
      if (holder) {
        holder.records.push({ requestId: randomUUID(), digest: orchestrationId(JSON.stringify(detail.execution)), action: action + ":" + (detail.assignmentId ?? "controller"), at: new Date().toISOString() });
        holder.revision++;
        rebaseControllerCorrections(holder, holder.revision - 1);
      }
    }
    if (observed.length) ledger.leases = leases.filter(function keep(lease) { return !conflicts.includes(lease); });
    reserveCheckout(ledger, run, claim);
    return holders;
  }

  /** 执行继续命令前标记本会话在途，防止等待状态尚未翻转时租约被再次让出。 */
  private async withResuming<T>(sessionId: string, resume: () => Promise<T>): Promise<T> {
    if (this.resuming.has(sessionId)) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
    this.resuming.add(sessionId);
    try { return await resume(); }
    finally { this.resuming.delete(sessionId); }
  }

  /** 主控恢复先用与普通工具相同的门重新申请目录，原回复仍按原请求记录。 */
  async resumeController(workspaceId: string, sessionId: string, turnId: string, resume: () => Promise<ManagedRuntimeReceipt>): Promise<ManagedRuntimeReceipt> {
    const service = this;
    return this.withResuming(sessionId, async function reserveAndResume() {
      await service.admitControllerTool(workspaceId, sessionId, turnId);
      return resume();
    });
  }

  /** 登记 Run 并冻结策略；重复进入返回所选历史，显式新任务创建独立主控。 */
  async open(workspaceId: string, checkout: string, goal: string, settings: Omit<OrchestrationPolicy, "repairLimit"> & { repairLimit?: number }, idle = false, newTask = false, requestId?: string): Promise<OrchestrationRun> {
    const policy: OrchestrationPolicy = { ...settings, repairLimit: settings.repairLimit ?? 2 };
    if (!workspaceId || (!goal.trim() && !idle) || !Number.isSafeInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 || !Number.isSafeInteger(policy.repairLimit) || policy.repairLimit < 0 || !["local", "controller"].includes(policy.responsibility)) throw new Error("ORCHESTRATION_INVALID_POLICY");
    const hostId = this.channel.identity.hostId;
    checkout = await canonicalCheckout(checkout);
    if (checkout !== await canonicalCheckout(this.checkoutRoot)) throw new Error("ORCHESTRATION_CHECKOUT_MISMATCH");
    const store = this.store;
    return store.update(function open(ledger) {
      if (store.navigationRemoved(workspaceId)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
      const requestedId = requestId ? orchestrationId(hostId, workspaceId, requestId) : undefined;
      const existing = requestedId && ledger.runs.find(function same(run) { return run.id === requestedId; });
      if (existing && existing.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
      if (existing) { (ledger.currentRunIds ??= {})[workspaceId] = existing.id; return existing; }
      const previous = ledger.runs.find(function current(run) { return run.workspaceId === workspaceId && run.id === ledger.currentRunIds?.[workspaceId]; }) ?? ledger.runs.filter(function same(run) { return run.workspaceId === workspaceId; }).at(-1);
      if (previous?.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
      if (previous && !newTask) {
        if (previous.hostId !== hostId || previous.checkout !== checkout) throw new Error("ORCHESTRATION_SCOPE_DENIED");
        return previous;
      }
      const id = requestedId ?? (previous ? orchestrationId(hostId, workspaceId, randomUUID()) : orchestrationId(hostId, workspaceId));
      const run: OrchestrationRun = {
        id, workspaceId, hostId, checkout, goal, revision: 1, planVersion: 1, policy: structuredClone(policy),
        controller: { createRequestId: orchestrationId(id, "controller"), threadPolicy: "disabled", executor: "ap" },
        prompts: goal.trim() ? [{ version: 1, text: goal, scope: "run", targetId: id, at: new Date().toISOString() }] : [],
        steps: [], assignments: [], paused: false, acceptance: "pending", records: [],
      };
      ledger.runs.push(run); (ledger.currentRunIds ??= {})[workspaceId] = id; return run;
    });
  }

  /** 仅关联本 Run 原创建请求的受管 Session，Snapshot 再核对 Runtime 持久身份。 */
  async attachController(workspaceId: string, sessionId: string): Promise<void> {
    const service = this;
    await this.store.update(async function attach(ledger) {
      const run = requireRun(ledger.runs, workspaceId);
      if (sessionId !== orchestrationId(run.hostId, run.controller.createRequestId) || run.hostId !== service.channel.identity.hostId) throw new Error("ORCHESTRATION_SCOPE_DENIED");
      await service.channel.command({ operation: "snapshot", requestId: randomUUID(), sessionId });
      if (run.controller.execution && run.controller.execution.sessionId !== sessionId) throw new Error("ORCHESTRATION_CONTROLLER_FIXED");
      run.controller.execution = { ...service.channel.identity, sessionId, requestId: run.controller.createRequestId };
      run.revision++;
    });
    await this.facts?.register(sessionId);
  }

  /** 受信适配器绑定真实调用会话后返回闭包，消息字段没有 actor 提权入口。 */
  bind(workspaceId: string, actor: OrchestrationActor) {
    const service = this;
    const identity = structuredClone(actor);
    return {
      snapshot: async function snapshot() { return service.snapshot(workspaceId, identity); },
      events: async function events(assignmentId: string) { return service.events(workspaceId, identity, assignmentId); },
      command: async function command(input: RelationCommand, isCurrent?: () => boolean, stopped?: ExecutionReference) { return service.command(workspaceId, identity, input, isCurrent, stopped); },
      initialize: async function initialize() { return service.initialize(workspaceId, identity); },
      dispatch: async function dispatch(assignmentId: string, expectedRevision: number) { return service.dispatch(workspaceId, identity, assignmentId, expectedRevision); },
      control: async function control(input: AssignmentControl) { return service.control(workspaceId, identity, input); },
      pause: async function pause(expectedRevision: number, paused: boolean) { return service.setControl(workspaceId, identity, expectedRevision, paused); },
      takeover: async function takeover(expectedRevision: number, assignmentId: string) { return service.setControl(workspaceId, identity, expectedRevision, undefined, assignmentId); },
      release: async function release(expectedRevision: number, assignmentId: string, repairResultId?: string) { return service.release(workspaceId, identity, expectedRevision, assignmentId, repairResultId); },
      query: async function query(assignmentId: string, controlRequestId?: string) { return service.query(workspaceId, identity, assignmentId, controlRequestId); },
      continue: async function continueLocal(assignmentId: string, expectedRevision: number, requestId: string, content: string) { return service.continueLocal(workspaceId, identity, assignmentId, expectedRevision, requestId, content); },
      /** 仅宿主收尾驱动调用，模型的 continue 动作无法选择此路径。 */
      continueForFinish: async function continueForFinish(assignmentId: string, expectedRevision: number, noticeId: string, content: string) { return service.continueLocal(workspaceId, identity, assignmentId, expectedRevision, noticeId, content, true); },
      cancelUnstarted: async function cancelUnstarted(assignmentId: string, expectedRevision: number) { return service.cancelUnstarted(workspaceId, identity, assignmentId, expectedRevision); },
      abandonStopped: async function abandonStopped(assignmentId: string, expectedRevision: number) { return service.abandonStopped(workspaceId, identity, assignmentId, expectedRevision); },
    };
  }

  /** 人类放弃仅适用于精确 Turn 已终止且无 Job 的尝试，保留未完成义务与历史而不伪造交接。 */
  private async abandonStopped(workspaceId: string, actor: OrchestrationActor, assignmentId: string, expectedRevision: number) {
    if (actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
    const service = this;
    await this.store.update(async function abandon(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      const ref = item?.execution;
      if (!item || !ref?.turnId || run.revision !== expectedRevision || ref.owner !== service.channel.identity.owner || ref.generation !== service.channel.identity.generation || !["active", "submitted"].includes(item.state)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      if (item.controls?.some(function unknown(c) { return ["cancel", "stop_job"].includes(c.operation) && c.receipt.state !== "confirmed"; })) throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
      const activity = await service.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      const execution = activity.snapshot.execution;
      if (activity.activeJobs !== false || execution?.turnId !== ref.turnId || execution.execution !== "inactive" || execution.waiting || !["completed", "failed", "interrupted", "limit_reached"].includes(execution.result ?? "")) throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
      ledger.leases = (ledger.leases ?? []).filter(function keep(l) { return l.runId !== run.id || l.assignmentId !== item.id; });
      item.state = "cancelled"; item.takeover = true; run.revision++;
      run.records.push({ requestId: randomUUID(), digest: orchestrationId(JSON.stringify(ref)), action: "human_abandon_stopped:" + item.id, at: new Date().toISOString() });
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 人类显式放弃仅创建未启动的原尝试；必须先通过当前 owner、空 Turn、无 Job 和原 start 账本核查。 */
  private async cancelUnstarted(workspaceId: string, actor: OrchestrationActor, assignmentId: string, expectedRevision: number) {
    if (actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
    const service = this;
    await this.store.update(async function cancel(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      if (!item?.execution || run.revision !== expectedRevision || item.state !== "submitted" || item.execution.owner !== service.channel.identity.owner || item.execution.generation !== service.channel.identity.generation) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const notCreated = finishCoversStep(run, item.stepId) && item.submission === "create" && item.receipt?.requestId === item.createRequestId && item.receipt.code === "MANAGED_REQUEST_UNKNOWN";
      const activity = notCreated ? undefined : await service.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: item.execution.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      const original = await service.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: item.startRequestId }) as ManagedRuntimeReceipt;
      if (activity?.snapshot.execution || activity?.activeJobs || original.code !== "MANAGED_REQUEST_UNKNOWN") throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
      item.local.handoff = true; item.local.obligations = []; item.local.cooperation = [];
      item.receipt = { requestId: item.startRequestId, state: "confirmed", code: "MANAGED_NOT_STARTED_CANCELLED" };
      releaseCheckout(ledger, run, item, true, false); item.state = "cancelled";
      item.results.push({ id: orchestrationId(item.id, "human-unstarted"), revision: item.revision, promptVersion: item.promptVersion, summary: "已按原请求核查并取消未启动尝试", outcome: "cancelled", checks: [notCreated ? "原 create 和 start 均无记录" : "原 start 无记录、Session 无 Turn、无活动 Job"], unresolved: [], evidence: [] });
      run.revision++; run.records.push({ requestId: orchestrationId(item.id, "human-unstarted"), digest: orchestrationId(JSON.stringify(item.execution)), action: "human_cancel_unstarted", at: new Date().toISOString() });
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 首次进入仅创建固定主控 Session，不启动主控 Turn；启动与唤醒归 S6。 */
  private async initialize(workspaceId: string, actor: OrchestrationActor) {
    if (actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
    const service = this;
    const sessionId = await this.store.update(async function create(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      if (run.controller.execution) return run.controller.execution.sessionId;
      const receipt = await service.channel.command({ operation: "create", requestId: run.controller.createRequestId, ...(run.policy.permissionMode ? { permissionMode: run.policy.permissionMode } : {}) }) as ManagedRuntimeReceipt;
      if (receipt.state !== "confirmed" || receipt.sessionId !== orchestrationId(run.hostId, run.controller.createRequestId)) throw new Error("ORCHESTRATION_CONTROLLER_UNCONFIRMED");
      return receipt.sessionId;
    });
    await this.attachController(workspaceId, sessionId);
    return this.snapshot(workspaceId, actor);
  }

  /** 派工先持久预留预算/资源/原身份，再进入 Runtime；重复请求只返回原状态。 */
  private async dispatch(workspaceId: string, actor: OrchestrationActor, assignmentId: string, expectedRevision: number) {
    if (actor.kind === "executor") throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
    const service = this;
    const admitted = await this.store.update(async function admit(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      if (!item) throw new Error("ORCHESTRATION_ASSIGNMENT_MISSING");
      if (finishCoversStep(run, item.stepId)) throw new Error("ORCHESTRATION_FINISHING");
      if (item.state !== "planned") return false;
      if (run.revision !== expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      if (run.paused || run.controlOnly || item.takeover) throw new Error("ORCHESTRATION_AUTOMATION_PAUSED");
      if (!run.controller.execution) throw new Error("ORCHESTRATION_CONTROLLER_UNCONFIRMED");
      if (run.controller.executor !== "ap") throw new Error("ORCHESTRATION_EXECUTOR_UNSUPPORTED");
      if (item.checkout !== run.checkout) throw new Error("ORCHESTRATION_CHECKOUT_MISMATCH");
      requireBatch(run, item); requireCompatibleWorkflow(item);
      if (item.promptVersion !== assignmentPrompts(run, item).at(-1)!.version) throw new Error("ORCHESTRATION_PROMPT_STALE");
      item.verification = dispatchVerification(ledger, run, item);
      reserveBudget(run, item);
      const holders = await service.reserveExecutionCheckout(ledger, run, item);
      item.state = "submitted"; item.submission = "create"; item.unsent = "create";
      item.execution = { hostId: run.hostId, owner: service.channel.identity.owner, generation: service.channel.identity.generation, sessionId: orchestrationId(run.hostId, item.createRequestId), requestId: item.startRequestId, turnId: orchestrationId(run.hostId, orchestrationId(run.hostId, item.createRequestId), item.startRequestId) };
      item.receipt = { requestId: item.createRequestId, state: "unconfirmed" }; run.revision++;
      run.records.push({ requestId: item.startRequestId, digest: orchestrationId(assignmentInput(run, item)), action: "dispatch_admitted", at: new Date().toISOString() });
      return { runId: run.id, holders };
    });
    const reserved = requireRun((await this.store.read()).runs, workspaceId).assignments.find(function target(a) { return a.id === assignmentId; });
    if (reserved?.state === "submitted") {
      if (!admitted && !reserved.unsent) await this.query(workspaceId, actor, assignmentId);
      if (admitted && admitted.holders.length) this.checkoutNotice?.(admitted.runId, admitted.holders, true);
      // 先持久领取，跨发送边界崩溃保留未知；仅明确发送前断连可归还。
      const create = await this.store.update(function claim(ledger) {
        const run = requireRun(ledger.runs, workspaceId);
        const a = run.assignments.find(function target(a) { return a.id === assignmentId; })!;
        if (a.unsent !== "create" || a.state !== "submitted" || run.paused || run.controlOnly || a.takeover || finishCoversStep(run, a.stepId)) return false;
        requireBatch(run, a);
        if (a.execution?.owner !== service.channel.identity.owner || a.execution.generation !== service.channel.identity.generation) return false;
        a.unsent = undefined; return true;
      });
      if (create) await this.store.update(async function create(ledger) {
        const run = requireRun(ledger.runs, workspaceId);
        const item = run.assignments.find(function target(a) { return a.id === assignmentId; })!;
        if (run.paused || run.controlOnly || item.takeover || item.state !== "submitted" || finishCoversStep(run, item.stepId)) { item.unsent = "create"; return; }
        requireBatch(run, item);
        try { item.receipt = await service.channel.command({ operation: "create", requestId: item.createRequestId, ...(run.policy.permissionMode ? { permissionMode: run.policy.permissionMode } : {}) }) as ManagedRuntimeReceipt; }
        catch (error) { if (error instanceof Error && error.message === "MANAGED_NOT_CONNECTED") item.unsent = "create"; item.receipt = { requestId: item.createRequestId, state: "unconfirmed" }; }
        if (item.receipt.requestId !== item.createRequestId || item.receipt.operation && item.receipt.operation !== "create" || item.receipt.sessionId && item.receipt.sessionId !== item.execution!.sessionId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
        if (item.receipt.state === "confirmed" && item.receipt.sessionId === item.execution!.sessionId) item.sessionConfirmed = true;
        run.revision++;
      });
      const startAdmitted = await this.store.update(function prepareStart(ledger) {
        const run = requireRun(ledger.runs, workspaceId);
        const item = run.assignments.find(function target(a) { return a.id === assignmentId; })!;
        if (run.paused || run.controlOnly || item.takeover || item.state !== "submitted" || finishCoversStep(run, item.stepId)
          || item.execution?.owner !== service.channel.identity.owner || item.execution.generation !== service.channel.identity.generation) return false;
        if (item.unsent !== "start" && !(item.submission === "create" && item.sessionConfirmed && item.receipt?.state === "confirmed" && !item.receipt.code
          && item.receipt.requestId === item.createRequestId && item.receipt.sessionId === item.execution.sessionId)) return false;
        if (!run.records.some(function original(r) { return r.action === "dispatch_admitted" && r.requestId === item.startRequestId && r.digest === orchestrationId(assignmentInput(run, item)); })
          || !ledger.leases?.some(function held(l) { return l.runId === run.id && l.assignmentId === item.id && l.checkout === item.checkout; })) return false;
        item.unsent = undefined;
        requireBatch(run, item);
        item.submission = "start";
        item.receipt = { requestId: item.startRequestId, state: "unconfirmed" };
        run.revision++; return true;
      });
      if (startAdmitted) await this.store.update(async function start(ledger) {
        const run = requireRun(ledger.runs, workspaceId);
        const item = run.assignments.find(function target(a) { return a.id === assignmentId; })!;
        if (run.paused || run.controlOnly || item.takeover || finishCoversStep(run, item.stepId)) { item.unsent = "start"; return; }
        requireBatch(run, item);
        // start 原身份和阶段已经落盘；跨存储失败后仅 query，不重发。
        try { item.receipt = await service.channel.command({ operation: "start", requestId: item.startRequestId, sessionId: item.execution!.sessionId, content: assignmentInput(run, item) }) as ManagedRuntimeReceipt; }
        catch (error) { if (error instanceof Error && error.message === "MANAGED_NOT_CONNECTED") item.unsent = "start"; item.receipt = { requestId: item.startRequestId, state: "unconfirmed" }; }
        if (item.receipt.operation && item.receipt.operation !== "start" || item.receipt.requestId !== item.startRequestId || item.receipt.sessionId && item.receipt.sessionId !== item.execution!.sessionId || item.receipt.turnId && item.receipt.turnId !== item.execution!.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
        if (!item.receipt.code && item.receipt.state === "started" && item.receipt.turnId === item.execution!.turnId) item.state = "active";
        run.revision++;
      });
      const run = requireRun((await this.store.read()).runs, workspaceId);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; })!;
      if (item.receipt?.sessionId) await this.facts?.register(item.execution!.sessionId);
    }
    return this.snapshot(workspaceId, actor);
  }

  /** 局部流程跨 Turn 延续仍占原租约；先记原身份，新工作必须另建委派。 */
  private async continueLocal(workspaceId: string, actor: OrchestrationActor, assignmentId: string, expectedRevision: number, requestId: string, content: string, finishing = false) {
    if (actor.kind === "executor" || finishing && actor.kind !== "controller" || !content?.trim()) throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
    const service = this;
    /** 收尾专用续跑只消费账本中尚未结算的原通知。 */
    function allowed(run: OrchestrationRun, item: OrchestrationAssignment) {
      return finishing ? run.finishes?.some(function pending(f) {
        return !f.receipt && f.targets.some(function target(t) { return t.assignmentId === item.id && t.noticeId === requestId; });
      }) === true : !finishCoversStep(run, item.stepId);
    }
    const admitted = await this.store.update(async function prepare(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      if (item?.controls?.some(function exists(c) { return c.requestId === requestId; })) return false;
      if (item && !allowed(run, item)) throw new Error("ORCHESTRATION_FINISHING");
      if (run.revision !== expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      // 尚有义务/协作等待表示交接未完成，可在原租约下续行补交接，不能绕过release门。
      const handedOff = item?.local.handoff && item.local.obligations.length === 0 && item.local.cooperation.length === 0;
      if (!item?.execution || item.state !== "active" || item.takeover || run.paused || run.controlOnly || handedOff || !ledger.leases?.some(function owned(l) { return l.runId === run.id && l.assignmentId === item.id; })) throw new Error("ORCHESTRATION_CONTINUE_DENIED");
      if (item.execution.owner !== service.channel.identity.owner || item.execution.generation !== service.channel.identity.generation) throw new Error("ORCHESTRATION_STALE_OWNER");
      const activity = await service.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: item.execution.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      if (activity.activeJobs || !activity.snapshot.execution || activity.snapshot.execution.turnId !== item.execution.turnId || activity.snapshot.execution.execution !== "inactive" || activity.snapshot.execution.waiting || !["completed", "failed"].includes(activity.snapshot.execution.result ?? "")) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
      const previous = item.execution;
      const previousReceipt = item.receipt;
      (item.previousExecutions ??= []).push(previous);
      item.execution = { ...previous, requestId, turnId: orchestrationId(run.hostId, previous.sessionId, requestId) };
      (item.controls ??= []).push({ requestId, operation: "start", digest: orchestrationId(content), receipt: { requestId, state: "unconfirmed" } });
      item.receipt = { requestId, state: "unconfirmed" }; run.revision++;
      return { previous, previousReceipt, next: item.execution, content: JSON.stringify({ context: assignmentInput(run, item), supplement: activity.snapshot.execution.result === "failed" ? "原 Turn 已失败；本次仅核查已有产物并补真实交接报告。尊重用户拒绝，不得重试被拒操作，不得把未运行的检查记为通过。\n" + content : content }) };
    });
    if (admitted) {
      const blocked = await this.store.update(async function send(ledger) {
        const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
        const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
        const control = item?.controls?.find(function target(c) { return c.requestId === requestId; });
        if (!item?.execution || !control || !sameExecution(item.execution, admitted.next) || item.state !== "active") throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
        // 发送与收尾共用同一把关系锁。收尾先落盘时，撤回还未发送的原席位变更。
        if (!allowed(run, item)) {
          control.receipt = { requestId, operation: "start", sessionId: admitted.next.sessionId, turnId: admitted.next.turnId, state: "rejected", code: "ORCHESTRATION_FINISHING" };
          item.execution = admitted.previous;
          item.previousExecutions?.pop();
          item.receipt = admitted.previousReceipt;
          run.revision++;
          return true;
        }
        try { control.receipt = await service.channel.command({ operation: "start", requestId, sessionId: admitted.next.sessionId, previousTurnId: admitted.previous.turnId, content: admitted.content }) as ManagedRuntimeReceipt; }
        catch { control.receipt = { requestId, state: "unconfirmed" }; }
        item.receipt = control.receipt;
        run.revision++;
        return false;
      });
      if (blocked) throw new Error("ORCHESTRATION_FINISHING");
    }
    return this.snapshot(workspaceId, actor);
  }

  /** 未知提交只查询原创建/启动请求，不释放占用或启动下一次尝试。 */
  private async query(workspaceId: string, actor: OrchestrationActor, assignmentId: string, controlRequestId?: string) {
    const service = this;
    await this.store.update(async function query(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      if (!item?.execution || (actor.kind === "executor" && item.execution.sessionId !== actor.sessionId)) throw new Error("ORCHESTRATION_SCOPE_DENIED");
      const control = controlRequestId ? item.controls?.find(function target(c) { return c.requestId === controlRequestId; }) : undefined;
      if (controlRequestId && !control) throw new Error("ORCHESTRATION_SCOPE_DENIED");
      if (control?.receipt.state === "rejected" && control.receipt.code === "ORCHESTRATION_FINISHING") return;
      const targetRequestId = controlRequestId ?? (item.submission === "create" ? item.createRequestId : item.startRequestId);
      const receipt = await service.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId }) as ManagedRuntimeReceipt;
      if (!control && receipt.operation && receipt.operation !== item.submission || receipt.requestId !== targetRequestId || receipt.sessionId && receipt.sessionId !== item.execution.sessionId || !control && receipt.turnId && receipt.turnId !== item.execution.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const active = !control && item.state === "submitted" && item.submission === "start" && (!receipt.operation || receipt.operation === "start") && !receipt.code
        && receipt.sessionId === item.execution.sessionId && receipt.turnId === item.execution.turnId && ["started", "confirmed"].includes(receipt.state);
      if (active) { item.state = "active"; item.sessionConfirmed = true; }
      if (!control && item.submission === "create" && receipt.operation === "create" && receipt.state === "confirmed" && receipt.sessionId === item.execution.sessionId) item.sessionConfirmed = true;
      if (!active && JSON.stringify(receipt) === JSON.stringify(control?.receipt ?? item.receipt)) return;
      if (control) control.receipt = receipt;
      if (!control || ["cancel", "stop_job"].includes(control.operation) || control.operation === "start" && item.execution.requestId === control.requestId) item.receipt = receipt;
      run.revision++;
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 暂停只冻结外层派工；接管不停止现有执行，但禁止自动复用。 */
  private async setControl(workspaceId: string, actor: OrchestrationActor, expectedRevision: number, paused?: boolean, assignmentId?: string) {
    if (actor.kind === "executor" || (assignmentId && actor.kind !== "human")) throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
    const service = this;
    await this.store.update(function set(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      if (run.revision !== expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      if (assignmentId) {
        const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
        if (!item) throw new Error("ORCHESTRATION_ASSIGNMENT_MISSING"); item.takeover = true;
      } else run.paused = paused!;
      run.records.push({ requestId: randomUUID(), digest: "", action: assignmentId ? `takeover:${assignmentId}` : `pause:${paused}`, at: new Date().toISOString() });
      run.revision++;
      if (!assignmentId) rebaseControllerCorrections(run, run.revision - 1);
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 精确控制不接收 Session 或 Turn 覆盖字段，人类审批只能从绑定人类的入口进入。 */
  private async control(workspaceId: string, actor: OrchestrationActor, input: AssignmentControl) {
    if (input.command.operation !== "resume") return this.applyControl(workspaceId, actor, input);
    const service = this;
    return this.withResuming(input.execution.sessionId, function resume() { return service.applyControl(workspaceId, actor, input); });
  }

  /** 恢复等待的委派在保存命令前重新占用目录，冲突时原决定与请求仍可重试。 */
  private async applyControl(workspaceId: string, actor: OrchestrationActor, input: AssignmentControl) {
    if (actor.kind === "executor") throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
    const allowed = ["steer", "queue", "cancel", "resume", "approval", "answer", "cancel_input", "stop_job"];
    if (!allowed.includes(input.command.operation)) throw new Error("ORCHESTRATION_CONTROL_DENIED");
    if (["approval", "answer"].includes(input.command.operation) && actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
    const service = this;
    const admitted = await this.store.update(async function admitControl(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      if (run.revision !== input.expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      const item = run.assignments.find(function target(a) { return a.id === input.assignmentId; });
      if (!item?.execution || !sameExecution(item.execution, input.execution) || item.state === "released" || item.state === "cancelled") throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      if (item.execution.owner !== service.channel.identity.owner || item.execution.generation !== service.channel.identity.generation) throw new Error("ORCHESTRATION_OWNER_RECONCILIATION_REQUIRED");
      if (item.takeover && actor.kind !== "human") throw new Error("ORCHESTRATION_AUTOMATION_PAUSED");
      if (run.finishes?.some(function stopped(f) { return f.stop; }) && ["resume", "steer", "queue"].includes(input.command.operation)) throw new Error("ORCHESTRATION_FINISHING");
      if (["resume", "steer", "queue"].includes(input.command.operation)) {
        if (run.controlOnly) throw new Error("ORCHESTRATION_EXECUTION_RECOVERY_REQUIRED");
        requireCompatibleWorkflow(item);
        if (item.local.handoff || !(input.command.operation === "resume" && item.checkoutYielded)
          && !(ledger.leases ?? []).some(function own(l) { return l.runId === run.id && l.assignmentId === item.id; })) throw new Error("ORCHESTRATION_HANDOFF_INCOMPLETE");
      }
      const digest = orchestrationId(JSON.stringify(input.command), JSON.stringify(actor));
      const previous = item.controls?.find(function prior(c) { return c.requestId === input.command.requestId; });
      if (previous) { if (previous.digest !== digest) throw new Error("ORCHESTRATION_REQUEST_CONFLICT"); return false; }
      const holders = input.command.operation === "resume" ? await service.reserveExecutionCheckout(ledger, run, item) : [];
      if (input.command.operation === "resume") item.checkoutYielded = undefined;
      if (actor.kind === "human" && ["steer", "queue"].includes(input.command.operation)) {
        if (!input.command.content?.trim()) throw new Error("ORCHESTRATION_INVALID_COMMAND");
        run.prompts.push({ version: run.prompts.length + 1, text: input.command.content, scope: "assignment", targetId: item.id, at: new Date().toISOString() });
        const step = run.steps.find(function target(s) { return s.currentAssignmentId === item.id; });
        if (step) step.verdict = undefined;
        run.planVersion++; run.acceptance = "pending";
      }
      (item.controls ??= []).push({ requestId: input.command.requestId, operation: input.command.operation, digest, receipt: { requestId: input.command.requestId, state: "unconfirmed" } });
      run.revision++;
      return { runId: run.id, holders };
    });
    if (admitted && admitted.holders.length) this.checkoutNotice?.(admitted.runId, admitted.holders, true);
    if (admitted) await this.store.update(async function executeControl(ledger) {
      const run = requireRun(ledger.runs, workspaceId);
      const item = run.assignments.find(function target(a) { return a.id === input.assignmentId; })!;
      const control = item.controls!.find(function target(c) { return c.requestId === input.command.requestId; })!;
      if (!item.execution || !sameExecution(item.execution, input.execution) || ["released", "cancelled"].includes(item.state)) return;
      if (run.finishes?.some(function stopped(f) { return f.stop; }) && ["resume", "steer", "queue"].includes(input.command.operation)) {
        control.receipt = { ...control.receipt, state: "rejected", code: "ORCHESTRATION_FINISHING" }; return;
      }
      if (["resume", "steer", "queue"].includes(input.command.operation) && !ledger.leases?.some(function own(l) { return l.runId === run.id && l.assignmentId === item.id; })) return;
      if (item.takeover && actor.kind !== "human") return;
      const content = ["steer", "queue"].includes(input.command.operation) ? JSON.stringify({ context: assignmentInput(run, item), supplement: input.command.content }) : input.command.content;
      try { control.receipt = await service.channel.command({ ...input.command, content, sessionId: item.execution!.sessionId, turnId: item.execution!.turnId }, actor.kind === "human") as ManagedRuntimeReceipt; }
      catch { control.receipt = { requestId: input.command.requestId, state: "unconfirmed" }; }
      if (["cancel", "stop_job"].includes(input.command.operation)) item.receipt = control.receipt;
      run.revision++;
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 普通释放须完成交接；改派前可凭精确的停止事实和未交付报告退役旧尝试。 */
  private async release(workspaceId: string, actor: OrchestrationActor, expectedRevision: number, assignmentId: string, repairResultId?: string) {
    if (actor.kind === "executor") throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
    const service = this;
    await this.store.update(async function release(ledger) {
      const run = requireRun(ledger.runs, workspaceId); service.authorize(run, actor);
      const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
      if (repairResultId && item?.retiredForRepair?.resultId === repairResultId && item.state === "cancelled" && (run.revision === expectedRevision || run.revision === expectedRevision + 1)) return;
      if (run.revision !== expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      if (!item?.execution || item.retiredForRepair) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      if (item.controls?.some(function unknown(c) { return ["cancel", "stop_job"].includes(c.operation) && c.receipt.state !== "confirmed"; })) throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
      const activity = await service.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: item.execution.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      const execution = activity.snapshot.execution;
      const inactive = activity.snapshot.sessionId === item.execution.sessionId && !!execution && execution.turnId === item.execution.turnId && execution.execution === "inactive" && !execution.waiting && ["completed", "failed", "interrupted", "limit_reached"].includes(execution.result ?? "");
      const latestResult = item.results.at(-1);
      if (repairResultId && latestResult?.id === repairResultId && ["blocked", "failed"].includes(latestResult.outcome)) {
        const ref = item.execution;
        const step = run.steps.find(function own(s) { return s.id === item.stepId; });
        if (!inactive || activity.activeJobs !== false || item.receipt?.requestId !== ref.requestId || item.receipt.sessionId !== ref.sessionId || item.receipt.turnId !== ref.turnId || item.receipt.code || !["started", "confirmed"].includes(item.receipt.state)
          || item.controls?.some(function unknown(c) { return c.receipt.state === "unconfirmed"; })) throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
        if (item.state !== "active" || item.takeover || run.controlOnly || run.paused || finishCoversStep(run, item.stepId) || ref.hostId !== service.channel.identity.hostId || ref.owner !== service.channel.identity.owner || ref.generation !== service.channel.identity.generation
          || !ref.turnId || latestResult.turnId !== ref.turnId || latestResult.revision !== item.revision || latestResult.promptVersion !== item.promptVersion || item.promptVersion !== assignmentPrompts(run, item).at(-1)?.version
          || step?.currentAssignmentId !== item.id) throw new Error("ORCHESTRATION_REPAIR_RESULT_STALE");
        if (step.repairs >= Math.min(run.policy.repairLimit, step.skillRepairLimit ?? Infinity)) throw new Error("ORCHESTRATION_REPAIR_LIMIT");
        ledger.leases = (ledger.leases ?? []).filter(function keep(lease) { return lease.runId !== run.id || lease.assignmentId !== item.id; });
        item.state = "cancelled";
        item.retiredForRepair = { turnId: ref.turnId, resultId: latestResult.id };
        run.revision++;
        return;
      }
      releaseCheckout(ledger, run, item, inactive, activity.activeJobs !== false);
      if (execution?.result === "completed") item.completedReleaseTurnId = execution.turnId;
      run.revision++;
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 普通主控工具在真实执行前占用原 Checkout 租约；与派工共用同一原子仲裁。 */
  async admitControllerTool(workspaceId: string, sessionId: string, turnId: string): Promise<void> {
    const service = this;
    const result = await this.store.update(async function admit(ledger) {
      const run = requireRun(ledger.runs, workspaceId);
      service.authorize(run, { kind: "controller", sessionId });
      if (run.finishes?.some(function stopped(f) { return f.stop; })) throw new Error("ORCHESTRATION_FINISHING");
      if (run.navigationRemoved || run.controlOnly && !isTerminalInputTurn(run, turnId)) throw new Error("ORCHESTRATION_AUTOMATION_PAUSED");
      const id = orchestrationId("controller", sessionId, turnId);
      const holders = await service.reserveExecutionCheckout(ledger, run, { id, checkout: run.checkout });
      const lease = ledger.leases!.find(function own(item) { return item.runId === run.id && item.assignmentId === id; })!;
      // 每次准入刷新占用令牌，阻止同 Turn 恢复或重新取锁后被迟到终态核查释放。
      lease.controllerAcquisitionId = randomUUID();
      lease.controllerExecution = { ...run.controller.execution!, turnId };
      return { runId: run.id, holders };
    });
    if (result.holders.length) this.checkoutNotice?.(result.runId, result.holders, true);
  }

  /** 主控目录占用跟随精确 Turn 与 Job 生命周期，断连、等待或错代次均保留。 */
  async reconcileControllerCheckout(workspaceId: string): Promise<void> {
    const service = this;
    const run = requireRun((await this.store.read()).runs, workspaceId);
    const ref = run.controller.execution;
    if (!ref || this.resuming.has(ref.sessionId) || ref.owner !== this.channel.identity.owner || ref.generation !== this.channel.identity.generation) return;
    const leases = (await this.store.read()).leases?.filter(function own(l) { return l.runId === run.id && l.controllerExecution?.sessionId === ref.sessionId; }) ?? [];
    if (!leases.length) return;
    const activity = await this.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
    const execution = activity.snapshot.execution;
    if (!execution || execution.execution !== "inactive" || !["completed", "failed", "interrupted", "limit_reached"].includes(execution.result ?? "") || execution.waiting || activity.activeJobs !== false) return;
    await this.store.update(function release(ledger) {
      const current = requireRun(ledger.runs, workspaceId).controller.execution;
      if (!current || !sameExecution(ref, current) || service.resuming.has(ref.sessionId)) return;
      ledger.leases = (ledger.leases ?? []).filter(function keep(lease) {
        return !leases.some(function same(previous) { return previous.controllerAcquisitionId === lease.controllerAcquisitionId && JSON.stringify(previous) === JSON.stringify(lease) && lease.controllerExecution?.turnId === execution.turnId; });
      });
    });
  }

  /** H2 已提交事实按 Session/Turn 精确关联；只更新原生层，不推进业务或执行工具。 */
  async reconcile(workspaceId: string): Promise<void> {
    const ledger = this.facts?.status().ledger;
    if (!ledger || ledger.hostId !== this.channel.identity.hostId) throw new Error("ORCHESTRATION_FACTS_UNAVAILABLE");
    await this.store.update(function reconcile(state) {
      const run = requireRun(state.runs, workspaceId);
      const batch = run.batches?.at(-1);
      if (batch?.decidedByHuman && batch.state === "approved" && !run.controlOnly && !run.paused && !finishCoversStep(run)) continueBatch(run, "continue");
      for (const assignment of run.assignments) {
        const ref = assignment.execution;
        const turn = ref?.turnId ? ledger.sessions[ref.sessionId]?.turns[ref.turnId] : undefined;
        if (ref?.turnId && turn && turn.sequence > (assignment.native?.sequence ?? 0)) assignment.native = { turnId: ref.turnId, ...turn, source: "core" };
      }
    });
  }

  /** 任务修订、结果和决定统一串行 CAS；同请求重试返回既有关系，不重放副作用。 */
  private async command(workspaceId: string, actor: OrchestrationActor, input: RelationCommand, isCurrent?: () => boolean, stopped?: ExecutionReference): Promise<OrchestrationRun> {
    if (!input || !/^[\w-]{1,128}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || Buffer.byteLength(JSON.stringify(input)) > 65536 || Object.keys(input).some(function extra(key) { return !["requestId", "expectedRevision", "action"].includes(key); })) throw new Error("ORCHESTRATION_INVALID_COMMAND");
    const command = structuredClone(input);
    // 人类原文重交不以宿主重新读取的 revision 改变身份；其他关系指令保留原 CAS 摘要。
    const digest = orchestrationId(JSON.stringify(actor.kind === "human" && (command.action?.type === "prompt" || command.action?.type === "batchDecision") ? { requestId: command.requestId, action: command.action } : command), JSON.stringify(actor));
    const service = this;
    await this.store.update(function mutate(ledger) {
      if (isCurrent && !isCurrent()) throw new Error("MANAGED_TERMINAL_STALE");
      const run = requireRun(ledger.runs, workspaceId);
      service.authorize(run, actor);
      const previous = run.records.find(function same(item) { return item.requestId === command.requestId; });
      if (previous) {
        if (previous.digest !== digest && !(command.action?.type === "batchDecision" && previous.digest === orchestrationId(JSON.stringify(command), JSON.stringify(actor)))) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
        return;
      }
      const action = command.action;
      if (actor.kind === "human" && action?.type === "prompt" && action.terminalInput) {
        const currentId = ledger.currentRunIds?.[run.workspaceId] ?? ledger.runs.filter(function same(r) { return r.workspaceId === run.workspaceId; }).at(-1)?.id;
        if (run.navigationRemoved || currentId !== run.id) throw new Error("ORCHESTRATION_RUN_MISMATCH");
      } else if (run.revision !== command.expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
      if (!action || !["step", "assign", "handoff", "report", "accept", "prompt", "revise", "seal", "batchDecision", "replan", "cancelPlanned", "acceptRun"].includes(action.type)) throw new Error("ORCHESTRATION_INVALID_COMMAND");
      if (actor.kind === "executor" && action.type !== "report") throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
      if (["step", "assign", "revise", "handoff"].includes(action.type) && run.batches?.some(function sealed(b) { return b.planVersion === run.planVersion; })) throw new Error("ORCHESTRATION_PLAN_SEALED");
      if (action.type === "acceptRun") {
        if (!run.steps.length || run.steps.some(function pending(s) {
          if (!s.verdict?.accepted || s.verdict.assignmentId !== s.currentAssignmentId) return true;
          if (!run.steps.some(function reviewer(review) { return review.verifies?.stepId === s.id; })) return false;
          const verification = run.assignments.find(function bound(a) { return a.id === s.verdict?.verificationAssignmentId; });
          const source = reviewSource(ledger, run, s.id);
          return !source || s.verdict.resultId !== source.result.id || !completedReview(ledger, run, s.id, verification, source.item, source.result, source.result.evidence);
        }) || run.assignments.some(function active(a) { return a.state !== "released" && a.state !== "cancelled"; })) throw new Error("ORCHESTRATION_HANDOFF_INCOMPLETE");
        run.acceptance = "accepted";
      } else if (action.type === "cancelPlanned") {
        const item = run.assignments.find(function target(a) { return a.id === action.assignmentId; });
        if (!item || item.state !== "planned") throw new Error("ORCHESTRATION_EXACT_CONTROL_REQUIRED");
        item.state = "cancelled";
      } else if (action.type === "replan") {
        const source = run.assignments.find(function target(a) { return a.id === action.assignmentId; });
        if (source && finishCoversStep(run, source.stepId)) throw new Error("ORCHESTRATION_FINISHING");
        const basis = `replan:${action.assignmentId}:${action.resultId}`;
        const batch = run.batches?.find(function former(b) { return b.planVersion === source?.planVersion && b.state === "approved" && b.assignmentIds.includes(source.id); });
        const unrelatedPlanned = run.assignments.some(function pending(a) {
          return a.state === "planned" && (!source || !batch?.assignmentIds.includes(a.id) || a.planVersion !== run.planVersion || !run.steps.find(function step(s) { return s.id === a.stepId; })?.dependencies.includes(source.stepId));
        });
        if (!action.reason?.trim() || !source?.results.some(function target(r) { return r.id === action.resultId; }) || unrelatedPlanned || run.records.some(function used(r) { return r.action === basis; })) throw new Error("ORCHESTRATION_REPLAN_BASIS_REQUIRED");
        run.planVersion++;
        run.acceptance = "pending";
        run.records.push({ requestId: command.requestId + "-basis", digest: orchestrationId(action.reason), action: basis, at: new Date().toISOString() });
      } else if (action.type === "handoff") {
        if (actor.kind !== "controller") throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
        const offer = action.handoff;
        const target = run.assignments.find(function planned(a) { return a.id === offer.assignmentId && a.state === "planned"; });
        const step = run.steps.find(function same(s) { return s.id === target?.stepId; });
        const prior = run.handoffs?.filter(function same(h) { return h.scope === offer.scope; }).at(-1);
        if (!target || !step || step.verifies || offer.scope !== step.scope || finishCoversStep(run, step.id) || target.id === offer.fromAssignmentId ||
          run.handoffs?.some(function already(h) { return h.assignmentId === target.id; }) ||
          prior && (!prior.received || prior.assignmentId !== offer.fromAssignmentId) ||
          offer.fromAssignmentId && !run.assignments.some(function owner(a) { return a.id === offer.fromAssignmentId; })) throw new Error("ORCHESTRATION_HANDOFF_TARGET_REQUIRED");
        (run.handoffs ??= []).push({ ...offer, requestId: command.requestId, revision: target.revision });
      } else if (action.type === "seal") {
        if (run.batches?.some(function exists(b) { return b.planVersion === run.planVersion; })) throw new Error("ORCHESTRATION_PLAN_SEALED");
        const planned = run.assignments.filter(function planned(a) { return a.state === "planned"; });
        if (!planned.length) throw new Error("ORCHESTRATION_EMPTY_BATCH");
        for (const item of planned) { item.planVersion = run.planVersion; }
        const digest = batchDigest(run, planned.map(function id(a) { return a.id; }));
        (run.batches ??= []).push({ sealRequestId: command.requestId, planVersion: run.planVersion, assignmentIds: planned.map(function id(a) { return a.id; }), digest, state: planned.length >= 3 || !run.policy.automaticDispatch ? "pending" : "approved" });
      } else if (action.type === "batchDecision") {
        if (actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
        const batch = run.batches?.find(function target(b) { return b.planVersion === action.planVersion; });
        if (!batch || batch.state !== "pending" || batch.planVersion !== run.planVersion || batch.digest !== action.digest || batch.digest !== batchDigest(run, batch.assignmentIds)) throw new Error("ORCHESTRATION_BATCH_STALE");
        batch.state = action.approve ? "approved" : "cancelled";
        batch.decidedByHuman = true;
        if (action.approve) linkBatchDispatch(run, batch, run.revision + 1);
      } else if (action.type === "prompt") {
        if (actor.kind !== "human") throw new Error("ORCHESTRATION_HUMAN_REQUIRED");
        if (finishCoversStep(run)) throw new Error("ORCHESTRATION_FINISHING");
        if (!action.text?.trim() || !(action.scope === "run" ? action.targetId === run.id : action.scope === "step" ? run.steps.some(function target(s) { return s.id === action.targetId; }) : action.scope === "assignment" && run.assignments.some(function target(a) { return a.id === action.targetId; }))) throw new Error("ORCHESTRATION_PROMPT_SCOPE_REQUIRED");
        const control = run.prompts.length && !action.queue && continuationAction(action);
        if (control) {
          if (run.revision !== command.expectedRevision) throw new Error("ORCHESTRATION_STALE_REVISION");
          if (control === "continue" && run.paused && !run.controlOnly) { run.paused = false; run.revision++; }
          const audit = { requestId: command.requestId, digest, action: control, text: action.text, at: new Date().toISOString() };
          continueBatch(run, control);
          const linked = run.batches?.at(-1)?.dispatch;
          const driving = linked && run.pending?.some(function original(i) { return i.id === linked.intentId && i.decision?.state === "saved"; });
          const manualContinue = stopped?.turnId && stopped.sessionId === run.controller.execution?.sessionId && stopped.generation === run.controller.execution.generation
            ? { sessionId: stopped.sessionId, generation: stopped.generation, turnId: stopped.turnId } : undefined;
          if (control === "continue" && (manualContinue || !driving && !run.assignments.some(function active(a) { return a.state === "active" || a.state === "submitted"; })) && run.acceptance !== "accepted" && !run.paused && !run.controlOnly && !run.batches?.some(function decision(b) { return b.planVersion === run.planVersion && b.state !== "approved"; })) {
            (run.pending ??= []).push({ id: orchestrationId(run.id, command.requestId, "continue"), kind: "host", source: "human", manualContinue, basis: intentBasis(run), promptVersion: run.prompts.length, policyVersion: run.policy.settingsVersion, state: "pending", at: audit.at, detail: "用户要求继续原任务。请核对当前任务及已有回执，沿原计划处理未完成事项。" });
          }
          run.records.push(audit);
          return;
        }
        if (!run.prompts.length) run.goal = action.text;
        run.prompts.push({ version: run.prompts.length + 1, text: action.text, scope: action.scope, targetId: action.targetId, at: new Date().toISOString(), independentVerification: action.independentVerification, attachments: action.attachments, selectedSkills: action.selectedSkills, activeSkills: action.activeSkills, flow: action.flow, ...(action.terminalInput ? { terminalInput: true, queue: action.queue, fileMentions: action.fileMentions } : {}) });
        if (!action.queue) {
          for (const step of run.steps) if (action.scope === "run" || (action.scope === "step" ? action.targetId === step.id : action.targetId === step.currentAssignmentId)) step.verdict = undefined;
          run.planVersion++;
          run.acceptance = "pending";
        }
      } else if (action.type === "revise") {
        const item = run.assignments.find(function target(a) { return a.id === action.assignmentId; });
        if (!item || item.state !== "planned" || !action.content?.trim()) throw new Error("ORCHESTRATION_EXACT_CONTROL_REQUIRED");
        if (finishCoversStep(run, item.stepId)) throw new Error("ORCHESTRATION_FINISHING");
        item.content = action.content; item.promptVersion = assignmentPrompts(run, item).at(-1)!.version; item.planVersion = run.planVersion;
      } else if (action.type === "step") {
        const step = action.step;
        if (finishCoversStep(run, step?.id, step?.verifies?.stepId)) throw new Error("ORCHESTRATION_FINISHING");
        if (!step || !/^[\w-]{1,128}$/.test(step.id) || !step.goal?.trim() || !Array.isArray(step.dependencies) || !Array.isArray(step.deliverables) || !Array.isArray(step.acceptance) || run.steps.some(function exists(item) { return item.id === step.id; }) || step.dependencies.some(function missing(id) { return !run.steps.some(function exists(item) { return item.id === id; }); })) throw new Error("ORCHESTRATION_INVALID_STEP");
        if (step.verifies !== undefined) {
          const source = run.steps.find(function target(s) { return s.id === step.verifies?.stepId; });
          if (!source || source.verifies || !step.dependencies.includes(source.id)
            || step.verifies?.browser !== undefined && typeof step.verifies.browser !== "boolean") throw new Error("ORCHESTRATION_INVALID_STEP");
          source.verdict = undefined;
          run.acceptance = "pending";
        }
        run.steps.push({ id: step.id, goal: step.goal, scope: step.scope, dependencies: [...step.dependencies], deliverables: [...step.deliverables], acceptance: [...step.acceptance], verifies: step.verifies, revision: 1, repairs: 0 });
      } else if (action.type === "assign") {
        const item = action.assignment;
        const step = run.steps.find(function target(step) { return step.id === item.stepId; });
        if (finishCoversStep(run, item.stepId)) throw new Error("ORCHESTRATION_FINISHING");
        if (!step || !/^[\w-]{1,128}$/.test(item.id) || !item.content?.trim() || !["initial", "repair", "reassign"].includes(item.purpose) || !["read", "write"].includes(item.access) || step.verifies && item.access !== "read" || run.assignments.some(function exists(a) { return a.id === item.id; })) throw new Error("ORCHESTRATION_INVALID_ASSIGNMENT");
        if (item.previousId !== step.currentAssignmentId || (item.previousId ? item.purpose === "initial" : item.purpose !== "initial")) throw new Error("ORCHESTRATION_ATTEMPT_MISMATCH");
        const promptVersion = assignmentPrompts(run, { id: item.id, stepId: step.id }).at(-1)?.version ?? 0;
        run.assignments.push({ id: item.id, stepId: step.id, content: item.content, purpose: item.purpose, previousId: item.previousId, access: item.access, revision: step.revision, planVersion: run.planVersion, promptVersion, checkout: run.checkout, createRequestId: orchestrationId(run.id, item.id, "create"), startRequestId: orchestrationId(run.id, item.id, "start"), local: { source: "unknown", phase: "unknown", obligations: [], handoff: false, skills: [], requiredSkills: [], cooperation: [] }, results: [], state: "planned", takeover: false });
        step.currentAssignmentId = item.id;
        step.verdict = undefined;
        run.acceptance = "pending";
      } else {
        const item = run.assignments.find(function target(item) { return item.id === action.assignmentId; });
        if (!item) throw new Error("ORCHESTRATION_ASSIGNMENT_MISSING");
        const step = run.steps.find(function target(step) { return step.id === item.stepId; })!;
        if (action.type === "report") {
          if (!item.execution || !sameExecution(item.execution, action.execution) || action.revision !== item.revision || (actor.kind === "executor" && actor.sessionId !== item.execution.sessionId)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
          const promptVersion = assignmentPrompts(run, item).at(-1)!.version;
          if ((action.promptVersion ?? item.promptVersion) !== promptVersion) throw new Error("ORCHESTRATION_PROMPT_STALE");
          item.promptVersion = promptVersion;
          if (action.local.source !== "agent" || typeof action.local.handoff !== "boolean" || !Array.isArray(action.local.obligations) || !Array.isArray(action.local.skills) || !Array.isArray(action.local.cooperation) || !Array.isArray(action.local.requiredSkills)) throw new Error("ORCHESTRATION_INVALID_REPORT");
          item.local = structuredClone(action.local);
          for (const skill of item.local.skills) {
            if (skill.repairLimit !== undefined) {
              if (!Number.isSafeInteger(skill.repairLimit) || skill.repairLimit < 0) throw new Error("ORCHESTRATION_INVALID_REPORT");
              if (step.currentAssignmentId === item.id) step.skillRepairLimit = Math.min(step.skillRepairLimit ?? Infinity, skill.repairLimit);
            }
          }
          if (action.result) {
            if (action.result.revision !== item.revision || !action.result.id || !Array.isArray(action.result.evidence) || action.result.evidence.some(function invalid(e) {
              return typeof e?.contentVersion !== "string" || !e.contentVersion.trim() || typeof e.artifact !== "string" || !e.artifact.trim()
                || typeof e.id !== "string" || !e.id.trim() || e.source !== (actor.kind === "human" ? "human" : "agent");
            }) || new Set(action.result.evidence.map(function id(e) { return e.id; })).size !== action.result.evidence.length) throw new Error("ORCHESTRATION_INVALID_EVIDENCE");
            if (!Array.isArray(action.result.unresolved) || action.result.verificationPending !== undefined && (action.result.verificationPending !== true || action.result.outcome !== "partial" || action.result.unresolved.length
              || !action.result.evidence.length || !item.local.handoff || item.local.obligations.length || item.local.cooperation.length
              || !run.steps.some(function reviewer(s) { return s.verifies?.stepId === step.id; }))) throw new Error("ORCHESTRATION_INVALID_REPORT");
            const result = { ...action.result, promptVersion, turnId: item.execution.turnId, browserObservations: action.browserObservations };
            const previous = item.results.find(function same(r) { return r.id === result.id; });
            if (previous && JSON.stringify(previous) !== JSON.stringify(result)) throw new Error("ORCHESTRATION_RESULT_CONFLICT");
            if (!previous) item.results.push(structuredClone(result));
          }
        } else {
          const result = item.results.find(function target(result) { return result.id === action.resultId; });
          if (item.promptVersion !== assignmentPrompts(run, item).at(-1)!.version || result?.promptVersion !== item.promptVersion) throw new Error("ORCHESTRATION_PROMPT_STALE");
          const explicit = run.steps.some(function reviewer(s) { return s.verifies?.stepId === step.id; });
          const evidence = action.evidenceIds.map(function selected(id) { return result?.evidence.find(function exact(e) { return e.id === id; }); });
          if (step.currentAssignmentId !== item.id || item.state !== "released" || !result || !item.local.handoff || item.local.obligations.length || !evidence.length || evidence.some(function absent(e) { return !e; })) throw new Error("ORCHESTRATION_HANDOFF_INCOMPLETE");
          const verification = run.assignments.find(function target(a) { return a.id === action.verificationAssignmentId; });
          if (explicit) {
            if (reviewSource(ledger, run, step.id)?.result !== result || !completedReview(ledger, run, step.id, verification, item, result, result.evidence)) throw new Error("ORCHESTRATION_INDEPENDENT_VERIFICATION_REQUIRED");
          } else if (result.outcome !== "delivered") throw new Error("ORCHESTRATION_HANDOFF_INCOMPLETE");
          else if (step.verifies) {
            const source = reviewSource(ledger, run, step.verifies.stepId);
            if (!source || releasedDelivery(ledger, run, item) !== result || !completedReview(ledger, run, step.verifies.stepId, item, source.item, source.result, source.result.evidence)) throw new Error("ORCHESTRATION_INDEPENDENT_VERIFICATION_REQUIRED");
          } else if (assignmentPrompts(run, item).some(function independent(p) { return p.independentVerification; })) {
            if (!verification?.execution || verification.state !== "released" || verification.execution.sessionId === item.execution?.sessionId || !verification.local.handoff || verification.local.obligations.length || !verification.results.some(function delivered(r) {
              return r.outcome === "delivered" && evidence.every(function sameVersion(e) { return r.evidence.some(function matching(v) { return v.contentVersion === e!.contentVersion; }); });
            })) throw new Error("ORCHESTRATION_INDEPENDENT_VERIFICATION_REQUIRED");
          }
          step.verdict = { assignmentId: item.id, resultId: result.id, evidenceIds: [...action.evidenceIds], accepted: true, verificationAssignmentId: explicit ? verification?.id : undefined };
        }
      }
      if (action.type !== "prompt" || !action.queue) run.revision++;
      run.records.push({ requestId: command.requestId, digest, action: action.type, at: new Date().toISOString(), ...(action.type === "prompt" ? { promptVersion: run.prompts.length } : {}) });
    });
    return this.snapshot(workspaceId, actor);
  }

  /** 会话角色每次按持久关系验证，不以依赖或模型声明授予权限。 */
  private authorize(run: OrchestrationRun, actor: OrchestrationActor): void {
    if (run.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    if (run.hostId !== this.channel.identity.hostId) throw new Error("ORCHESTRATION_SCOPE_DENIED");
    if (actor.kind === "human") return;
    if (actor.kind === "controller" && run.controller.execution?.sessionId === actor.sessionId && run.controller.execution.owner === this.channel.identity.owner && run.controller.execution.generation === this.channel.identity.generation) return;
    const identity = this.channel.identity;
    if (actor.kind === "executor" && run.assignments.some(function own(item) { return item.execution?.sessionId === actor.sessionId && item.execution.owner === identity.owner && item.execution.generation === identity.generation; })) return;
    throw new Error("ORCHESTRATION_SCOPE_DENIED");
  }

  /** 安全事件按精确委派过滤；旧 Turn 不归到新尝试，读取不触发重放执行。 */
  private async events(workspaceId: string, actor: OrchestrationActor, assignmentId: string) {
    const run = requireRun((await this.store.read()).runs, workspaceId); this.authorize(run, actor);
    const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
    if (!item?.execution || (actor.kind === "executor" && actor.sessionId !== item.execution.sessionId)) throw new Error("ORCHESTRATION_SCOPE_DENIED");
    const facts = this.facts?.status().ledger?.sessions[item.execution.sessionId];
    return { assignmentId, reconciliation: facts?.reconciliation ?? "pending", items: Object.values(facts?.facts ?? {}).filter(function target(fact) { return fact.turnId === item.execution!.turnId; }) };
  }

  /** 仅返回当前 Run 摘要，执行者仅获得自身委派；不读取 transcript 或其他 Run。 */
  private async snapshot(workspaceId: string, actor: OrchestrationActor) {
    const stored = requireRun((await this.store.read()).runs, workspaceId);
    // 本机审批反馈和存储技术诊断不进入模型查询。
    const run: OrchestrationRun = actor.kind === "human" ? stored : JSON.parse(JSON.stringify(stored, function humanOnly(key, value) { return key === "diagnostic" || key === "approvalContinuations" ? undefined : value; }));
    this.authorize(run, actor);
    const assignments = actor.kind !== "executor" ? run.assignments : run.assignments.filter(function own(item) { return item.execution?.sessionId === actor.sessionId; });
    const prompts = actor.kind === "human" ? run.prompts : visibleRunPrompts(run);
    const visibleVersions = new Set(prompts.map(function version(prompt) { return prompt.version; }));
    const pending = actor.kind === "executor" ? [] : run.pending?.filter(function visible(i) { return i.kind !== "prompt" || visibleVersions.has(i.promptVersion); });
    return structuredClone({ ...run, pending, assignments, handoffs: actor.kind !== "executor" ? run.handoffs : run.handoffs?.filter(function own(h) { return assignments.some(function related(a) { return a.id === h.assignmentId; }); }), steps: actor.kind !== "executor" ? run.steps : run.steps.filter(function own(step) { return assignments.some(function related(item) { return item.stepId === step.id; }); }), prompts: actor.kind !== "executor" ? prompts : prompts.filter(function relevant(prompt) { return prompt.scope === "run" || assignments.some(function target(item) { return prompt.targetId === (prompt.scope === "step" ? item.stepId : item.id); }); }), records: actor.kind === "executor" ? [] : run.records });
  }
}

