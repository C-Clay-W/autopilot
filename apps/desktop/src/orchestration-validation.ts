/** 编排决定的无副作用结构校验；字段路径用于模型纠正，业务准入仍由原服务执行。 */
import type { OrchestrationRun, OrchestrationIntent } from "./orchestration-store";
import { orchestrationId } from "./orchestration-service";
import { z } from "zod";

const text = z.string().trim().min(1);
const id = z.string().regex(/^[\w-]{1,128}$/);
const execution = z.object({ hostId: id, sessionId: id, requestId: id, owner: id, generation: id, turnId: id.optional() }).strict();
export const controllerRelationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step"), step: z.object({ id, goal: text, scope: z.string(), dependencies: z.array(id), deliverables: z.array(text), acceptance: z.array(text), verifies: z.object({ stepId: id, browser: z.boolean().optional() }).strict().optional() }).strict() }).strict(),
  z.object({ type: z.literal("assign"), assignment: z.object({ id, stepId: id, content: text, purpose: z.enum(["initial", "repair", "reassign"]), previousId: id.optional(), access: z.enum(["read", "write"]) }).strict() }).strict(),
  z.object({ type: z.literal("handoff"), handoff: z.object({ assignmentId: id, fromAssignmentId: id.optional(), goal: text, background: text, artifacts: z.array(z.object({ artifact: text, contentVersion: text }).strict()).max(20), unresolved: z.array(text).max(40), scope: text }).strict() }).strict(),
  z.object({ type: z.literal("accept"), assignmentId: id, resultId: id, evidenceIds: z.array(id).min(1), verificationAssignmentId: id.optional() }).strict(),
  z.object({ type: z.literal("revise"), assignmentId: id, content: text }).strict(),
  z.object({ type: z.literal("replan"), assignmentId: id, resultId: id, reason: text }).strict(),
  z.object({ type: z.literal("cancelPlanned"), assignmentId: id }).strict(),
  z.object({ type: z.literal("seal") }).strict(),
  z.object({ type: z.literal("acceptRun") }).strict(),
]);
export const controllerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopRun") }).strict(),
  z.object({ kind: z.literal("recoverApproval"), id }).strict(),
  z.object({ kind: z.literal("relation"), action: controllerRelationSchema }).strict(),
  z.object({ kind: z.enum(["dispatch", "release", "query"]), assignmentId: id }).strict(),
  z.object({ kind: z.literal("continue"), assignmentId: id, content: text }).strict(),
  z.object({ kind: z.literal("control"), assignmentId: id, execution, operation: z.enum(["steer", "queue", "resume", "cancel", "stop_job"]), content: text.optional(), jobId: id.optional() }).strict(),
]).superRefine(function controlFields(action, context) {
  if (action.kind !== "control") return;
  if (action.operation === "stop_job" && !action.jobId) context.addIssue({ code: "custom", path: ["jobId"], message: "Required for stop_job" });
  if (["steer", "queue"].includes(action.operation) && !action.content) context.addIssue({ code: "custom", path: ["content"], message: "Required for input" });
});
const decisionSchema = z.object({ intentId: id, basis: id, expectedRevision: z.number().int().positive(), reason: text, actions: z.array(controllerActionSchema).max(40) }).strict();

/** 仅返回字段位置和固定 schema 错误，不回显输入、路径内容或其他会话数据。 */
export class ControllerDecisionValidationError extends Error {
  constructor(readonly fields: string[]) { super("ORCHESTRATION_INVALID_DECISION"); }
}

/** 在保存前检查整批结构，后续动作错误也不能先落盘或执行前面的动作。 */
export function validateControllerDecision(input: unknown): void {
  const result = decisionSchema.safeParse(input);
  if (!result.success) throw new ControllerDecisionValidationError(result.error.issues.map(function field(issue) { return issue.path.join("."); }));
  if (Buffer.byteLength(JSON.stringify(input)) > 60000) throw new ControllerDecisionValidationError(["payload"]);
}

/** 只有同一报告意图内明确相邻的 release 和 replan 才能按报告退役。 */
export function repairReleaseResultId(intent: OrchestrationIntent): string | undefined {
  const decision = intent.decision;
  if (!decision || intent.kind !== "result") return undefined;
  const release = decision.actions[decision.next], replan = decision.actions[decision.next + 1];
  if (release?.kind !== "release" || release.assignmentId !== intent.assignmentId || replan?.kind !== "relation" || replan.action.type !== "replan" || replan.action.assignmentId !== intent.assignmentId || replan.action.resultId !== intent.resultId) return undefined;
  return intent.resultId;
}

/** 只识别首动作零副作用的结构或交接错误；修订前提由受信人类输入事务向前绑定。 */
export function isCorrectableDecision(run: OrchestrationRun, intent: OrchestrationIntent): boolean {
  const previous = intent.decision, first = previous?.actions[0];
  return !!previous && previous.state === "blocked" && previous.next === 0
    && (first?.kind === "release" && intent.kind === "result" && first.assignmentId === intent.assignmentId && previous.error === "ORCHESTRATION_RELEASE_HANDOFF_REQUIRED"
    || first?.kind === "relation" && ["step", "assign"].includes(first.action?.type)
    && !controllerActionSchema.safeParse(first).success
    && ["ORCHESTRATION_INVALID_STEP", "ORCHESTRATION_INVALID_ASSIGNMENT"].includes(previous.error ?? ""))
    && (intent.correction?.revision ?? previous.expectedRevision) === run.revision
    && !run.records.some(function applied(record) { return record.requestId === orchestrationId(intent.id, "0"); });
}
