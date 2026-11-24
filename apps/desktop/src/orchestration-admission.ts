/** 编排确定性准入：真实目录仲裁和持久占用，不按角色名、Turn 终态或进程超时释放。 */
import { realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { CheckoutLease, EvidenceReference, OrchestrationLedger, OrchestrationRun, OrchestrationAssignment } from "./orchestration-store";
import { ORCHESTRATION_DELIVERY_GUIDANCE, ORCHESTRATION_REPORT_GUIDANCE } from "./orchestration-skill";

/** 解析符号链接及 Git 根；非 Git 目录按所选实际根仲裁。 */
export async function canonicalCheckout(path: string): Promise<string> {
  const original = await realpath(path);
  if (!(await stat(original)).isDirectory()) throw new Error("ORCHESTRATION_DIRECTORY_REQUIRED");
  let current = original;
  let selected = original;
  for (;;) {
    try { await stat(join(current, ".git")); selected = current; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.platform === "win32" ? selected.toLowerCase() : selected;
}

/** 占用与派工记录在同一事务提交；同目录验证也等待写入完成。 */
export function reserveCheckout(ledger: OrchestrationLedger, run: OrchestrationRun, assignment: Pick<OrchestrationAssignment, "id" | "checkout">): void {
  const leases = ledger.leases ??= [];
  if (leases.some(function same(lease) { return lease.runId === run.id && lease.assignmentId === assignment.id; })) return;
  // shortcut: 当前 Runtime 没有只读工具沙箱证明，所有委派保守占写锁，具备真实只读能力后再开放并发读者。
  if (leases.some(function conflict(lease) { return checkoutOverlaps(lease, assignment.checkout); })) throw new Error("ORCHESTRATION_CHECKOUT_BUSY");
  leases.push({ checkout: assignment.checkout, runId: run.id, assignmentId: assignment.id, access: "write" });
}

/** 相同目录和同时覆盖上下级的目录共享原有写入仲裁。 */
export function checkoutOverlaps(lease: CheckoutLease, checkout: string): boolean {
  return lease.checkout === checkout || lease.checkout.startsWith(checkout + sep) || checkout.startsWith(lease.checkout + sep);
}

/** 仅在调用方已核实真实活动与交接后释放，未知或重启不会自动调用。 */
export function releaseCheckout(ledger: OrchestrationLedger, run: OrchestrationRun, assignment: OrchestrationAssignment, inactive: boolean, activeJobs: boolean): void {
  if (!inactive || activeJobs || assignment.receipt?.state === "unconfirmed") throw new Error("ORCHESTRATION_RELEASE_UNCONFIRMED");
  if (!assignment.local.handoff || assignment.local.obligations.length || assignment.local.cooperation.length) throw new Error("ORCHESTRATION_RELEASE_HANDOFF_REQUIRED");
  ledger.leases = (ledger.leases ?? []).filter(function keep(lease) { return lease.runId !== run.id || lease.assignmentId !== assignment.id; });
  assignment.state = "released";
}

/** 独立复核只读取原完成释放且与最新原文、精确 Turn 一致的本地交付。 */
export function releasedDelivery(ledger: OrchestrationLedger, run: OrchestrationRun, item?: OrchestrationAssignment) {
  const result = item?.results.at(-1);
  if (!item?.execution?.turnId || item.execution.hostId !== run.hostId || item.state !== "released" || item.completedReleaseTurnId !== item.execution.turnId || item.checkoutYielded
    || item.receipt?.state === "unconfirmed" || !item.local.handoff || item.local.obligations.length || item.local.cooperation.length
    || !result || result.revision !== item.revision || result.turnId !== item.execution.turnId || result.promptVersion !== item.promptVersion
    || item.promptVersion !== assignmentPrompts(run, item).at(-1)?.version || !Array.isArray(result.unresolved) || result.unresolved.length || !result.evidence.length
    || ledger.leases?.some(function owned(lease) { return lease.runId === run.id && lease.assignmentId === item.id; })) return undefined;
  return result;
}

/** 双方须明确报告同一具名交付物及版本；仅版本字符串碰巧相同不构成证据。 */
export function matchingEvidence(references: EvidenceReference[], originals: EvidenceReference[]): boolean {
  return originals.every(function original(evidence) {
    return references.some(function same(reference) { return reference.artifact === evidence.artifact && reference.contentVersion === evidence.contentVersion; });
  });
}

/** 仅匹配独立的人工操作口令；附件、技能、模板及局部输入仍是需求。 */
export function continuationAction(prompt: Pick<OrchestrationRun["prompts"][number], "scope" | "text" | "attachments" | "selectedSkills" | "activeSkills" | "fileMentions" | "flow" | "independentVerification" | "executorSource">): "continue" | "resubmit" | undefined {
  if (prompt.scope !== "run" || prompt.attachments?.length || prompt.selectedSkills?.length || prompt.activeSkills?.length || prompt.fileMentions?.length || prompt.flow || prompt.independentVerification || prompt.executorSource) return;
  const text = prompt.text.trim().replace(/[。！!]$/u, "");
  if (/^(继续执行|继续原任务|继续执行原任务)$/u.test(text)) return "continue";
  if (/^(?:继续执行[，,]\s*)?重新弹出派工审核$/u.test(text)) return "resubmit";
}

/** 只收集当前委派适用的用户输入，局部输入不扩散到无关任务。 */
export function assignmentPrompts(run: OrchestrationRun, assignment: Pick<OrchestrationAssignment, "id" | "stepId">) {
  return visibleRunPrompts(run).filter(function relevant(prompt) { return !(prompt.version > 1 && !prompt.queue && continuationAction(prompt)) && (prompt.scope === "run" || prompt.targetId === (prompt.scope === "step" ? assignment.stepId : assignment.id)); });
}

/** 下一轮的排队正文不进入本轮的模型上下文、委派或意图版本依据。 */
export function visibleRunPrompts(run: OrchestrationRun): OrchestrationRun["prompts"] {
  const rejected = new Set(run.pending?.filter(function tooLarge(i) { return i.kind === "prompt" && i.attention === "input_too_large"; }).map(function version(i) { return i.promptVersion; }));
  return run.prompts.filter(function active(prompt) {
    return !rejected.has(prompt.version) && (!prompt.queue || prompt.queue.activated && run.pending?.some(function started(i) { return i.kind === "prompt" && i.promptVersion === prompt.version && !!i.wake; }));
  }).map(function original({ fileMentions, ...prompt }) {
    // 摘录只进入已测量的主控投递，不随历史合同或委派请求重复发送。
    return prompt;
  });
}

/** Skill 自报只描述局部状态，不授予 Thread 或扩员能力。 */
export function requireCompatibleWorkflow(assignment: OrchestrationAssignment): void {
  if (assignment.local.skills.some(function incompatible(skill) { return skill.requiresAgents; })) throw new Error("ORCHESTRATION_SKILL_REQUIRES_PEERS");
}

/** 用户原文及冻结职责策略作为当前委派上下文传递；不让模板覆盖原文。 */
export function assignmentInput(run: OrchestrationRun, assignment: OrchestrationAssignment): string {
  const plannedReview = run.steps.find(function reviewer(step) { return step.verifies?.stepId === assignment.stepId; })?.id;
  const handoff = run.handoffs?.find(function assigned(item) { return item.assignmentId === assignment.id && item.revision === assignment.revision; });
  return JSON.stringify({ assignment: { id: assignment.id, revision: assignment.revision, task: assignment.content, plannedReview, verification: assignment.verification, handoff }, responsibility: run.policy.responsibility, userPrompts: assignmentPrompts(run, assignment), requiredSkills: assignment.local.requiredSkills, policy: "你是本 Assignment 的受管执行者。userPrompts 中的 /ap-orchestration 模板由主控处理；不自行加载 builtin:ap-orchestration，按 assignment.task 和 orchestration_query 的执行者合同工作，以 orchestration_report 回报实际结果或阻塞。用户明确要求优先；只执行当前委派。主控和执行者均禁用 Thread；协作需求报告主控。局部自测不等于独立验证或业务验收。存在 handoff 时，先完整消费目标、背景、产物版本、未决事项和范围，再用 orchestration_relay 的 handoffReceived 确认，结果回报原 Run 主控。" + ("\n\n" + (plannedReview ? ORCHESTRATION_REPORT_GUIDANCE : ORCHESTRATION_DELIVERY_GUIDANCE)) });
}

/** 单项收尾包括该项和对应独立复查；全 Run 收尾对后续任何派工生效。 */
export function finishCoversStep(run: OrchestrationRun, stepId?: string, sourceStepId?: string): boolean {
  const source = sourceStepId ?? run.steps.find(function exact(s) { return s.id === stepId; })?.verifies?.stepId;
  return (run.finishes ?? []).some(function covers(f) { return !f.stepId || f.stepId === stepId || f.stepId === source; });
}

/** 同 Step 修复/改派共用外层预算，首次持久接纳计数；未知提交不退还、不新建绕过。 */
export function reserveBudget(run: OrchestrationRun, assignment: OrchestrationAssignment): void {
  if (assignment.state !== "planned") return;
  const active = run.assignments.filter(function active(item) { return item.state === "submitted" || item.state === "active"; });
  if (active.length >= run.policy.maxConcurrent) throw new Error("ORCHESTRATION_CONCURRENCY_LIMIT");
  const step = run.steps.find(function target(step) { return step.id === assignment.stepId; })!;
  if (assignment.purpose !== "initial") {
    const previous = run.assignments.find(function target(item) { return item.id === assignment.previousId; });
    // 该回执仅由 cancelUnstarted 核查并原子释放占用后写入，普通取消或未知停止不可复用。
    const cancelledUnstarted = previous?.state === "cancelled" && previous.receipt?.state === "confirmed" && previous.receipt.code === "MANAGED_NOT_STARTED_CANCELLED" && previous.local.handoff && !previous.local.obligations.length && !previous.local.cooperation.length;
    const retiredForRepair = previous?.state === "cancelled" && previous.retiredForRepair?.turnId === previous.execution?.turnId && !!previous.retiredForRepair;
    if (!previous || (previous.state !== "released" && !cancelledUnstarted && !retiredForRepair)) throw new Error("ORCHESTRATION_PREVIOUS_UNSETTLED");
    const limit = Math.min(run.policy.repairLimit, step.skillRepairLimit ?? Infinity);
    if (step.repairs >= limit) throw new Error("ORCHESTRATION_REPAIR_LIMIT");
    step.repairs++;
  }
}
