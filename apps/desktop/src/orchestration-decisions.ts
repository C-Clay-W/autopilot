/** 主控语义决定先持久化，随后逐项进入 S5；无独立派工或审批旁路。 */
import { OrchestrationService, linkBatchDispatch, requireRun, orchestrationId, releasedContinuationKey, type RelationAction } from "./orchestration-service";
import { validateControllerDecision, isCorrectableDecision, repairReleaseResultId } from "./orchestration-validation";
import { intentBasis } from "./orchestration-intents";
import type { ExecutionReference, OrchestrationIntent, OrchestrationRun } from "./orchestration-store";

import { canCoordinateApproval } from "./orchestration-contract";
import { registerFinish } from "./orchestration-finish";

export type DecisionAction =
  | { kind: "stopRun" }
  | { kind: "recoverApproval"; id: string }
  | { kind: "relation"; action: Exclude<RelationAction, { type: "prompt" | "batchDecision" | "report" }> }
  | { kind: "dispatch" | "release" | "query"; assignmentId: string }
  | { kind: "continue"; assignmentId: string; content: string }
  | { kind: "control"; assignmentId: string; execution: ExecutionReference; operation: "steer" | "queue" | "resume" | "cancel" | "stop_job"; content?: string; jobId?: string };
export interface ControllerDecision { intentId: string; basis: string; expectedRevision: number; reason: string; actions: DecisionAction[] }

/** 独立决定也可等待已有清单；在发布派工游标的同一事务冻结提审身份。 */
function rememberDispatchGate(run: OrchestrationRun, decision: NonNullable<OrchestrationIntent["decision"]>) {
  const action = decision.actions[decision.next];
  if (action?.kind !== "dispatch") return;
  const batch = run.batches?.find(function pending(b) { return b.planVersion === run.planVersion && b.state === "pending" && b.assignmentIds.includes(action.assignmentId); });
  if (batch) decision.waitingBatch = { planVersion: batch.planVersion, digest: batch.digest, next: decision.next };
}

/** 固定主控且当前版本才可保存；同意图只接受同一个决定，修订保留旧记录。 */
export async function saveControllerDecision(service: OrchestrationService, workspaceId: string, sessionId: string, input: ControllerDecision, turnId?: string): Promise<void> {
  validateControllerDecision(input);
  const digest = orchestrationId(JSON.stringify(input));
  await service.store.update(function save(ledger) {
    const run = requireRun(ledger.runs, workspaceId);
    if (run.controller.execution?.sessionId !== sessionId) throw new Error("ORCHESTRATION_SCOPE_DENIED");
    const intent = run.pending?.find(function target(i) { return i.id === input.intentId; });
    if (intent?.decision) {
      const previous = intent.decision;
      if (previous.digest === digest) return;
      if (!isCorrectableDecision(run, intent)) throw new Error("ORCHESTRATION_DECISION_CONFLICT");
    }
    if (!intent || intent.state !== "pending" || intent.basis !== input.basis || input.basis !== intentBasis(run, intent.assignmentId) || run.revision !== input.expectedRevision
      || intent.continuation && (run.paused || run.controlOnly || intent.continuation.key !== releasedContinuationKey(ledger, run, run.assignments.find(function source(a) { return a.id === intent.assignmentId; })))) throw new Error("ORCHESTRATION_DECISION_STALE");
    if (intent.decision) (intent.decisionHistory ??= []).push({ ...structuredClone(intent.decision), supersededAt: new Date().toISOString() });
    intent.decision = { version: (intent.decision?.version ?? (intent.decision ? 1 : 0)) + 1, digest, reason: input.reason, actions: structuredClone(input.actions), next: 0, expectedRevision: run.revision, state: input.actions.length ? "saved" : "done" };
    rememberDispatchGate(run, intent.decision);
    if (input.actions.some(function stop(a) { return a.kind === "stopRun"; })) {
      if (input.actions.length !== 1 || intent.kind !== "prompt" || intent.source !== "human") throw new Error("ORCHESTRATION_INVALID_COMMAND");
      registerFinish(run, { stop: true, source: { ...run.controller.execution, turnId: turnId ?? run.controller.execution.turnId }, requestId: orchestrationId(intent.id, "stop"), text: input.reason });
      intent.decision.next = 1; intent.decision.state = "done"; intent.state = "decided";
    }
    intent.correction = undefined;
    if (!input.actions.length) intent.state = "decided";
  });
}

/** 每个动作有原请求身份；重开仅接续已保存决定，旧执行/未知提交永不另建尝试。 */
export async function applyControllerDecision(service: OrchestrationService, workspaceId: string, intentId: string, recoverApproval?: (id: string) => Promise<void>): Promise<void> {
  for (;;) {
    const ledger = await service.store.read();
    const run = requireRun(ledger.runs, workspaceId);
    const intent = run.pending?.find(function target(i) { return i.id === intentId; });
    const decision = intent?.decision;
    if (!intent || !decision || decision.state !== "saved") return;
    if (intent.continuation && (run.paused || run.controlOnly)) return;
    if (intent.basis !== intentBasis(run, intent.assignmentId) || intent.state === "stale" || intent.continuation
      && (intent.continuation.planVersion !== run.planVersion || decision.next === 0
        && intent.continuation.key !== releasedContinuationKey(ledger, run, run.assignments.find(function source(a) { return a.id === intent.assignmentId; })))) {
      await service.store.update(function stale(ledger) { const i = requireRun(ledger.runs, workspaceId).pending!.find(function target(i) { return i.id === intentId; })!; i.state = "stale"; i.decision!.state = "stale"; }); return;
    }
    const api = service.bind(workspaceId, { kind: "controller", sessionId: run.controller.execution!.sessionId });
    const action = decision.actions[decision.next];
    if (action?.kind === "dispatch" && (run.paused || run.controlOnly)) return;
    const requestId = orchestrationId(intent.id, String(decision.next));
    try {
      let updated = run;
      if (action?.kind === "recoverApproval") {
        const target = run.approvalContinuations?.find(function same(i) { return i.id === action.id; });
        if (!recoverApproval || !target || !canCoordinateApproval(target)) throw new Error("ORCHESTRATION_APPROVAL_CHANGED");
        await recoverApproval(action.id);
        const saved = requireRun((await service.store.read()).runs, workspaceId).approvalContinuations?.find(function same(i) { return i.id === action.id; });
        if (!saved?.resume || saved.resume.code || !["started", "confirmed"].includes(saved.resume.state)) throw new Error("ORCHESTRATION_RECOVERY_UNCONFIRMED");
      }
      else if (action?.kind === "relation") updated = await api.command({ requestId, expectedRevision: decision.expectedRevision, action: action.action });
      else if (action?.kind === "dispatch") {
        updated = await api.dispatch(action.assignmentId, decision.expectedRevision);
        const submitted = updated.assignments.find(function target(a) { return a.id === action.assignmentId; });
        if (submitted?.submission !== "start" || submitted.receipt?.requestId !== submitted.startRequestId || submitted.receipt?.code || submitted.receipt?.sessionId !== submitted.execution?.sessionId || submitted.receipt?.turnId !== submitted.execution?.turnId || !["started", "confirmed"].includes(submitted.receipt?.state ?? "")) throw new Error("ORCHESTRATION_SUBMISSION_UNKNOWN");
      } else if (action?.kind === "release") {
        updated = run.assignments.find(function target(a) { return a.id === action.assignmentId; })?.state === "released" ? run : await api.release(decision.expectedRevision, action.assignmentId, repairReleaseResultId(intent));
      }
      else if (action?.kind === "query") updated = await api.query(action.assignmentId);
      else if (action?.kind === "continue") {
        const previous = run.assignments.find(function target(a) { return a.id === action.assignmentId; })?.controls?.find(function target(c) { return c.requestId === requestId; });
        updated = previous ? await api.query(action.assignmentId, requestId) : await api.continue(action.assignmentId, decision.expectedRevision, requestId, action.content);
        const receipt = updated.assignments.find(function target(a) { return a.id === action.assignmentId; })?.controls?.find(function target(c) { return c.requestId === requestId; })?.receipt;
        if (!receipt || receipt.state === "unconfirmed") throw new Error("ORCHESTRATION_SUBMISSION_UNKNOWN");
        if (receipt.code) throw new Error(receipt.code);
      }
      else if (action?.kind === "control") {
        const previous = run.assignments.find(function target(a) { return a.id === action.assignmentId; })?.controls?.find(function target(c) { return c.requestId === requestId; });
        updated = previous ? await api.query(action.assignmentId, requestId) : await api.control({ assignmentId: action.assignmentId, expectedRevision: decision.expectedRevision, execution: action.execution, command: { requestId, operation: action.operation, content: action.content, jobId: action.jobId } });
        const receipt = updated.assignments.find(function target(a) { return a.id === action.assignmentId; })?.controls?.find(function target(c) { return c.requestId === requestId; })?.receipt;
        if (receipt?.state === "unconfirmed") throw new Error("ORCHESTRATION_CONTROL_UNKNOWN");
        if (receipt?.code) throw new Error(receipt.code);
      }
      await service.store.update(function progress(ledger) {
        const current = requireRun(ledger.runs, workspaceId);
        const i = current.pending!.find(function target(i) { return i.id === intentId; })!;
        if (i.decision?.digest !== decision.digest || i.decision.next !== decision.next || i.decision.state !== "saved") return;
        i.decision.next++; i.decision!.expectedRevision = updated.revision; i.decision!.error = undefined;
        rememberDispatchGate(current, i.decision);
        if (i.decision!.next >= i.decision!.actions.length) { i.decision!.state = "done"; i.state = "decided"; }
        else if (action?.kind === "relation" && action.action.type === "seal") {
          const batch = current.batches?.at(-1);
          if (batch?.decidedByHuman) linkBatchDispatch(current, batch, current.revision);
        }
      });
    } catch (error) {
      await service.store.update(function failed(ledger) {
        const i = requireRun(ledger.runs, workspaceId).pending!.find(function target(i) { return i.id === intentId; })!;
        if (i.decision?.digest !== decision.digest || i.decision.next !== decision.next || i.decision.expectedRevision !== decision.expectedRevision || i.decision.state !== "saved") return;
        i.decision.error = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "ORCHESTRATION_STORAGE_UNCONFIRMED";
        if (action?.kind === "dispatch" && i.decision.error === "ORCHESTRATION_BATCH_NOT_APPROVED") {
          const run = requireRun(ledger.runs, workspaceId);
          rememberDispatchGate(run, i.decision);
        }
        if (action?.kind === "dispatch" && i.decision.error === "ORCHESTRATION_AUTOMATION_PAUSED") return;
        // 活动尚未结束与未知副作用继续核查原身份；确定性准入失败交回主控，避免无限重试。
        if (action?.kind === "recoverApproval" || !["ORCHESTRATION_CHECKOUT_BUSY", "ORCHESTRATION_RELEASE_UNCONFIRMED", "ORCHESTRATION_CONTINUE_PENDING", "ORCHESTRATION_SUBMISSION_UNKNOWN", "ORCHESTRATION_CONTROL_UNKNOWN", "ORCHESTRATION_STORAGE_UNCONFIRMED"].includes(i.decision!.error)) i.decision!.state = "blocked";
      });
      return;
    }
  }
}
