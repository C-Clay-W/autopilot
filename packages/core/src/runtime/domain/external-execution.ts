/** 单目标外部执行权限的私有身份、冻结记录和能力；canonical 数据仅存 Core 授权状态。 */
import { createHash } from "node:crypto";

export const EXTERNAL_EXECUTION_CONSTRAINT_PREFIX = "ext-exec-file:v1:";

/** Core 预检后的精确文件身份；不进入公开审批/通用工具结果。 */
export interface ExternalExecutionTarget {
  schemaVersion: 1;
  canonicalTarget: string;
  canonicalWorkspace: string;
  scope: "file";
  operation: "write";
  commandDigest: string;
}

/** 与现有 decisions 存储并列记录的私有待审批事实，不是批准。 */
export interface ExternalExecutionApproval {
  recordType: "external_execution_request";
  sessionId: string;
  turnId: string;
  approvalId: string;
  callId: string;
  toolName: string;
  normalizedInputHash: string;
  constraint: string;
  expiresAt: string;
  target: ExternalExecutionTarget;
}

/** 真实授权范围；每次获准调用仍签发独立执行域。 */
export interface ExternalExecutionAuthorization {
  lifetime: "allow_once" | "allow_session" | "allow_workspace";
  sessionId: string;
  canonicalWorkspace: string;
  approvalId?: string;
  expiresAt?: string;
}

/** 仅由 Core 签发的每调用能力；Adapter 没有精确文件保证时必须拒绝。 */
export interface ExternalWriteCapability extends ExternalExecutionAuthorization {
  schemaVersion: 1;
  target: ExternalExecutionTarget;
  toolName: string;
  callId: string;
  normalizedInputHash: string;
  executionId: string;
  constraint: string;
  capabilityDigest: string;
}

/** Windows 身份比较忽略大小写和分隔符差异，POSIX 保留大小写；导出供精确命令约束复用同一规则。 */
export function comparablePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 哈希固定字段结构，不把目标路径写进公开约束。 */
export function computeExternalExecutionConstraint(toolName: string, target: ExternalExecutionTarget): string {
  return EXTERNAL_EXECUTION_CONSTRAINT_PREFIX + createHash("sha256").update(JSON.stringify({ toolName, schemaVersion: target.schemaVersion, workspace: comparablePath(target.canonicalWorkspace), target: comparablePath(target.canonicalTarget), scope: target.scope, operation: target.operation, commandDigest: target.commandDigest })).digest("hex");
}

/** 新约束必须显式识别；未知版本也不能落回旧非外部授权分支。 */
export function isExternalExecutionConstraint(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("ext-exec-file");
}

/** 校验私有目标版本与约束绑定，旧数据及伪造主体均不升级。 */
export function matchesExternalExecutionTarget(toolName: string, constraint: string, target: ExternalExecutionTarget | undefined): boolean {
  return (toolName === "run_command" || toolName === "start_background_job") && !!target
    && target.schemaVersion === 1 && target.scope === "file" && target.operation === "write"
    && typeof target.canonicalTarget === "string" && typeof target.canonicalWorkspace === "string"
    && /^[a-f0-9]{64}$/u.test(target.commandDigest)
    && constraint === computeExternalExecutionConstraint(toolName, target);
}
