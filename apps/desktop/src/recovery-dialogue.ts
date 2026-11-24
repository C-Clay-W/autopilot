/** 保存旧版恢复问答的账本形状，供历史查看、执行核查与工作区删除使用。 */
import type { ManagedRuntimeReceipt } from "./managed-runtime-service";
import type { OrchestrationRun, OrchestrationPromptAttachments, ExecutionReference } from "./orchestration-store";
import type { OrchestrationInspection } from "./orchestration-contract";

export type RecoveryChoice = "continue" | "new" | "details";
export interface RecoveryDialogueState {
  id: string; version: number; message: string; resolved?: boolean; changedToken?: string;
  pending: (OrchestrationPromptAttachments & { requestId: string; content: string; delivered?: boolean })[];
  execution?: ExecutionReference;
  previousExecutions?: ExecutionReference[];
  lastAnswer?: { requestId: string; content: string };
  interpretation?: { requestId: string; turnId: string; answer: string; revision: number; version: number; choice?: RecoveryChoice; receipt?: ManagedRuntimeReceipt };
  choice?: { requestId: string; kind: RecoveryChoice; targetRunId?: string };
}
/** 执行结束与验收分开；仅明确无可恢复执行/交互/Job 才可自动接收后续输入。 */
export function executionSettled(inspection: OrchestrationInspection): boolean {
  return inspection.execution === "inactive" && !inspection.activeJobs && !inspection.recoverable && !["waiting_approval", "waiting_user_input", "interrupted"].includes(inspection.status) && !["pending", "unconfirmed"].includes(inspection.interaction?.state ?? "");
}

/** 只检查真实业务待办；没有 Step 的已处理聊天不需要伪造验收。 */
export function hasRecoveryWork(run: OrchestrationRun, leased: boolean): boolean {
  return leased || !!run.recoveryDialogue?.pending.some(function waiting(p) { return !p.delivered; }) || run.assignments.some(function unfinished(a) { return !["released", "cancelled"].includes(a.state); }) || run.steps.some(function unaccepted(s) { return !s.verdict?.accepted; }) || (run.acceptance !== "accepted" && (run.pending ?? []).some(function pending(i) { return i.state === "pending"; }));
}

/** 默认只显示任务与业务阻塞，不将 owner/checkpoint 等内部诊断当作用户操作说明。 */
export function recoverySummary(run: OrchestrationRun): string {
  const waiting = run.assignments.filter(function pending(a) { return !["released", "cancelled"].includes(a.state); }).length;
  return `上次任务：${run.goal || "对话"}。${waiting ? `还有 ${waiting} 个委派尚未收尾。` : run.steps.some(function pending(s) { return !s.verdict?.accepted; }) ? "执行结果尚待确认。" : "上次输入或执行的收尾状态仍需确认。"}可继续在当前会话输入。需要恢复旧执行时输入 /recover 核查。`;
}
