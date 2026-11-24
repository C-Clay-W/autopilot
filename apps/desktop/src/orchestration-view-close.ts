/** 受信用户关闭执行者视图时，保存精确执行的进度审计，不结算业务委派。 */
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { orchestrationId, requireRun, type OrchestrationService } from "./orchestration-service";
import { requireCompatibleWorkflow } from "./orchestration-admission";
import type { ExecutionReference, OrchestrationAssignment, OrchestrationRun } from "./orchestration-store";
import type { ManagedRuntimeHost } from "./managed-runtime-host";
import type { ManagedLeaseActivity, ManagedRuntimeReceipt } from "./managed-runtime-service";

const progress = z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/u), progress: z.string().trim().min(1).max(4000), completed: z.array(z.string().max(1000)).max(20), remaining: z.array(z.string().max(1000)).max(20), conclusion: z.string().trim().min(1).max(2000) }).strict();

/** 只有同一 Worker 下已结束或未启动的明确状态可认定为无活动。 */
export function viewCloseActivity(activity: ManagedLeaseActivity): "active" | "waiting" | "inactive" | "unknown" {
  if (!["active", "inactive"].includes(activity.execution) || typeof activity.activeJobs !== "boolean" || typeof activity.activeTurn !== "boolean"
    || !["idle", "running", "waiting_approval", "waiting_user_input", "completed", "failed", "interrupted"].includes(activity.status)) return "unknown";
  if (activity.waiting || ["waiting_approval", "waiting_user_input"].includes(activity.status)) return "waiting";
  if (activity.activeTurn || activity.activeJobs || activity.execution === "active") return "active";
  return activity.status === "running" ? "unknown" : "inactive";
}

/** 只接纳已确认关闭请求对应的现行执行者，保存真实原文且不更新交接或验收。 */
export async function saveViewCloseProgress(service: OrchestrationService, runId: string, assignmentId: string, execution: ExecutionReference, value: unknown): Promise<{ saved: true }> {
  const parsed = progress.safeParse(value);
  if (!parsed.success) throw new Error("ORCHESTRATION_VIEW_CLOSE_REPORT_INVALID");
  const { requestId, ...report } = parsed.data;
  return service.store.update(function save(ledger) {
    const run = requireRun(ledger.runs, runId);
    const item = run.assignments.find(function own(a) { return a.id === assignmentId; });
    const record = item?.viewCloseReports?.find(function same(r) { return r.requestId === requestId; });
    if (!record || run.navigationRemoved || JSON.stringify(item?.execution) !== JSON.stringify(execution) || JSON.stringify(record.execution) !== JSON.stringify(execution)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (!record.report) record.report = { ...report, savedAt: new Date().toISOString() };
    return { saved: true as const };
  });
}

/** 沿原 controller 对该执行者的 steer 准入发通知，只等待该次持久报告。 */
export async function recordViewCloseProgress(service: OrchestrationService, channel: Pick<ManagedRuntimeHost, "command">, run: OrchestrationRun, assignment: OrchestrationAssignment, viewId: string, isCurrent: () => boolean): Promise<void> {
  const execution = assignment.execution!;
  const requestId = orchestrationId("view-close", run.id, assignment.id, viewId, JSON.stringify(execution));
  /** 仅用户确认后登记发送意图，并复用原 controller 注入的权限约束。 */
  const reserved = await service.store.update(function reserve(ledger) {
    const current = requireRun(ledger.runs, run.id);
    const selected = ledger.currentRunIds?.[run.workspaceId] ?? ledger.runs.filter(function same(r) { return r.workspaceId === run.workspaceId; }).at(-1)?.id;
    const item = current.assignments.find(function own(a) { return a.id === assignment.id; });
    if (!isCurrent() || selected !== current.id || current.navigationRemoved || !item?.execution || JSON.stringify(item.execution) !== JSON.stringify(execution) || item.state !== "active") throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (current.controlOnly || item.takeover || item.local.handoff || !ledger.leases?.some(function own(lease) { return lease.runId === current.id && lease.assignmentId === item.id; })) throw new Error("ORCHESTRATION_VIEW_CLOSE_REPORT_WAITING");
    requireCompatibleWorkflow(item);
    const prior = item.viewCloseReports?.find(function same(r) { return r.requestId === requestId; });
    if (!prior) (item.viewCloseReports ??= []).push({ requestId, execution, requestedAt: new Date().toISOString() });
    return { prior: !!prior, saved: !!prior?.report, receipt: prior?.receipt };
  });
  if (reserved.saved) return;
  let receipt = reserved.receipt;
  if (!receipt || receipt.state === "submitted" || receipt.state === "unconfirmed") {
    const content = `用户已确认请求关闭此终端视图。请先把当前真实进度、已完成和未完成事项、结论保存到持久审计。现在调用 orchestration_report，payload 只提交 {"viewCloseProgress":{"requestId":"${requestId}","progress":"进度","completed":[],"remaining":[],"conclusion":"结论"}}。保存后继续处理原任务和审批。`;
    let pending!: Promise<unknown>;
    await service.store.update(function send(ledger) {
      const current = requireRun(ledger.runs, run.id);
      const item = current.assignments.find(function own(a) { return a.id === assignment.id; });
      const record = item?.viewCloseReports?.find(function same(r) { return r.requestId === requestId; });
      if (!isCurrent() || current.navigationRemoved || current.controlOnly || !record || !item || item.state !== "active" || item.takeover || item.local.handoff || JSON.stringify(item.execution) !== JSON.stringify(execution) || !ledger.leases?.some(function own(lease) { return lease.runId === current.id && lease.assignmentId === item.id; })) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      requireCompatibleWorkflow(item);
      // 同次准入内发消息，事务外等 Worker，保留审批与收尾的关系账本写入。
      const command = reserved.prior ? { operation: "query" as const, requestId: randomUUID(), targetRequestId: requestId } : { operation: "steer" as const, requestId, sessionId: execution.sessionId, turnId: execution.turnId, content };
      pending = channel.command(command).catch(function unknown() { return undefined; });
    });
    receipt = await pending as ManagedRuntimeReceipt | undefined;
    await service.store.update(function acknowledge(ledger) {
      const item = requireRun(ledger.runs, run.id).assignments.find(function own(a) { return a.id === assignment.id; });
      const record = item?.viewCloseReports?.find(function same(r) { return r.requestId === requestId; });
      if (record) record.receipt = receipt;
    });
  }
  if (!receipt || receipt.requestId !== requestId || receipt.operation !== "steer" || !["accepted", "confirmed"].includes(receipt.state) || receipt.inputStatus === "cancelled" || receipt.code || receipt.sessionId !== execution.sessionId || receipt.turnId !== execution.turnId) throw new Error("ORCHESTRATION_VIEW_CLOSE_REPORT_UNCONFIRMED");
  const until = Date.now() + 20_000;
  do {
    if (!isCurrent()) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    const current = requireRun((await service.store.read()).runs, run.id);
    const item = current.assignments.find(function own(a) { return a.id === assignment.id; });
    if (current.navigationRemoved || !item?.execution || JSON.stringify(item.execution) !== JSON.stringify(execution)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (item.viewCloseReports?.some(function saved(r) { return r.requestId === requestId && !!r.report; })) return;
    await wait(250);
  } while (Date.now() < until);
  throw new Error("ORCHESTRATION_VIEW_CLOSE_REPORT_PENDING");
}
