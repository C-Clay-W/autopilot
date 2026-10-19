/**
 * 命令策略：按结构化 argv 前缀匹配，合并结果时始终采用最严格的权限决定。
 * 同时提供工作区内精确命令约束：持久授权"记住此命令"必须绑定完整命令身份，
 * 不再使用 program: 宽约束（该约束无法区分参数与工作目录，已被停用）。
 */
import { createHash } from "node:crypto";
import type { CommandRisk, ToolPermissionDecision } from "../types";
import { comparablePath } from "../../../runtime/domain/external-execution";

export interface CommandRule {
  pattern: string[];
  decision: ToolPermissionDecision;
  risk: CommandRisk;
  reason: string;
}

export interface CommandPolicyResult {
  decision: ToolPermissionDecision;
  risk: CommandRisk;
  reason: string;
}

const decisionWeight: Record<ToolPermissionDecision, number> = { allow: 0, approval_required: 1, deny: 2 };

export const defaultCommandRules: CommandRule[] = [
  { pattern: ["pwd"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["rg"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "status"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "diff"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "log"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["mkdir"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["touch"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["git", "add"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["curl"], decision: "approval_required", risk: "external_side_effect", reason: "网络命令必须人工审批" },
  { pattern: ["wget"], decision: "approval_required", risk: "external_side_effect", reason: "网络命令必须人工审批" },
  { pattern: ["npm", "install"], decision: "approval_required", risk: "external_side_effect", reason: "依赖安装可能访问网络并修改工作区" },
  { pattern: ["rm"], decision: "deny", risk: "destructive", reason: "禁止递归删除命令" },
  { pattern: ["del"], decision: "deny", risk: "destructive", reason: "禁止删除命令" },
  { pattern: ["rmdir"], decision: "deny", risk: "destructive", reason: "禁止删除目录命令" },
  { pattern: ["git", "clean"], decision: "deny", risk: "destructive", reason: "禁止清理未跟踪文件" },
  { pattern: ["git", "reset", "--hard"], decision: "deny", risk: "destructive", reason: "禁止丢弃工作区修改" },
  { pattern: ["format"], decision: "deny", risk: "destructive", reason: "禁止格式化磁盘" },
  { pattern: ["shutdown"], decision: "deny", risk: "destructive", reason: "禁止关机或重启" },
];

/**
 * 将 Windows 的 .cmd 可执行名归一到稳定逻辑名，**仅供风险分类与展示**。
 * 本折叠不参与授权身份：POSIX 上删除后缀或折叠大小写会把不同可执行文件合并为同一授权身份
 * （CR 20261016 R6），授权身份见 resolveCommandAuthorizationIdentity。
 */
export function normalizeProgramName(program: string): string {
  return program.trim().replace(/\.(cmd|exe)$/i, "").toLowerCase();
}

/** 判断规则前缀是否完整匹配 argv，不使用字符串 startsWith 防止近似命令搭便车。 */
function matchesRule(argv: string[], pattern: string[]): boolean {
  return pattern.length <= argv.length && pattern.every((part, index) => argv[index] === part);
}

/** 判断参数是否试图通过绝对路径、父目录或 UNC 路径访问工作区外内容。 */
function hasOutsideWorkspacePath(args: string[]): boolean {
  return args.some(function isOutsideWorkspacePath(argument) {
    return argument === ".." || argument.startsWith("../") || argument.startsWith("..\\")
      || argument.startsWith("/") || argument.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(argument);
  });
}

/** 按最严格规则返回命令决定；工作区外路径和未知命令一律归类为 unknown。 */
export function decideCommandPermission(program: string, args: string[], rules: CommandRule[] = defaultCommandRules): CommandPolicyResult {
  const argv = [normalizeProgramName(program), ...args];
  const matched = rules.filter((rule) => matchesRule(argv, rule.pattern.map((part) => part.toLowerCase())));
  if (matched.length === 0) return { decision: "approval_required", risk: "unknown", reason: "命令不在已识别的风险分类中" };
  const strictest = matched.reduce((current, rule) => decisionWeight[rule.decision] > decisionWeight[current.decision] ? rule : current);
  if (strictest.decision === "deny") return strictest;
  if (hasOutsideWorkspacePath(args)) return { decision: "approval_required", risk: "unknown", reason: "命令参数可能访问工作区外路径，必须人工审批" };
  return strictest;
}

/**
 * 授权身份的程序表示：只用于精确命令约束（"记住此命令"），不用于风险分类。
 * Windows：CreateProcess 按 PATHEXT 解析且卷大小写不敏感，npm ≡ npm.cmd ≡ NPM.EXE，且
 * getPlatformExecutable(npm) → npm.cmd 属同一等价解析，故仍折叠后缀与大小写，保持单一稳定身份。
 * POSIX：实际 spawn 不删除后缀，扩展名与大小写都是文件身份的一部分，一律原样保留 ——
 * 使 /w/bin/check、/w/bin/check.exe、/w/bin/Check 互不复用同一持久授权（CR 20261016 R6）。
 */
export function resolveCommandAuthorizationIdentity(program: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = program.trim();
  if (platform !== "win32") return trimmed;
  return comparablePath(trimmed).replace(/\.(cmd|exe)$/i, "").toLowerCase();
}

/** 工作区内精确命令约束的当前版本前缀；身份算法变更必须升版本，避免旧碰撞授权继续命中。 */
export const WORKSPACE_COMMAND_CONSTRAINT_PREFIX = "cmd:v2:";

/** v1 前缀：身份会合并 POSIX 上不同的可执行文件，已停止签发，仅保留对历史约束的类型识别。 */
export const LEGACY_WORKSPACE_COMMAND_CONSTRAINT_PREFIX = "cmd:v1:";

/**
 * 计算工作区内精确命令约束：绑定 canonical 工作区、canonical 工作目录、平台、
 * 平台解析后的程序身份与完整结构化 argv。
 * 哈希前不落盘任何路径原文（与外部执行约束同一 comparablePath 规则）；
 * 约束只描述身份，放行决策仍归 PolicyEngine 与 Sandbox 门禁。
 */
export function computeWorkspaceCommandConstraint(input: { workspaceRoot: string; cwd: string; program: string; args: string[]; platform?: NodeJS.Platform }): string {
  const platform = input.platform ?? process.platform;
  return WORKSPACE_COMMAND_CONSTRAINT_PREFIX + createHash("sha256").update(JSON.stringify({
    workspace: comparablePath(input.workspaceRoot),
    cwd: comparablePath(input.cwd),
    platform,
    program: resolveCommandAuthorizationIdentity(input.program, platform),
    args: input.args,
  })).digest("hex");
}

/**
 * 显式识别精确命令约束（当前版本与遗留 v1）；旧 program: 宽约束与外部执行约束均不匹配。
 * v1 仅做类型识别，用于保留历史/已恢复审批的决策范围；签发侧只产出当前版本，
 * 因此旧的正碰撞 grant 永远无法命中新身份。
 */
export function isWorkspaceCommandConstraint(value: string | undefined): boolean {
  return typeof value === "string"
    && (value.startsWith(WORKSPACE_COMMAND_CONSTRAINT_PREFIX) || value.startsWith(LEGACY_WORKSPACE_COMMAND_CONSTRAINT_PREFIX));
}
