/** H3 从持久关系补齐语义处理意图；重开可重算，纯执行进展不产生模型工作。 */
import { isCorrectableDecision, repairReleaseResultId } from "./orchestration-validation";
import { orchestrationId, releasedContinuationKey } from "./orchestration-service";
import { assignmentPrompts, visibleRunPrompts } from "./orchestration-admission";
import type { OrchestrationRun, OrchestrationIntent, OrchestrationLedger } from "./orchestration-store";
import type { ManagedFactsLedger } from "./managed-facts-host";

/** 新会话轮可独立接收输入与原生交互，旧编排执行仍受恢复门禁约束。 */
export function isTerminalInputTurn(run: OrchestrationRun, turnId?: string): boolean {
  return !!turnId && run.pending?.some(function exact(i) {
    return i.kind === "prompt" && !!run.prompts[i.promptVersion - 1]?.terminalInput && i.wake?.operation === "start"
      && i.wake.turnId === turnId && !!i.wake.generation && i.wake.generation === run.controller.execution?.generation;
  }) === true;
}

/** 版本指纹包含结果与局部义务；旧结果修改或用户变更不能沿用旧决定。 */
export function intentBasis(run: OrchestrationRun, assignmentId?: string): string {
  const assignment = run.assignments.find(function target(a) { return a.id === assignmentId; });
  return orchestrationId(JSON.stringify({ policy: run.policy, prompts: assignment ? assignmentPrompts(run, assignment) : visibleRunPrompts(run), assignment: assignment && { id: assignment.id, revision: assignment.revision, results: assignment.results, local: assignment.local }, step: assignment && run.steps.find(function target(s) { return s.id === assignment.stepId; })?.revision }));
}

/** 必须在关系存储事务内调用；崩溃后从原结果补齐同一个意图。 */
export function collectOrchestrationIntents(run: OrchestrationRun, facts?: ManagedFactsLedger, ledger?: OrchestrationLedger): void {
  const pending = run.pending ??= [];
  /** 原语义身份唯一；创建不会执行模型或修改任务验收。 */
  function add(kind: OrchestrationIntent["kind"], source: OrchestrationIntent["source"], key: string, assignmentId?: string, resultId?: string, detail?: string, promptVersion = visibleRunPrompts(run).at(-1)?.version ?? 0, stable = false) {
    const basis = intentBasis(run, assignmentId);
    const id = orchestrationId(run.id, kind, key, stable ? "" : basis);
    if (!pending.some(function exists(i) { return i.id === id; })) pending.push({ id, kind, source, assignmentId, resultId, basis, promptVersion, policyVersion: run.policy.settingsVersion, state: "pending", at: new Date().toISOString(), detail });
  }
  // 终端可并发换代，逐条补齐已保存的人类输入，避免两条原文只生成末条意图。
  const collected = new Set(pending.filter(function prompt(i) { return i.kind === "prompt"; }).map(function version(i) { return i.promptVersion; }));
  for (const prompt of run.prompts) if ((prompt.queue || run.acceptance !== "accepted" && (prompt.terminalInput || prompt.version === run.prompts.length)) && !collected.has(prompt.version)) {
    add("prompt", "human", String(prompt.version), undefined, undefined, undefined, prompt.version);
  }
  // 正在收尾的业务已验收时仍保留人类明确排到下一轮的输入。
  if (run.acceptance === "accepted") {
    for (const item of pending) if (item.state === "pending" && !(item.kind === "prompt" && !item.wake && run.prompts[item.promptVersion - 1]?.queue)) item.state = "stale";
    return;
  }
  // 只给已证明零副作用的历史结构错误一次新唤醒；保留原投递审计，刷新不会反复投递。
  for (const item of pending) if (item.state === "pending" && isCorrectableDecision(run, item) && !item.correction) {
    item.correction = { revision: run.revision, originalWake: item.wake };
    item.wake = undefined;
  }
  for (const item of pending) if (item.state === "pending" && item.basis !== intentBasis(run, item.assignmentId)) {
    if ((item.kind === "prompt" || item.kind === "host" && item.detail?.startsWith("executor_input_")) && !item.decision) item.basis = intentBasis(run, item.assignmentId);
    else item.state = "stale";
  }
  for (const batch of run.batches ?? []) if (batch.decidedByHuman && !batch.dispatch && batch.planVersion === run.planVersion) add("host", "human", `batch:${batch.planVersion}:${batch.digest}:${batch.state}`, undefined, undefined, `batch_${batch.state}: 用户已处理完整扩员清单，请基于当前计划继续或调整；不改变任务目标与修复预算`);
  for (const assignment of run.assignments) {
    for (const input of assignment.directInputs ?? []) {
      for (const kind of ["impact", "result"] as const) {
        const detail = input[kind];
        if (!detail) continue;
        const prefix = `executor_input_${kind}: ${input.requestId} · `;
        // 历史意图已有明确来源和原文版本，重开只补缺失的会话，不再发已落盘通知。
        if (pending.some(function existing(i) { return i.kind === "host" && i.source === "agent" &&
          i.assignmentId === assignment.id && i.promptVersion === input.promptVersion && i.detail?.startsWith(prefix); })) continue;
        add("host", "agent", JSON.stringify([assignment.id, input.source, input.requestId, kind]), assignment.id, undefined, prefix + detail, input.promptVersion, true);
      }
    }
    const result = assignment.results.at(-1);
    if (result) add("result", "agent", assignment.id + ":" + result.id, assignment.id, result.id);
    const ref = assignment.execution;
    const session = ref && facts?.sessions[ref.sessionId];
    const execution = session?.snapshot?.execution;
    if (ref && assignment.state !== "released" && assignment.state !== "cancelled") {
      if (facts?.connection.state === "disconnected") add("host", "host", ref.sessionId + ":" + ref.turnId + ":disconnected", assignment.id, undefined, "connection_lost: Host 失联观察，未确认失败或停止，保留占用");
      else if (execution && execution.turnId === ref.turnId && !execution.waiting && execution.execution === "inactive" && !(result && (result.turnId === ref.turnId || (!result.turnId && !assignment.previousExecutions?.length)))) add("host", "host", ref.turnId + ":unreported:" + execution.result, assignment.id, undefined, "unreported_terminal: Core Turn 已结束但无委派报告，局部义务及业务结果未知");
    }
  }
  // 准入失败保留原决定供用户核查，不再次投递原输入；兼容旧版派生错误意图。
  for (const intent of pending) if (intent.state === "pending" && intent.kind === "host" && intent.source === "host" && pending.some(function blocked(original) { return original.decision?.state === "blocked" && original.decision.error === intent.detail; })) intent.state = "stale";
  if (!ledger) return;
  // 接续只在原条件仍成立时有效；本决定已执行的动作由游标和 CAS 保护，不因自己的验收改变阶段而失效。
  for (const intent of pending) if (intent.state === "pending" && intent.continuation
    && (intent.continuation.planVersion !== run.planVersion || !(intent.decision?.state === "saved" && intent.decision.next > 0)
      && intent.continuation.key !== releasedContinuationKey(ledger, run, run.assignments.find(function source(a) { return a.id === intent.assignmentId; })))) intent.state = "stale";
  // 现有语义工作或动作还在推进时不另投递；整批 release/accept/dispatch 完成后才重算剩余事项。
  if (run.paused || run.controlOnly || pending.some(function progressing(i) { return i.state === "pending" && !i.continuation; })
    || pending.some(function executing(i) { return i.state === "pending" && !!i.decision; })) return;
  for (const assignment of run.assignments) {
    const key = releasedContinuationKey(ledger, run, assignment);
    if (!key) continue;
    const id = orchestrationId(run.id, "released_delivery", key);
    if (pending.some(function existing(i) { return i.id === id; })) continue;
    pending.push({ id, kind: "host", source: "host", assignmentId: assignment.id, resultId: assignment.results.at(-1)!.id,
      basis: intentBasis(run, assignment.id), promptVersion: assignment.promptVersion, policyVersion: run.policy.settingsVersion,
      state: "pending", at: new Date().toISOString(), continuation: { planVersion: run.planVersion, key },
      detail: "released_delivery: 原交付已确认释放，请核对最新报告、现有步骤验收和已规划下游；缺证据先实际检查，再沿原合同决定 accept/dispatch 或说明阻塞，不创建替代委派" });
  }
}

/** 只确认新版直接答复或普通工具执行；精确投递已消费且同 Turn 成功结束才收尾，不改变 Run 验收。 */
export function settleDirectResponses(run: OrchestrationRun, sessionId: string, execution: { turnId: string; execution: string; result?: string; waiting?: string } | null | undefined, activeJobs: boolean): void {
  if (!execution || execution.execution !== "inactive" || execution.result !== "completed" || execution.waiting || activeJobs) return;
  for (const intent of run.pending ?? []) {
    const wake = intent.wake, receipt = wake?.receipt;
    if (intent.kind !== "prompt" || intent.state !== "pending" || intent.decision || !wake?.directResponse || wake.orchestrationUsed || wake.revision !== run.revision || receipt?.state !== "confirmed" || receipt.sessionId !== sessionId || receipt.turnId !== execution.turnId) continue;
    if (wake.operation === "steer" && (wake.turnId !== execution.turnId || receipt.inputStatus !== "consumed")) continue;
    if (wake.operation === "start" && (receipt.execution?.turnId !== execution.turnId || receipt.execution.execution !== "inactive" || receipt.execution.result !== "completed")) continue;
    intent.state = "decided"; intent.attention = undefined;
  }
}

/** 已核清的重连或暂停只为原依据完整的决定更新 CAS 版本。 */
export function rebaseControllerCorrections(run: OrchestrationRun, previousRevision: number): void {
  for (const item of run.pending ?? []) {
    if (item.state !== "pending") continue;
    const decision = item.decision;
    const basis = intentBasis(run, item.assignmentId);
    if (decision?.state === "saved" && decision.next === 0 && decision.expectedRevision === previousRevision && item.basis === basis && repairReleaseResultId(item)) decision.expectedRevision = run.revision;
    if (!isCorrectableDecision({ ...run, revision: previousRevision }, item)) continue;
    if (!item.correction) { item.correction = { revision: run.revision, originalWake: item.wake }; item.wake = undefined; }
    else item.correction.revision = run.revision;
    item.basis = basis;
  }
}
