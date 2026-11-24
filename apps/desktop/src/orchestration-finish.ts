/** 收尾在现有关系事务冻结派工，复用原执行回执、报告和资源释放。 */
import { randomUUID } from "node:crypto";
import type { RuntimeFactSnapshot } from "@autopilot-agent/core";
import { orchestrationId, requireRun, type OrchestrationService } from "./orchestration-service";
import type { ExecutionReference, OrchestrationAssignment, OrchestrationRun } from "./orchestration-store";
import { finishCoversStep } from "./orchestration-admission";

type Channel = Pick<import("./managed-runtime-host").ManagedRuntimeHost, "command" | "identity">;
export interface FinishInput { stop?: true; requestId: string; text: string; source: ExecutionReference; assignmentId?: string; stepId?: string }

/** 调用方持有关系锁，重复请求复用同一目标集合和回执。 */
export function registerFinish(run: OrchestrationRun, input: FinishInput): void {
  if (!/^[\w-]{1,128}$/u.test(input.requestId) || !input.text.trim() || Buffer.byteLength(input.text) > 30000) throw new Error("ORCHESTRATION_INVALID_COMMAND");
  const source = input.assignmentId ? run.assignments.find(function exact(a) { return a.id === input.assignmentId; }) : undefined;
  if (input.source.sessionId !== (source?.execution ?? run.controller.execution)?.sessionId || input.assignmentId && !source ||
    input.stepId && !run.steps.some(function exact(s) { return s.id === input.stepId; }) ||
    input.stepId && source && input.stepId !== source.stepId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
  const prior = run.finishes?.find(function same(f) { return f.requestId === input.requestId; });
  if (prior) {
    if (prior.text !== input.text || prior.source.sessionId !== input.source.sessionId || prior.stepId !== input.stepId || prior.assignmentId !== input.assignmentId) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
    return;
  }
  const affected = run.assignments.filter(function scoped(a) {
    const step = run.steps.find(function exact(s) { return s.id === a.stepId; });
    return !input.stepId || a.stepId === input.stepId || step?.verifies?.stepId === input.stepId;
  });
  const targets = affected.map(function target(a) { return { assignmentId: a.id, noticeId: orchestrationId(run.id, a.id, "finish") }; });
  (run.finishes ??= []).push({ ...input, revision: run.revision, targets, at: new Date().toISOString() });
  for (const item of affected) if (item.state === "planned") item.state = "cancelled";
  // 待确认旧批次仍含已撤项时需重新封批；已批准的未涉范围可继续。
  const batch = run.batches?.find(function pending(b) { return b.planVersion === run.planVersion && b.state === "pending" && affected.some(function covered(a) { return b.assignmentIds.includes(a.id); }); });
  if (batch) { batch.state = "cancelled"; run.planVersion++; }
  run.revision++;
}

/** 终端/进度发起的原请求在与派工相同的事务内冻结。 */
export async function saveFinish(service: OrchestrationService, runId: string, input: FinishInput, currentView: () => boolean): Promise<void> {
  await service.store.update(function save(ledger) {
    const run = requireRun(ledger.runs, runId);
    const currentId = ledger.currentRunIds?.[run.workspaceId] ?? ledger.runs.filter(function same(r) { return r.workspaceId === run.workspaceId; }).at(-1)?.id;
    const expectedSource = input.assignmentId ? run.assignments.find(function exact(a) { return a.id === input.assignmentId; })?.execution : run.controller.execution;
    if (!currentView() || run.navigationRemoved || currentId !== run.id || !expectedSource || expectedSource.sessionId !== input.source.sessionId ||
      expectedSource.owner !== input.source.owner || expectedSource.generation !== input.source.generation || input.assignmentId && expectedSource.turnId !== input.source.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    registerFinish(run, input);
  });
}

/** 已确认报告或历史释放与本轮输入必须来自同一执行，旧报告不代替最新证据。 */
export function finishResult(item: OrchestrationAssignment) {
  const result = item.results.at(-1);
  return result && (result.turnId === item.execution?.turnId || !result.turnId && !item.previousExecutions?.length) ? result : undefined;
}

/** 收尾先向精确在途执行者发送一次通知，再依真实报告与资源状态形成唯一回执。 */
export async function driveFinishes(service: OrchestrationService, channel: Channel, run: OrchestrationRun): Promise<void> {
  const controller = run.controller.execution;
  if (!controller || !run.finishes?.some(function pending(f) { return !f.receipt; })) return;
  const api = service.bind(run.id, { kind: "controller", sessionId: controller.sessionId });
  const human = service.bind(run.id, { kind: "human" });
  const preserved = new Map<string, string>();
  const ids = new Map(run.finishes.filter(function open(f) { return !f.receipt; }).flatMap(function targets(f) { return f.targets.map(function target(t) { return [t.assignmentId, t.noticeId] as const; }); }));
  for (const [id, noticeId] of ids) {
    const latest = requireRun((await service.store.read()).runs, run.id);
    const item = latest.assignments.find(function same(a) { return a.id === id; });
    const ref = item?.execution;
    if (!item || !ref || !["submitted", "active"].includes(item.state) || !finishCoversStep(latest, item.stepId)) continue;
    if (item.state === "submitted") {
      const reconciled = item.submission === "create" && item.receipt?.state === "confirmed" ? latest : await api.query(id);
      const original = reconciled.assignments.find(function same(a) { return a.id === id; });
      if (original?.state === "submitted" && (original.receipt?.code === "MANAGED_REQUEST_UNKNOWN" || original.submission === "create" && original.receipt?.state === "confirmed")) {
        try { await human.cancelUnstarted(id, reconciled.revision); }
        catch (error) { if (!(error instanceof Error) || !["ORCHESTRATION_RELEASE_UNCONFIRMED", "ORCHESTRATION_EXECUTION_MISMATCH", "MANAGED_SCOPE_DENIED"].includes(error.message)) throw error; }
      }
      continue;
    }
    if (ref.owner !== channel.identity.owner || ref.generation !== channel.identity.generation) continue;
    const activity = await channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
    const execution = activity.snapshot.execution;
    if (!execution || execution.turnId !== ref.turnId) continue;
    if (latest.finishes?.some(function stop(f) { return f.stop && !f.receipt; })) {
      const inspection = await channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as import("./orchestration-contract").OrchestrationInspection;
      if (inspection.turnId !== ref.turnId) continue;
      const commands = inspection.jobs.filter(function stoppable(j) { return j.canStop; }).map(function stop(j) { return { operation: "stop_job" as "stop_job" | "cancel", jobId: j.jobId as string | undefined }; });
      if (inspection.canCancel) commands.push({ operation: "cancel", jobId: undefined });
      let current = latest;
      // 即使进程已经结束，也要查询原停止回执，不能让界面永久显示投递中。
      for (const c of item.controls ?? []) if (["cancel", "stop_job"].includes(c.operation) && c.receipt.state !== "confirmed" && !commands.some(function same(cmd) { return orchestrationId(noticeId, ref.turnId!, cmd.operation, cmd.jobId ?? "") === c.requestId; })) {
        current = await human.query(id, c.requestId);
      }
      for (const command of commands) {
        const requestId = orchestrationId(noticeId, ref.turnId!, command.operation, command.jobId ?? "");
        const prior = item.controls?.find(function same(c) { return c.requestId === requestId; });
        current = prior ? await human.query(id, requestId) : await human.control({ assignmentId: id, execution: ref, expectedRevision: current.revision, command: { ...command, requestId } });
      }
      if (inspection.execution === "inactive" && !inspection.activeJobs && !execution.waiting) {
        try { await human.abandonStopped(id, current.revision); }
        catch (error) { if (!(error instanceof Error) || !["ORCHESTRATION_RELEASE_UNCONFIRMED", "ORCHESTRATION_EXECUTION_MISMATCH"].includes(error.message)) throw error; }
      }
      continue;
    }
    if (execution.waiting || activity.activeJobs) continue;
    const result = finishResult(item);
    if (execution.execution === "inactive" && result && item.local.handoff && !item.local.obligations.length && !item.local.cooperation.length) {
      try { await api.release(latest.revision, id); }
      catch (error) { if (!(error instanceof Error) || !["ORCHESTRATION_RELEASE_UNCONFIRMED", "ORCHESTRATION_STALE_REVISION"].includes(error.message)) throw error; }
      continue;
    }
    const notice = item.controls?.find(function same(c) { return c.requestId === noticeId; });
    if (notice) {
      if (notice.receipt.state !== "confirmed") await api.query(id, noticeId);
      if (execution.execution === "inactive" && execution.result &&
        notice.receipt.state === "confirmed" && !notice.receipt.code && (notice.operation === "start" || notice.receipt.inputStatus === "consumed")) {
        preserved.set(id, execution.turnId);
      }
    } else if (!latest.controlOnly && !item.takeover && !item.local.handoff) {
      const content = "用户已要求有序收尾当前委派。停止开始新工作，保留已完成产物和证据，报告真实 checks、unresolved、结果与剩余协作；能安全结束时将本地交接标记 handoff。不要把未做验证写成通过。";
      try {
        if (execution.execution === "active") await api.control({ assignmentId: id, expectedRevision: latest.revision, execution: ref, command: { requestId: noticeId, operation: "steer", content } });
        else if (execution.execution === "inactive" && ["completed", "failed"].includes(execution.result ?? "")) await api.continueForFinish(id, latest.revision, noticeId, content);
      } catch (error) {
        if (!(error instanceof Error) || !["ORCHESTRATION_STALE_REVISION", "ORCHESTRATION_CONTINUE_DENIED", "ORCHESTRATION_CONTINUE_PENDING", "ORCHESTRATION_HANDOFF_INCOMPLETE", "ORCHESTRATION_FINISHING"].includes(error.message)) throw error;
      }
    }
  }
  const stop = run.finishes.find(function pending(f) { return f.stop && !f.receipt; });
  if (stop?.source.turnId && controller.owner === stop.source.owner && controller.generation === stop.source.generation) {
    const view = await channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: controller.sessionId }, true) as import("./orchestration-contract").OrchestrationInspection;
    if (view.turnId === stop.source.turnId) {
      const targets: { operation: "cancel" | "stop_job"; jobId?: string }[] = view.jobs.filter(function active(j) { return j.canStop; }).map(function job(j) { return { operation: "stop_job", jobId: j.jobId }; });
      if (view.canCancel) targets.push({ operation: "cancel" });
      for (const c of stop.controllerStops ?? []) if (c.state !== "confirmed" && (c.operation === "cancel" || c.operation === "stop_job") &&
        !targets.some(function same(t) { return t.operation === c.operation && t.jobId === c.jobId; })) targets.push({ operation: c.operation, jobId: c.jobId });
      for (const target of targets) {
        const requestId = orchestrationId(stop.requestId, stop.source.turnId, target.operation, target.jobId ?? "");
        const command = { ...target, sessionId: controller.sessionId, turnId: stop.source.turnId, requestId };
        const prior = stop.controllerStops?.find(function same(c) { return c.requestId === requestId; });
        const receipt = await channel.command(prior ? { operation: "query", targetRequestId: requestId, requestId: randomUUID() } : command) as import("./managed-runtime-service").ManagedRuntimeReceipt;
        await service.store.update(function record(ledger) {
          const finish = requireRun(ledger.runs, run.id).finishes!.find(function same(f) { return f.requestId === stop.requestId; })!;
          const exact = receipt.requestId === requestId && receipt.sessionId === command.sessionId && receipt.turnId === command.turnId && receipt.operation === command.operation && receipt.jobId === command.jobId;
          finish.controllerStops = [...(finish.controllerStops ?? []).filter(function other(c) { return c.requestId !== requestId; }), exact ? receipt : { ...command, state: "unconfirmed" }];
        });
      }
    }
  }
  const activity = await channel.command({ operation: "activity", requestId: randomUUID(), sessionId: controller.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
  await service.store.update(function settle(ledger) {
    const current = requireRun(ledger.runs, run.id);
    for (const finish of current.finishes ?? []) {
      if (finish.receipt || !finish.stepId && (activity.activeJobs || activity.snapshot.execution && (activity.snapshot.execution.execution !== "inactive" || activity.snapshot.execution.waiting))) continue;
      const targets = finish.targets.map(function item(t) { return current.assignments.find(function same(a) { return a.id === t.assignmentId; }); });
      if (targets.some(function unsettled(a) {
        if (!a) return true;
        if (preserved.has(a.id) && preserved.get(a.id) === a.execution?.turnId) return false;
        return !["released", "cancelled"].includes(a.state) || ledger.leases?.some(function occupied(l) { return l.runId === run.id && l.assignmentId === a.id; });
      })) continue;
      finish.receipt = { at: new Date().toISOString(), results: targets.flatMap(function row(a) {
        if (!a) return [];
        const report = finishResult(a);
        const accepted = !!report && current.steps.some(function verdict(s) { return s.verdict?.accepted && s.verdict.assignmentId === a.id && s.verdict.resultId === report.id; });
        const unresolved = [...(report?.unresolved ?? []), ...a.local.obligations, ...a.local.cooperation];
        if (!report) unresolved.push(a.state === "cancelled" ? "已撤销，未交付报告。" : "无当前执行报告。");
        if (preserved.has(a.id) && a.state !== "released") unresolved.push("局部交接或资源释放未完成，保留原记录和占用。");
        if (!accepted) unresolved.push("未完成业务验收。");
        return [{ assignmentId: a.id, resultId: report?.id, accepted, released: a.state === "released", unresolved }];
      }) };
    }
  });
}
