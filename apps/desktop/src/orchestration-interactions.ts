/** 编排交互仅由当前 Runtime 的一致快照投影；断连缓存只能提示核查。 */
import type { ManagedFactsLedger } from "./managed-facts-host";
import type { OrchestrationInspection, OrchestrationRunView } from "./orchestration-contract";

/** 已保存决定与在线事实使用同一精确交互键。 */
export function interactionKey(ref: { owner: string; generation: string; sessionId: string }, turnId: string, kind: "approval" | "question", id: string): string {
  return JSON.stringify([ref.owner, ref.generation, ref.sessionId, turnId, kind, id]);
}

/** 精确绑定 Runtime、Session、Turn 与请求；同一身份只显示一次。 */
export function projectInteractions(connected: boolean, ledger: Readonly<ManagedFactsLedger> | undefined, targets: { assignmentId?: string; execution?: { owner: string; generation: string; sessionId: string; turnId?: string } }[], decided?: ReadonlySet<string>, failed?: ReadonlySet<string>): NonNullable<OrchestrationRunView["interactions"]> {
  const items = new Map<string, NonNullable<OrchestrationRunView["interactions"]>[number]>();
  for (const target of targets) {
    const ref = target.execution;
    if (!ref || target.assignmentId && !ref.turnId) continue;
    const facts = ledger?.sessions[ref.sessionId];
    const execution = facts?.snapshot?.execution;
    const interaction = execution?.interaction;
    if (!execution || !interaction || !["pending", "unconfirmed"].includes(interaction.state) || ref.turnId && ref.turnId !== execution.turnId) continue;
    const kind = interaction.approvalId ? "approval" : "question";
    const id = interaction.approvalId ?? interaction.requestId;
    if (!id) continue;
    const key = interactionKey(ref, execution.turnId, kind, id);
    if (decided?.has(key)) continue;
    const current = connected && ledger?.connection.owner === ref.owner && ledger.connection.generation === ref.generation && facts?.reconciliation === "consistent" && !failed?.has(ref.sessionId);
    items.set(key, { key, assignmentId: target.assignmentId, sessionId: ref.sessionId, turnId: execution.turnId, requestId: id, kind, state: current && interaction.state === "pending" ? "pending" : "unconfirmed" });
  }
  return [...items.values()];
}

/** 缓存详情只有与当前快照的 Turn 和请求同时一致才可提交决定。 */
export function currentInspection(inspection: OrchestrationInspection | undefined, interactions: NonNullable<OrchestrationRunView["interactions"]>, assignmentId?: string, continuations?: OrchestrationRunView["approvalContinuations"]): OrchestrationInspection | undefined {
  if (!inspection?.interaction || inspection.interaction.state !== "pending") return inspection;
  const id = inspection.interaction.approval?.approvalId ?? inspection.interaction.question?.requestId;
  const saved = inspection.interaction.approval && continuations?.find(function exact(item) { return item.assignmentId === assignmentId && item.turnId === inspection.turnId && item.approvalId === id && item.approval.state === "confirmed" && !item.approval.code; });
  if (saved) return { ...inspection, interaction: { ...inspection.interaction, state: "decided" } };
  const current = interactions.some(function same(item) { return item.assignmentId === assignmentId && item.turnId === inspection.turnId && item.state === "pending" && item.requestId === id; });
  return current ? inspection : { ...inspection, interaction: { state: "unconfirmed" } };
}

/** 仅提供当前 Run 中有完整安全展示且身份与最新事实一致的审批。 */
export function pendingRunApprovals(run: OrchestrationRunView) {
  if (!run.connected || !run.current) return [];
  return (run.interactions ?? []).flatMap(function direct(item) {
    if (item.kind !== "approval" || item.state !== "pending" || run.approvalContinuations?.some(function submitted(saved) { return saved.sessionId === item.sessionId && saved.turnId === item.turnId && saved.approvalId === item.requestId; })) return [];
    const assignment = run.assignments.find(function same(a) { return a.id === item.assignmentId; });
    if (item.assignmentId && (!assignment || assignment.state === "cancelled" || assignment.state === "released")) return [];
    const sessionId = assignment ? assignment.sessionId : run.controllerId;
    const inspection = assignment ? assignment.inspection : run.controllerInspection;
    const executionToken = assignment ? assignment.executionToken : run.controllerToken;
    const approval = inspection?.interaction?.approval;
    if (item.sessionId !== sessionId || item.turnId !== inspection?.turnId || inspection.interaction?.state !== "pending" || item.requestId !== approval?.approvalId || !approval.display || !executionToken) return [];
    return [{ ...item, approval, executionToken }];
  });
}
