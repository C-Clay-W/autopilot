/** 外部执行请求共享预检与每调用能力签发；工具参数只能请求，不能制造批准。 */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveFileTarget } from "./path-access-policy";
import { normalizeProgramName } from "./command-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import { computeExternalExecutionConstraint, type ExternalExecutionAuthorization, type ExternalExecutionTarget, type ExternalWriteCapability } from "../../../runtime/domain/external-execution";
import type { ToolExecutionContext } from "../types";
import { hashNormalizedToolInput } from "../normalized-tool-input";

const issuedCapabilities = new WeakSet<object>();
const claimedCapabilities = new WeakSet<object>();
const approvedAuthorizations = new WeakSet<object>();
const dispatchedCapabilities = new WeakSet<object>();

/** ApprovalService 校验真实批准后标记结果，任意注入端口返回的对象不是授权。 */
export function sealExternalExecutionAuthorization(value: ExternalExecutionAuthorization): ExternalExecutionAuthorization {
  const authorization = Object.freeze({ ...value });
  approvedAuthorizations.add(authorization);
  return authorization;
}

/** 从严格工具输入重新预检精确目标、cwd 和命令身份；不创建任何文件或目录。 */
export async function resolveExternalExecutionTarget(workspaceRoot: string | undefined, input: unknown): Promise<ExternalExecutionTarget | undefined> {
  if (!input || typeof input !== "object") return undefined;
  const command = input as { externalWriteTarget?: unknown; program?: unknown; args?: unknown; cwd?: unknown };
  if (command.externalWriteTarget === undefined) return undefined;
  if (typeof command.externalWriteTarget !== "string" || /[*?\n\r]/u.test(command.externalWriteTarget) || typeof command.program !== "string" || !Array.isArray(command.args) || !command.args.every(function stringArg(arg) { return typeof arg === "string"; }) || typeof command.cwd !== "string") throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "外部写请求必须是一个精确文件和结构化命令");
  const target = await resolveFileTarget(workspaceRoot, command.externalWriteTarget);
  const cwd = await resolveFileTarget(workspaceRoot, command.cwd);
  if (!target.isExternal || !cwd.exists) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "外部写请求须指向工作区外精确文件且执行目录存在");
  if (target.exists && !(await stat(target.canonicalTarget)).isFile()) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "外部写请求不支持目录或特殊文件");
  const program = command.program.replace(/\\/gu, "/");
  const commandDigest = createHash("sha256").update(JSON.stringify({ program: normalizeProgramName(command.program), programIdentity: /^[a-z]:\//iu.test(program) ? program.toLowerCase() : program, args: command.args, cwd: /^[a-z]:/iu.test(cwd.canonicalTarget) ? cwd.canonicalTarget.replace(/\\/gu, "/").toLowerCase() : cwd.canonicalTarget })).digest("hex");
  return { schemaVersion: 1, canonicalTarget: target.canonicalTarget, canonicalWorkspace: target.canonicalWorkspace, scope: "file", operation: "write", commandDigest };
}

/** 把私有目标转成可识别而不含绝对目录的审批标签。 */
export function externalExecutionTargetLabel(target: ExternalExecutionTarget): string {
  return `${path.basename(target.canonicalTarget)} [外部文件:${computeExternalExecutionConstraint("run_command", target).slice(-12)}]`;
}

/** 真实批准后签发新对象；同一 grant 的两调用也不会共享 executionId 或能力对象。 */
export function issueExternalWriteCapability(input: { target: ExternalExecutionTarget; toolName: string; callId: string; inputHash: string; authorization: ExternalExecutionAuthorization }): ExternalWriteCapability {
  if (!approvedAuthorizations.has(input.authorization) || !input.authorization.sessionId || input.authorization.canonicalWorkspace !== input.target.canonicalWorkspace) throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "执行权威端口返回的对象不是 Core 真实授权");
  const constraint = computeExternalExecutionConstraint(input.toolName, input.target);
  const executionId = randomUUID();
  const capability = Object.freeze({ schemaVersion: 1 as const, target: Object.freeze({ ...input.target }), toolName: input.toolName, callId: input.callId, normalizedInputHash: input.inputHash, ...input.authorization, executionId, constraint, capabilityDigest: createHash("sha256").update(JSON.stringify({ constraint, executionId, callId: input.callId, inputHash: input.inputHash, ...input.authorization })).digest("hex") });
  issuedCapabilities.add(capability);
  return capability;
}

/** 工具执行前重解析并一次认领能力；复制对象/直接调用/链接变化均不能扩根。 */
export async function claimExternalWriteCapability(toolName: string, input: unknown, context: ToolExecutionContext): Promise<void> {
  const target = await resolveExternalExecutionTarget(context.workspaceRoot, input);
  const capability = context.sandboxPolicy?.policy.externalWriteCapability;
  if (!target && !capability) return;
  if (!target || !capability || !issuedCapabilities.has(capability) || claimedCapabilities.has(capability) || context.executionSessionId !== capability.sessionId || context.toolCallId !== capability.callId || toolName !== capability.toolName || hashNormalizedToolInput(input) !== capability.normalizedInputHash || computeExternalExecutionConstraint(toolName, target) !== capability.constraint || (capability.expiresAt !== undefined && Date.parse(capability.expiresAt) <= Date.now())) throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "外部执行能力缺失、已消费或目标身份改变");
  if (context.sandboxPolicy?.policy.mode === "read-only") throw createToolError("SANDBOX_POLICY_DENIED", "只读沙箱不接受外部写能力");
  claimedCapabilities.add(capability);
}

/** JobService直入仍须持有工具已认领的同调用能力，不能重用、复制或改变完整输入。 */
export async function assertExternalJobDispatch(input: unknown, context: ToolExecutionContext): Promise<void> {
  const target = await resolveExternalExecutionTarget(context.workspaceRoot, input);
  const capability = context.sandboxPolicy?.policy.externalWriteCapability;
  if (!target && !capability) return;
  if (!target || !capability || !issuedCapabilities.has(capability) || !claimedCapabilities.has(capability) || dispatchedCapabilities.has(capability) || context.executionSessionId !== capability.sessionId || capability.toolName !== "start_background_job" || context.toolCallId !== capability.callId || hashNormalizedToolInput(input) !== capability.normalizedInputHash || computeExternalExecutionConstraint("start_background_job", target) !== capability.constraint || context.sandboxPolicy?.policy.mode === "read-only" || (capability.expiresAt !== undefined && Date.parse(capability.expiresAt) <= Date.now())) throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "后台执行能力未认领、已分派或输入已改变");
  dispatchedCapabilities.add(capability);
}
