/**
 * runtime/domain/external-permissions.ts — 外部文件修改授权的规则与约束（Talk-Plan1013 Stage 2）
 *
 * 约束（grant 侧）由 Stage 1 的文件工具生成：`ext-file:<canonicalTarget>`。
 * 规则（settings 投影侧）使用 `Write|Edit(<canonicalTarget>)` 语法，仅精确路径或末尾 `/**` 递归。
 * 本模块只做纯语法与覆盖判定，不产生任何放行：授权判定一律以 grant 为准，
 * 投影规则仅用于 allow_workspace 双边一致性校验与 deny 收窄（Plan 16.4）。
 */

/** Stage 1 文件工具外部修改约束前缀；grant.constraint 与 settings 投影据此识别外部授权。 */
export const EXTERNAL_FILE_CONSTRAINT_PREFIX = "ext-file:";

/** 外部规则的操作标签；read 不产生外部授权。 */
export type ExternalFileOperation = "Read" | "Write" | "Edit";

/** 解析后的外部权限规则。 */
export interface ParsedExternalPermissionRule {
  operation: ExternalFileOperation;
  /** 规则目标：canonical 绝对路径；recursive 时不含末尾 `/**`。 */
  target: string;
  /** 是否为末尾 `/**` 的目录递归规则。 */
  recursive: boolean;
}

/** 判断约束是否为 Stage 1 外部文件修改约束。 */
export function isExternalFileConstraint(constraint: string | undefined): boolean {
  return typeof constraint === "string" && constraint.startsWith(EXTERNAL_FILE_CONSTRAINT_PREFIX);
}

/** 提取外部约束的 canonical 目标；非外部约束返回 undefined。 */
export function externalFileConstraintTarget(constraint: string | undefined): string | undefined {
  return isExternalFileConstraint(constraint) ? constraint!.slice(EXTERNAL_FILE_CONSTRAINT_PREFIX.length) : undefined;
}

/** 由外部约束构造投影规则字符串；write_file→Write、edit_file→Edit、read_file/glob_files/grep_files→Read，其他工具不产生外部规则。 */
export function formatExternalFileRule(toolName: string, constraint: string): string {
  const target = externalFileConstraintTarget(constraint);
  if (!target) throw new Error(`EXTERNAL_CONSTRAINT_INVALID:${constraint}`);
  const operation = toolName === "write_file" ? "Write" : toolName === "edit_file" ? "Edit" : toolName === "read_file" || toolName === "glob_files" || toolName === "grep_files" ? "Read" : undefined;
  if (!operation) throw new Error(`EXTERNAL_RULE_TOOL_UNSUPPORTED:${toolName}`);
  return `${operation}(${target})`;
}

/**
 * Talk-Plan1013 Stage5 R2：外部文件审批的私有冻结记录。
 * 与 external_execution_request 并列存放于同一 decisions.jsonl，用独立 recordType 区分；
 * 只冻结可验证身份（constraint/callId/inputHash）与 TTL，本身不是批准。
 */
export interface ExternalFileApproval {
  recordType: "external_file_request";
  sessionId: string;
  turnId: string;
  approvalId: string;
  callId: string;
  toolName: string;
  normalizedInputHash: string;
  constraint: string;
  expiresAt: string;
}

/** 归一化路径用于比较：统一正斜杠；Windows 盘符路径大小写不敏感。 */
export function normalizeComparablePath(target: string): string {
  const unified = target.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** 解析外部权限规则；非法语法返回 null（永不退化为裸工具 allow）。 */
export function parseExternalPermissionRule(rule: string): ParsedExternalPermissionRule | null {
  const match = /^(Read|Write|Edit)\((.+)\)$/.exec(rule);
  if (!match) return null;
  const target = match[2]!;
  if (!target || target.includes("\0") || target.includes("\n")) return null;
  // 目录递归规则以 /** 或 \** 结尾（canonical 目标保留原生分隔符）；路径主体必须是绝对路径（win32 盘符或 posix 根）。
  const recursive = target.endsWith("/**") || target.endsWith("\\**");
  const pathPart = recursive ? target.slice(0, -3) : target;
  if (!pathPart || /^(\\\\|\/\/)/.test(pathPart)) return null;
  if (!(/^([a-zA-Z]:[\\/])/.test(pathPart) || pathPart.startsWith("/"))) return null;
  if (/^([a-zA-Z]:[\\/])/.test(pathPart) && /:/.test(pathPart.slice(2))) return null;
  return { operation: match[1] as ExternalFileOperation, target: pathPart, recursive };
}

/** 校验规则语法；供 settings 解析与投影写入前把关。 */
export function isValidExternalPermissionRule(rule: string): boolean {
  return parseExternalPermissionRule(rule) !== null;
}

/** 判断 deny 规则是否覆盖（收窄）grant 规则：同操作且目标相等，或 deny 为递归目录且包含 grant 目标。 */
export function externalRuleCoversRule(denyRule: string, grantRule: string): boolean {
  const deny = parseExternalPermissionRule(denyRule);
  const grant = parseExternalPermissionRule(grantRule);
  if (!deny || !grant || deny.operation !== grant.operation) return false;
  const denyTarget = normalizeComparablePath(deny.target);
  const grantTarget = normalizeComparablePath(grant.target);
  if (denyTarget === grantTarget) return true;
  return deny.recursive && grantTarget.startsWith(`${denyTarget}/`);
}

/**
 * Talk-Plan1013 Stage5 R6：外部权限快照的最小形状。
 * 投影器 read 与本地 settings 读取均归约为该形状；快照来源唯一为 projector 入口。
 */
export interface ExternalRestrictionSnapshot {
  allow: readonly string[];
  deny: readonly string[];
  ask?: readonly string[];
  /** deny/ask 无法完整解释时置位：任何外部目标按 deny 处理，不能只警告后放行。 */
  restricted?: boolean;
}

/**
 * Talk-Plan1013 Stage5 R6：由权限快照判定外部目标当前限制（deny 并集优先、ask 次之、其余 allow）。
 * 纯函数，规则匹配逻辑唯一；ApprovalService（resolveExternalRestriction）与 UndoService
 * （恢复写入前门）共用同一判定，不写第二套匹配器。非外部约束按 allow（无已知限制）。
 */
export function classifyExternalRestriction(snapshot: ExternalRestrictionSnapshot, toolName: string, constraint: string): "allow" | "ask" | "deny" {
  if (!isExternalFileConstraint(constraint)) return "allow";
  // 快照无法完整解释时无法证明收窄范围，直接按 deny 处理（fail-closed）。
  if (snapshot.restricted === true) return "deny";
  const rule = formatExternalFileRule(toolName, constraint);
  if (snapshot.deny.some(function denied(restriction) { return externalRuleCoversRule(restriction, rule); })) return "deny";
  if ((snapshot.ask ?? []).some(function asked(restriction) { return externalRuleCoversRule(restriction, rule); })) return "ask";
  return "allow";
}
