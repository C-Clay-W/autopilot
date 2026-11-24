/** 人类审批与原任务续接的持久反馈；只供本机界面，不承担 Core 决定或执行。 */
import { managedApprovalDecisions, type ApprovalContinuation, type OrchestrationInspection } from "./orchestration-contract";
import type { OrchestrationRun } from "./orchestration-store";
import { orchestrationId } from "./orchestration-service";

/** 旧记录只在 Core 已确认原决定且精确暂停身份仍可核对时提供恢复入口。 */
export function legacyApprovalContinuation(run: OrchestrationRun, inspection?: OrchestrationInspection, assignmentId?: string): ApprovalContinuation | undefined {
  const approval = inspection?.interaction?.approval;
  if (inspection?.interaction?.state !== "decided" || !inspection.turnId || !approval) return;
  const assignment = run.assignments.find(function same(a) { return a.id === assignmentId; });
  const ref = assignmentId ? assignment?.execution : run.controller.execution;
  if (!ref || assignmentId && ref.turnId !== inspection.turnId) return;
  const id = orchestrationId(run.id, ref.sessionId, inspection.turnId, approval.approvalId);
  const prior = run.approvalContinuations?.find(function same(item) { return item.id === id; });
  if (prior) return prior;
  const controls = assignment?.controls ?? [];
  const saved = [...controls].reverse().find(function saved(control) { return control.operation === "approval" && control.receipt.state === "confirmed" && !control.receipt.code && control.receipt.sessionId === ref.sessionId && control.receipt.turnId === inspection.turnId
    && managedApprovalDecisions.some(function decision(decision) { return control.digest === orchestrationId(JSON.stringify({ operation: "approval", requestId: control.requestId, approvalId: approval.approvalId, decision }), JSON.stringify({ kind: "human" })); }); });
  const receipt = assignmentId ? controls.slice(saved ? controls.indexOf(saved) + 1 : 0).reverse().find(function resume(control) { return control.operation === "resume" && control.receipt.sessionId === ref.sessionId && control.receipt.turnId === inspection.turnId
    && control.digest === orchestrationId(JSON.stringify({ operation: "resume", requestId: control.requestId, approvalId: approval.approvalId }), JSON.stringify({ kind: "human" })); })?.receipt : run.controller.receipt;
  const requestId = saved?.requestId ?? orchestrationId(id, "recovered-decision");
  const decision = approval.decision ?? (saved && managedApprovalDecisions.find(function decision(decision) { return saved.digest === orchestrationId(JSON.stringify({ operation: "approval", requestId, approvalId: approval.approvalId, decision }), JSON.stringify({ kind: "human" })); }));
  return { id, assignmentId, sessionId: ref.sessionId, turnId: inspection.turnId, approvalId: approval.approvalId, decision, requestId, pauseSeq: inspection.lastSeq,
    approval: saved?.receipt ?? { requestId, operation: "approval", sessionId: ref.sessionId, turnId: inspection.turnId, state: "confirmed" },
    resume: receipt?.operation === "resume" && receipt.sessionId === ref.sessionId && receipt.turnId === inspection.turnId && (assignmentId || receipt.requestId === orchestrationId(requestId, "resume-after-approval")) ? receipt : undefined };
}
