/** 执行者直输、主控裁决及业务职责接收共用 Run 账本和原生 Worker 回执。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeFactSnapshot } from "@autopilot-agent/core";
import { fitFileMentionReferences } from "@autopilot-agent/cli/dist/file-mention-budget.js";
import { requireRun, orchestrationId, type OrchestrationService } from "./orchestration-service";
import type { ExecutorInput, ExecutorInputDelivery, ExecutionReference, OrchestrationRun } from "./orchestration-store";
import { fitsManagedCommandPayload, type ManagedRuntimeCommand, type ManagedRuntimeIdentity, type ManagedRuntimeReceipt } from "./managed-runtime-service";
import { finishCoversStep } from "./orchestration-admission";
import { registerFinish } from "./orchestration-finish";

type Channel = Pick<import("./managed-runtime-host").ManagedRuntimeHost, "command" | "identity">;
type Prompt = NonNullable<import("@autopilot-agent/cli/dist/controller.js").CliControllerResult["preparedPrompt"]>;
const id = z.string().regex(/^[\w-]{1,128}$/u);
const text = z.string().trim().min(1).max(4000);
const relayAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputImpact"), requestId: id, impact: z.enum(["local", "cross_scope"]), detail: text }).strict(),
  z.object({ type: z.literal("inputResult"), requestId: id, detail: text }).strict(),
  z.object({ type: z.literal("inputDecision"), requestId: id, assignmentId: id.optional(), sessionId: id.optional(), decision: z.enum(["allow", "deny", "clarify"]), detail: text }).strict(),
  z.object({ type: z.literal("handoffReceived"), requestId: id }).strict(),
  z.object({ type: z.literal("finish"), promptVersion: z.number().int().positive(), stepId: id.optional() }).strict(),
]);

/** 只有当前已登记代次可认领；同 Session 的跨 Turn 继续保留来源原 Turn。 */
function sameOwner(left: ExecutionReference, right: Pick<ExecutionReference, "hostId" | "sessionId" | "owner" | "generation">): boolean {
  return left.hostId === right.hostId && left.sessionId === right.sessionId && left.owner === right.owner && left.generation === right.generation;
}

/** 标识普通输入因原执行者已交接而被拒绝，保留原控制错误码。 */
export class ExecutorHandoffComplete extends Error {}

/** 在提交路径锁内冻结来源、原文和版本，静态模板或工作区切换不会替换输入目标。 */
export async function saveExecutorInput(service: OrchestrationService, runId: string, assignmentId: string, ref: ExecutionReference, requestId: string, prompt: Prompt, isCurrent: () => boolean): Promise<void> {
  if (!/^[\w-]{1,128}$/u.test(requestId) || !prompt.content.trim() || Buffer.byteLength(prompt.content) > 30000 || prompt.delivery === "queue") throw new Error("ORCHESTRATION_INVALID_COMMAND");
  const digest = orchestrationId(JSON.stringify(prompt));
  await service.store.update(function save(ledger) {
    const run = requireRun(ledger.runs, runId);
    const currentId = ledger.currentRunIds?.[run.workspaceId] ?? ledger.runs.filter(function same(r) { return r.workspaceId === run.workspaceId; }).at(-1)?.id;
    const item = run.assignments.find(function target(a) { return a.id === assignmentId; });
    if (!isCurrent() || currentId !== run.id || run.navigationRemoved || !item?.execution || !sameOwner(ref, item.execution) || item.execution.turnId !== ref.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    const previous = item.directInputs?.find(function same(i) { return i.requestId === requestId; });
    if (previous) {
      if (previous.digest ? previous.digest !== digest : run.prompts[previous.promptVersion - 1]?.text !== prompt.content) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
      return;
    }
    if (item.state === "released" || (item.local.handoff && !item.local.obligations.length && !item.local.cooperation.length)) throw new ExecutorHandoffComplete("ORCHESTRATION_CONTINUE_DENIED");
    if (item.state !== "active" || item.local.handoff || run.controlOnly || run.acceptance === "accepted" || finishCoversStep(run, item.stepId) ||
      !ledger.leases?.some(function owns(l) { return l.runId === run.id && l.assignmentId === item.id; })) throw new Error("ORCHESTRATION_CONTINUE_DENIED");
    const promptVersion = run.prompts.length + 1;
    const { content, attachments, selectedSkills, activeSkills, fileMentions } = prompt;
    run.prompts.push({ version: promptVersion, at: new Date().toISOString(), text: content, scope: "assignment", targetId: item.id, terminalInput: true, executorSource: { sessionId: ref.sessionId, assignmentId, requestId }, attachments, selectedSkills, activeSkills, fileMentions });
    (item.directInputs ??= []).push({ requestId, promptVersion, revision: item.revision, source: ref, state: "offered", digest });
    run.revision++;
  });
}

/** 返回原执行者需要处理的请求；升级与新一任不能借用旧决定。 */
export function blockedExecutorInput(run: OrchestrationRun, assignmentId: string): ExecutorInput | undefined {
  const owner = run.assignments.find(function target(a) { return a.id === assignmentId; });
  return owner?.directInputs?.find(function blocked(i) {
    return !!owner.execution && sameOwner(i.source, owner.execution) && i.revision === owner.revision &&
      (["escalated", "clarifying"].includes(i.state) || i.state === "offered" && !!i.delivery ||
        i.state === "allowed" && !i.returnDelivery);
  });
}

/** Core 待回答/已回答状态绑定到预先登记的唯一主控澄清及精确 Turn。 */
export async function observeRelayQuestion(service: OrchestrationService, runId: string, ref: ExecutionReference, execution: RuntimeFactSnapshot["execution"]): Promise<void> {
  const interaction = execution?.interaction;
  if (!execution || !interaction?.requestId) return;
  await service.store.update(function observe(ledger) {
    const run = requireRun(ledger.runs, runId);
    if (!run.controller.execution || !sameOwner(ref, run.controller.execution)) return;
    const input = run.assignments.flatMap(function requests(item) { return item.directInputs ?? []; }).find(function waiting(i) { return i.state === "clarifying"; });
    const question = input?.question;
    if (!question || question.sessionId !== ref.sessionId || question.generation !== ref.generation || question.turnId !== execution.turnId ||
      execution.lastSeq <= question.sequence || question.requestId && question.requestId !== interaction.requestId) return;
    question.requestId = interaction.requestId;
    if (interaction.state === "decided") question.answered = true;
  });
}

/** 已提交给 Worker 的精确主控回答须在恢复原 Turn 前入关系账本。 */
export function saveRelayAnswer(run: OrchestrationRun, receipt: ManagedRuntimeReceipt, ref: ExecutionReference, questionId?: string): void {
  if (!run.controller.execution || !sameOwner(run.controller.execution, ref) || !questionId || receipt.operation !== "answer" ||
    receipt.state !== "confirmed" || receipt.code || receipt.sessionId !== ref.sessionId || !receipt.turnId) return;
  const waiting = run.assignments.flatMap(function requests(a) { return a.directInputs ?? []; }).find(function exact(i) {
    return i.state === "clarifying" && i.question?.sessionId === ref.sessionId && i.question.generation === ref.generation &&
      i.question.turnId === receipt.turnId && (!i.question.requestId || i.question.requestId === questionId);
  });
  if (waiting?.question) { waiting.question.requestId = questionId; waiting.question.answered = true; }
}

/** 主控与执行者分别登记语义决定和实际接收，角色与原 Turn 来自宿主。 */
export async function applyRelayAction(service: OrchestrationService, runId: string, binding: { sessionId: string; turnId: string }, identity: ManagedRuntimeIdentity, expectedRevision: number, sequence: number, input: unknown): Promise<unknown> {
  const action = relayAction.parse(input);
  return service.store.update(function apply(ledger) {
    const run = requireRun(ledger.runs, runId);
    const current = { ...identity, sessionId: binding.sessionId };
    const controller = run.controller.execution && sameOwner(run.controller.execution, current);
    const executor = run.assignments.find(function owns(a) { return a.execution && sameOwner(a.execution, current) && a.execution.turnId === binding.turnId; });
    if (run.navigationRemoved || !controller && !executor || expectedRevision !== run.revision) throw new Error("ORCHESTRATION_STALE_REVISION");
    if (action.type === "finish") {
      const prompt = run.prompts[action.promptVersion - 1];
      if (!controller || !prompt?.terminalInput) throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
      const directSource = prompt.executorSource;
      const origin = directSource && run.assignments.find(function source(a) { return a.id === directSource.assignmentId; })?.directInputs?.find(function same(i) {
        return i.requestId === directSource.requestId && i.promptVersion === prompt.version && i.source.sessionId === directSource.sessionId;
      });
      if (directSource && !origin) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const source = origin?.source ?? { ...run.controller.execution!, turnId: binding.turnId };
      const requestId = orchestrationId(run.id, "finish", String(action.promptVersion));
      registerFinish(run, { requestId, source, assignmentId: origin ? prompt.executorSource?.assignmentId : undefined, stepId: action.stepId, text: prompt.text });
      return { requestId };
    }
    if (action.type === "handoffReceived") {
      const handoff = executor && run.handoffs?.find(function same(h) { return h.requestId === action.requestId && h.assignmentId === executor.id && h.revision === executor.revision; });
      if (!handoff || !executor || executor.state !== "active" && executor.state !== "submitted" || binding.turnId !== executor.execution?.turnId) throw new Error("ORCHESTRATION_HANDOFF_TARGET_REQUIRED");
      if (!handoff.received) { handoff.received = { ...binding, at: new Date().toISOString() }; run.revision++; }
      return handoff;
    }
    let target = executor;
    let sourceSessionId: string | undefined;
    if (action.type === "inputDecision") {
      if (!controller) throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
      const { assignmentId, sessionId } = action;
      if (Boolean(assignmentId) !== Boolean(sessionId)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      sourceSessionId = sessionId;
      const owners = run.assignments.filter(function matches(a) {
        return (!assignmentId || a.id === assignmentId) && a.directInputs?.some(function same(i) {
          return i.requestId === action.requestId && (!sessionId || i.source.sessionId === sessionId);
        });
      });
      // 旧版只发 requestId 的调用保留唯一来源的兼容性；重名时要求完整身份。
      if (owners.length > 1) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
      target = owners[0];
    }
    const item = target?.directInputs?.find(function same(i) { return i.requestId === action.requestId && (!sourceSessionId || i.source.sessionId === sourceSessionId); });
    if (!target?.execution || !item || target.revision !== item.revision || !sameOwner(target.execution, item.source) || target.state !== "active") throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (action.type === "inputImpact") {
      if (!executor || item.delivery?.turnId !== binding.turnId || item.state !== "offered") throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      item.impact = action.detail; item.state = action.impact === "local" ? "local" : "escalated";
    } else if (action.type === "inputResult") {
      if (!executor || !(item.state === "local" && item.delivery?.turnId === binding.turnId || item.state === "allowed" && item.returnDelivery?.turnId === binding.turnId)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      item.result = action.detail; item.state = "reported";
    } else {
      if (!controller || !["escalated", "clarifying"].includes(item.state) || item.question && !item.question.answered) throw new Error("ORCHESTRATION_CONTROLLER_REQUIRED");
      if (action.decision === "clarify") {
        if (run.assignments.some(function waiting(a) { return a.directInputs?.some(function active(i) { return i.state === "clarifying"; }); })) throw new Error("ORCHESTRATION_QUESTION_PENDING");
        item.state = "clarifying";
        item.question = { sessionId: binding.sessionId, turnId: binding.turnId, generation: identity.generation, sequence };
      } else {
        item.state = action.decision === "allow" ? "allowed" : "denied";
        item.decision = action.detail;
      }
    }
    run.revision++;
    return item;
  });
}

/** 同一条直输的 Worker 正文可从已冻结的原文与路由身份重建。 */
function relayCommand(channel: Channel, ref: ExecutionReference, prompt: OrchestrationRun["prompts"][number], input: ExecutorInput, delivery: ExecutorInputDelivery, returning: boolean) {
  const { requestId, operation, turnId, previousTurnId } = delivery;
  const base = { operation, sessionId: ref.sessionId, requestId, turnId: operation === "steer" ? turnId : undefined, previousTurnId,
    attachments: returning ? undefined : prompt.attachments, selectedSkills: returning ? undefined : prompt.selectedSkills, activeSkills: returning ? undefined : prompt.activeSkills };
  /** 原文和稳定身份优先，摘录只占据剩余 IPC 预算。 */
  function content(fileMentions?: OrchestrationRun["prompts"][number]["fileMentions"]) {
    return JSON.stringify(returning
      ? { instruction: "来自固定主控的裁决，仅用于原委派和这条输入。按批准范围处理并 inputResult；拒绝时保持原职责。", requestId: input.requestId, decision: input.state, detail: input.decision }
      : { instruction: "来自本执行者终端的人工输入。用 orchestration_relay inputImpact 登记 local 或 cross_scope。局部补充在本委派处理并 inputResult；角色、依赖、验收、共享资源和不明影响交固定主控。宿主绑定角色始终有效。", requestId: input.requestId, text: prompt.text, fileMentions });
  }
  if (!fitsManagedCommandPayload({ ...channel.identity, ...base, content: content() })) return;
  const files = !returning && prompt.fileMentions?.length ? fitFileMentionReferences([prompt.fileMentions], function fits(candidate) {
    return fitsManagedCommandPayload({ ...channel.identity, ...base, content: content(candidate[0]) });
  })[0] : undefined;
  return { ...base, content: content(files) } satisfies Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>;
}

/** 回执未知先查询，Worker 确认无原记录时只补发相同请求身份。 */
export async function driveExecutorInputs(service: OrchestrationService, channel: Channel, run: OrchestrationRun): Promise<void> {
  for (const item of run.assignments) {
    const ref = item.execution;
    if (!ref || item.state !== "active" || ref.owner !== channel.identity.owner || ref.generation !== channel.identity.generation) continue;
    const input = item.directInputs?.find(function next(i) {
      return i.revision === item.revision && sameOwner(ref!, i.source) && ["offered", "allowed", "denied"].includes(i.state) &&
        !((i.state === "allowed" || i.state === "denied") && i.returnDelivery?.receipt?.state === "confirmed");
    });
    const prompt = input && run.prompts[input.promptVersion - 1];
    if (!input || !prompt) continue;
    const key = input.state === "offered" ? "delivery" : "returnDelivery";
    let request = input[key];
    let receipt = request ? await channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: request.requestId }) as ManagedRuntimeReceipt : undefined;
    if (!receipt || receipt.code === "MANAGED_REQUEST_UNKNOWN") {
      const activity = await channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      const execution = activity.snapshot.execution;
      const previousTurnId = request?.previousTurnId ?? ref.turnId;
      if (!execution || execution.turnId !== previousTurnId || execution.waiting || activity.activeJobs) continue;
      const operation = execution.execution === "active" ? "steer" : execution.execution === "inactive" && ["completed", "failed"].includes(execution.result ?? "") ? "start" : undefined;
      if (!operation || request && request.operation !== operation) continue;
      const requestId = request?.requestId ?? orchestrationId(run.id, item.id, ref.sessionId, input.requestId, key);
      const turnId = operation === "steer" ? execution.turnId : orchestrationId(run.hostId, ref.sessionId, requestId);
      const candidate: ExecutorInputDelivery = { requestId, operation, turnId, previousTurnId };
      const command = relayCommand(channel, ref, prompt, input, candidate, key === "returnDelivery");
      if (!command) continue;
      request = await service.store.update(function reserve(ledger) {
        const current = requireRun(ledger.runs, run.id);
        const assignment = current.assignments.find(function target(a) { return a.id === item.id; });
        const direct = assignment?.directInputs?.find(function same(i) { return i.requestId === input!.requestId && sameOwner(i.source, input!.source); });
        if (current.navigationRemoved || current.controlOnly || !assignment?.execution || finishCoversStep(current, assignment.stepId) ||
          !sameOwner(ref!, assignment.execution) || assignment.execution.turnId !== ref!.turnId || assignment.revision !== item.revision ||
          assignment.state !== "active" || assignment.local.handoff || !direct || direct.state !== input!.state ||
          !ledger.leases?.some(function owns(l) { return l.runId === current.id && l.assignmentId === item.id; })) return;
        const prior = direct[key];
        if (prior) return prior.requestId === request?.requestId && prior.turnId === candidate.turnId ? prior : undefined;
        direct[key] = candidate;
        if (operation === "start") {
          (assignment.previousExecutions ??= []).push(assignment.execution);
          assignment.execution = { ...assignment.execution, turnId, requestId };
          assignment.receipt = { requestId, sessionId: ref!.sessionId, state: "unconfirmed" };
        }
        current.revision++;
        return candidate;
      });
      if (!request || service.store.navigationRemoved(run.workspaceId)) continue;
      try { receipt = await channel.command(command) as ManagedRuntimeReceipt; }
      catch { receipt = { requestId, state: "unconfirmed" }; }
    }
    if (!request || !receipt || receipt.requestId !== request.requestId) continue;
    const confirmed = receipt;
    await service.store.update(function save(ledger) {
      const current = requireRun(ledger.runs, run.id);
      const assignment = current.assignments.find(function target(a) { return a.id === item.id; });
      const original = assignment?.directInputs?.find(function same(i) {
        return i.requestId === input!.requestId && i.revision === input!.revision && i.source.turnId === input!.source.turnId && sameOwner(i.source, input!.source);
      });
      const delivery = original?.[key];
      if (!delivery || delivery.requestId !== confirmed.requestId || confirmed.operation && confirmed.operation !== delivery.operation ||
        confirmed.sessionId && confirmed.sessionId !== ref!.sessionId || confirmed.turnId && confirmed.turnId !== delivery.turnId) return;
      delivery.receipt = confirmed;
      if (delivery.operation === "start" && assignment?.execution?.requestId === confirmed.requestId &&
        assignment.execution.turnId === delivery.turnId && sameOwner(assignment.execution, ref!)) assignment.receipt = confirmed;
    });
  }
}
