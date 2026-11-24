/** Run业务验收、Turn执行与操作回执分开描述；未知事实不推断进度。 */
import type { ApprovalContinuation, OrchestrationInspection, OrchestrationRunView } from "./orchestration-contract";

/** 将宿主确认的交互、待确认批次和其余编排意图合并为一致的待处理计数。 */
export function summarizeRunPending(runs: readonly OrchestrationRunView[]) {
  const interactions = new Map<string, "approval" | "question" | "unconfirmed">();
  const intents = new Set<string>();
  const batches = new Set<string>();
  for (const run of runs) {
    if (run.accepted) continue;
    const items = run.interactions ?? [];
    for (const item of items) {
      const kind = run.connected && item.state === "pending" ? item.kind : "unconfirmed";
      if (kind !== "unconfirmed" || !interactions.has(item.key)) interactions.set(item.key, kind);
    }
    for (const target of [undefined, ...run.assignments.map(function id(a) { return a.id; })]) {
      const item = pausedApproval(run, target);
      if (item?.resume?.state === "unconfirmed" || item?.resume?.state === "rejected") interactions.set(item.id, "unconfirmed");
    }
    const waitingController = items.some(function controller(item) { return !item.assignmentId; });
    for (const intent of run.pending ?? []) {
      if (waitingController && !intent.assignmentId && intent.reason === "controller_waiting") continue;
      intents.add(JSON.stringify([run.id, intent.id]));
    }
    for (const finish of run.finishes ?? []) if (!finish.completed) intents.add(JSON.stringify([run.id, "finish", finish.requestId]));
    if (run.connected && !run.needsRecovery) for (const batch of run.batches ?? []) {
      if (batch.state === "pending") batches.add(JSON.stringify([run.id, batch.digest]));
    }
  }
  const counts = { approval: 0, question: 0, unconfirmed: 0 };
  for (const kind of interactions.values()) counts[kind]++;
  return { approvals: counts.approval, questions: counts.question, unconfirmed: counts.unconfirmed, intents: intents.size, batches: batches.size, total: interactions.size + intents.size + batches.size };
}

/** 左栏只展示所属工作区当前 Run，与总台共用状态文案。 */
export function workspaceRunStatus(run?: OrchestrationRunView): string {
  return run?.current ? runStatus(run) : "AP 主控 · 等待输入目标";
}

/** 将宿主固定审批回执错误翻译为操作结果和可用恢复入口。 */
export function orchestrationError(message: string): string {
  if (message.includes("ORCHESTRATION_LAST_ACTIVE_TERMINAL")) return "这是此 Run 剩余的终端视图。请保持打开，先处理审批、回答或等待执行结束。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_REPORT_WAITING")) return "执行者暂时无法保存关闭进度。请处理原终端的等待事项，待执行者可回应后重试。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_REPORT_UNCONFIRMED")) return "关闭进度请求尚未确认。请查看原终端后重试。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_REPORT_PENDING")) return "尚未收到执行者保存的进度。原终端保持打开，可稍后重试。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_RECORD_FAILED")) return "终端接续记录保存失败。终端保持打开，请重试。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_UNKNOWN")) return "暂时无法核查原终端状态。请检查宿主连接和原会话。";
  if (message.includes("ORCHESTRATION_VIEW_CLOSE_STALE")) return "原终端连接或 Turn 已变化。请核对当前终端后重新关闭。";
  if (message.includes("ORCHESTRATION_FINISHING")) return "此范围已收尾或正在收尾。可查看原回执，或开始新任务。";
  if (message.includes("ORCHESTRATION_APPROVAL_NOT_CONFIRMED")) return "审批决定尚未确认。请核查原回执和审批状态。";
  if (message.includes("ORCHESTRATION_APPROVAL_SAVED_RESUME_PENDING")) return "审批决定已保存，原 Turn 是否继续仍待核查。请查看原回执和恢复详情。";
  if (message.includes("ORCHESTRATION_APPROVAL_CHANGED")) return "审批已变化，请核查原 Turn 后再处理。";
  if (message.includes("ORCHESTRATION_ANSWER_NOT_CONFIRMED")) return "回答尚未确认保存。请核查原回执和问题状态。";
  if (message.includes("ORCHESTRATION_ANSWER_SAVED_RESUME_PENDING")) return "回答已保存，原 Turn 是否继续仍待核查。请查看原回执和恢复详情。";
  if (message.includes("ORCHESTRATION_QUESTION_CHANGED")) return "问题已变化，请核查原 Turn 后再处理。";
  if (message.includes("ORCHESTRATION_BATCH_STALE") || message.includes("ORCHESTRATION_STALE_REVISION")) return "任务状态已更新，请核对最新内容后重新确认。";
  return message;
}

/** 所有导航和进度标签共用同一个事实口径。 */
export function runStatus(run: OrchestrationRunView): string {
  const finish = run.finishes?.find(function whole(f) { return !f.stepId; });
  if (finish?.stop) return finish.completed ? "整次编排已停止" : "已停止新派工，正在核查停止结果";
  if (finish?.completed) return "收尾回执已保存";
  if (run.accepted) return "已验收";
  if (!run.connected) return "状态待核查";
  const { approvals, questions, batches, unconfirmed } = summarizeRunPending([run]);
  if (approvals || questions || batches) return [approvals ? `${approvals} 项待审批` : "", questions ? `${questions} 项待回答` : "", batches ? "扩员待确认" : ""].filter(Boolean).join(" · ");
  const recovery = [pausedApproval(run), ...run.assignments.map(function own(a) { return pausedApproval(run, a.id); })].find(function current(item) { return !!item; });
  if (recovery) return approvalContinuationStatus(recovery);
  if (finish) return "收尾中";
  if (run.needsRecovery) return run.controllerStatus === "interrupted" ? "已中断，待选择" : "待处理旧任务";
  if (run.controllerExecution === "active" || run.assignments.some(function active(a) { return a.native === "running"; })) return "执行中";
  if (unconfirmed || !run.controllerExecution || ["unconfirmed", "lost"].includes(run.controllerExecution)) return "状态待核查";
  if (run.waitingForGoal) return "等待目标";
  if (run.controllerStatus === "interrupted") return "已中断，待选择";
  if (run.controllerStatus === "failed") return "执行失败，待处理";
  if (run.controllerStatus === "limit_reached") return "达到限制，待处理";
  if (run.controllerJobs === "active") return "后台 Job 仍活动";
  if (run.paused) return "派工暂停";
  return "等待处理 / 验收";
}

/** Turn仅按当前权威执行状态展示，与Run是否验收无关。 */
export function turnStatus(status: string, execution?: string): string {
  if (!execution || ["unconfirmed", "lost"].includes(execution)) return "状态待核查";
  return ({ running: "执行中", idle: "尚未开始", completed: "本轮已结束", interrupted: "已中断", failed: "执行失败", limit_reached: "达到限制", waiting_approval: "等待审批", waiting_user_input: "等待回答" } as Record<string, string>)[status] ?? "状态待核查";
}

/** 详情沿用标题所见的精确审批状态，其余回合使用原生状态。 */
export function displayTurnStatus(run: OrchestrationRunView, assignmentId?: string) {
  const item = pausedApproval(run, assignmentId);
  if (item) return approvalContinuationStatus(item);
  const a = run.assignments.find(function own(a) { return a.id === assignmentId; });
  const status = a?.native ?? run.controllerStatus;
  const inspection = a ? a.inspection : run.controllerInspection;
  if (status === "waiting_approval" && inspection?.interaction?.state !== "pending") return "状态待核查";
  return turnStatus(status, run.connected ? (a ? inspection?.execution : run.controllerExecution) : undefined);
}

/** 回执描述本次具体操作，不把confirmed扩大为全部任务或Job已停止。 */
export function receiptStatus(receipt: NonNullable<OrchestrationRunView["controllerReceipt"]>): string {
  const operation = ({ cancel: "停止 Turn", stop_job: "停止 Job", resume: "继续 Turn", approval: "保存审批决定", answer: "保存回答" } as Record<string, string>)[receipt.operation ?? ""] ?? "历史操作";
  if (receipt.code === "MANAGED_NO_ACTIVE_TURN") return `${operation}：当时没有可停止的 Turn`;
  if (receipt.code === "JOB_STOP_FAILED") return "后台任务的进程树停止尚未确认。";
  if (receipt.code || receipt.state === "rejected") return `${operation}：未成功，请核查详情`;
  if (receipt.state === "confirmed") return `${operation}：${receipt.operation === "cancel" ? "该 Turn 已结束（Job 单独核查）" : receipt.operation === "stop_job" ? "该 Job 已结束" : "操作已确认"}`;
  return `${operation}：${receipt.state === "started" ? "执行已开始" : "结果待确认，自动核查中"}`;
}

/** 默认文案区分原输入被中断、新输入待选择和真正失败。 */
export function pendingMessage(reason: string): string {
  if (reason === "input_too_large") return "主控输入超出请求长度限制，尚未执行。请从输入历史取回，缩短后重新提交。";
  if (reason.includes("CHECKOUT_BUSY")) return "目录仍被其他执行占用；请查看执行者状态，收尾或停止后继续。";
  if (reason === "ORCHESTRATION_RELEASE_HANDOFF_REQUIRED") return "执行者已停止但尚未交接。请续做原委派，或依据当前阻塞报告提交改派。";
  if (reason === "ORCHESTRATION_RELEASE_UNCONFIRMED") return "目录释放待核查。请检查原执行者 Turn、后台 Job 和操作回执。";
  if (reason === "ORCHESTRATION_REPAIR_RESULT_STALE") return "改派依据已变化。请核对当前委派及最新报告。";
  if (reason === "ORCHESTRATION_REPAIR_LIMIT") return "此步骤已达到修复或改派上限。";
  if (reason.includes("EMPTY_BATCH")) return "没有可派发的任务；可直接交流，或补充需要执行的具体目标。";
  if (reason === "controller_waiting") return "主控等待审批或回答，请定位交互处理。";
  if (reason === "controller_interrupted") return "该输入所在回合已中断；未完成事项保留，等待你的选择。";
  if (reason === "input_waiting_recovery") return "输入已保存在原任务，尚未交付主控。";
  if (reason === "controller_limited") return "该回合达到执行限制，未完成事项需处理。";
  if (reason === "controller_failed") return "该回合执行失败，未完成输入仍保留。";
  if (["controller_offline", "wake_unconfirmed", "input_unconsumed", "decision_missing"].includes(reason)) return "本次输入的处理状态尚未确认，请核查原回执。";
  if (reason === "prompt") return "新输入已保存，处理进度待确认。";
  if (reason === "result") return "执行结果等待主控核查。";
  return "任务需要核查，请查看主控和执行者状态。";
}

/** 只匹配当前会话、回合与审批；新交互不会继承旧决定。 */
export function currentApproval(items: ApprovalContinuation[] | undefined, sessionId?: string, inspection?: OrchestrationInspection) {
  if (!sessionId || !inspection?.turnId || inspection.interaction?.question) return;
  const approvalId = inspection.interaction?.approval?.approvalId;
  if (inspection.status === "waiting_approval" && !approvalId) return;
  return items?.filter(function own(item) {
    return item.sessionId === sessionId && item.turnId === inspection.turnId && (!approvalId || item.approvalId === approvalId);
  }).at(-1);
}

/** 仅在审批暂停仍为当前观察状态时以决定与续接回执覆盖底层暂停标签。 */
export function pausedApproval(run: OrchestrationRunView, assignmentId?: string) {
  const a = run.assignments.find(function own(a) { return a.id === assignmentId; });
  const inspection = assignmentId ? a?.inspection : run.controllerInspection;
  if (!run.connected || inspection?.status !== "waiting_approval") return;
  return currentApproval(run.approvalContinuations, assignmentId ? a?.sessionId : run.controllerId, inspection);
}

/** 保存与恢复分别反馈；安全错误码和执行阶段保留在原回执上。 */
export function approvalContinuationStatus(item: import("./orchestration-contract").ApprovalContinuation): string {
  const saved = item.approval.state === "confirmed" && !item.approval.code;
  const decision = item.decision === "deny" ? "已拒绝" : item.decision ? "已批准" : "审批决定已保存";
  if (!saved) return item.reconciliation?.stopped ? "审批决定仍未确认，自动核查已停止。由主控协调后续处理。" : "宿主正在核查原审批决定。";
  if (item.resume && !item.resume.code && ["started", "confirmed"].includes(item.resume.state)) return `${decision}，原任务已恢复。`;
  if (item.reconciliation?.stopped) {
    const reason = item.resume?.diagnostic?.phase === "rename" && item.resume.diagnostic.osCode === "EPERM" ? "会话文件替换被 Windows 拒绝" : item.reconciliation.stopped;
    return `${decision}，自动恢复已停止 · ${reason}。由主控协调后续处理。`;
  }
  if (item.reconciliation?.retried) return `${decision}，宿主自动重试 1/1，等待原请求回执。`;
  if (item.resume?.state === "submitted" || item.resume && item.resume.phase !== "check_resume") return `${decision}，恢复已发出，宿主正在核查回执。`;
  return item.reconciliation ? `${decision}，宿主正在核查原任务。` : `${decision}，决定已保存。`;
}
