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
  requireSingleApproval?: true;
}

export interface CommandPolicyResult {
  decision: ToolPermissionDecision;
  risk: CommandRisk;
  reason: string;
  requireSingleApproval?: true;
}

const decisionWeight: Record<ToolPermissionDecision, number> = { allow: 0, approval_required: 1, deny: 2 };

export const defaultCommandRules: CommandRule[] = [
  { pattern: ["pwd"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["rg"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "status"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "diff"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "log"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "blame"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "show"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "ls-files"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["git", "rev-parse"], decision: "approval_required", risk: "read_only", reason: "已识别为工作区内只读命令" },
  { pattern: ["mkdir"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["touch"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["git", "add"], decision: "approval_required", risk: "workspace_mutating", reason: "已识别为工作区变更命令" },
  { pattern: ["git", "restore"], decision: "approval_required", risk: "destructive", reason: "恢复文件可能丢弃已有修改，需要单次确认" },
  { pattern: ["git", "reset"], decision: "approval_required", risk: "destructive", reason: "重置索引或历史需要单次确认" },
  { pattern: ["git", "rebase"], decision: "approval_required", risk: "destructive", reason: "重写提交历史需要单次确认" },
  { pattern: ["git", "commit", "--amend"], decision: "approval_required", risk: "destructive", reason: "改写已有提交需要单次确认" },
  { pattern: ["git", "push"], decision: "approval_required", risk: "external_side_effect", reason: "Git push 需要单次确认", requireSingleApproval: true },
  { pattern: ["npm", "publish"], decision: "approval_required", risk: "external_side_effect", reason: "发布软件包需要单次确认", requireSingleApproval: true },
  { pattern: ["curl"], decision: "approval_required", risk: "external_side_effect", reason: "网络命令必须人工审批", requireSingleApproval: true },
  { pattern: ["wget"], decision: "approval_required", risk: "external_side_effect", reason: "网络命令必须人工审批", requireSingleApproval: true },
  { pattern: ["npm", "install"], decision: "approval_required", risk: "external_side_effect", reason: "依赖安装可能访问网络并执行生命周期脚本", requireSingleApproval: true },
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
  if (pattern.length === 3 && pattern[2].startsWith("--")) {
    return argv[0] === pattern[0] && argv[1] === pattern[1] && argv.slice(2).includes(pattern[2]);
  }
  return pattern.length <= argv.length && pattern.every((part, index) => argv[index] === part);
}

/** 判断参数是否试图通过绝对路径、父目录或 UNC 路径访问工作区外内容。 */
function hasOutsideWorkspacePath(args: string[]): boolean {
  return args.some(function isOutsideWorkspacePath(argument) {
    const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
    return value.split(/[\\/]/).includes("..") || value.startsWith("/") || value.startsWith("\\\\") || /^[a-z]:/i.test(value);
  });
}

/** Git 全局选项可夹在程序与子命令之间，保护检查仍按实际子命令判定。 */
function protectedGitCommand(args: string[]): CommandPolicyResult | undefined {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    index += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"].includes(args[index]) ? 2 : 1;
  }
  const [command, ...input] = args.slice(index);
  const options = input.slice(0, input.includes("--") ? input.indexOf("--") : undefined);
  if (command === "push") return { decision: "approval_required", risk: "external_side_effect", reason: "Git push 需要单次确认", requireSingleApproval: true };
  if (command === "clean" || command === "reset" && options.includes("--hard")) {
    return { decision: "deny", risk: "destructive", reason: "禁止清理未跟踪文件或丢弃工作区修改" };
  }
  if (["rm", "reset", "restore", "rebase"].includes(command)
      || ["branch", "tag", "update-ref", "symbolic-ref"].includes(command) && options.some(function deletion(option) { return ["--delete", "--force", "--move", "-D", "-d", "-m", "-M", "-f"].includes(option); })
      || ["worktree", "remote", "notes", "stash", "reflog"].includes(command) && options.some(function removal(option) { return ["remove", "rm", "prune", "drop", "clear", "delete", "expire"].includes(option); })
      || ["checkout", "switch"].includes(command) && options.some(function discard(option) { return ["--force", "--discard-changes", "-f"].includes(option); })
      || command === "commit" && options.includes("--amend")) {
    return { decision: "approval_required", risk: "destructive", reason: "Git 删除或丢弃已有修改需要单次确认" };
  }
}

/** 按最严格规则返回命令决定；工作区外路径和未知命令一律归类为 unknown。 */
export function decideCommandPermission(program: string, args: string[], rules: CommandRule[] = defaultCommandRules): CommandPolicyResult {
  const argv = [normalizeProgramName(program), ...args];
  // 仅豁免内置 clean 拒绝规则；自定义 deny 仍保留，-- 后的 -n 是路径而非 dry-run。
  const cleanOptions = args.slice(1, args.indexOf("--") < 0 ? undefined : args.indexOf("--"));
  const dryRunClean = argv[0] === "git" && args[0] === "clean"
    && cleanOptions.some(function dryRun(option) { return option === "--dry-run" || /^-[ndqxfX]+$/.test(option) && option.includes("n"); })
    && cleanOptions.every(function safeOption(option) { return option === "--dry-run" || /^-[ndqxfX]+$/.test(option); });
  const matched = rules.filter(function matchCommandRule(rule) {
    return !(dryRunClean && rule === defaultCommandRules.find(function cleanRule(candidate) { return candidate.pattern.join(" ") === "git clean"; }))
      && matchesRule(argv, rule.pattern.map(function lower(part) { return part.toLowerCase(); }));
  });
  if (dryRunClean) matched.push({ pattern: ["git", "clean"], decision: "approval_required", risk: "read_only", reason: "git clean dry-run 仅预览未跟踪文件，不执行删除" });
  // 只有明确的列出形式可绕过常规审批，分支创建与未知变体仍走确认。
  if (argv[0] === "git" && args[0] === "branch" && args.slice(1).every(function listOption(arg) { return ["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current"].includes(arg); })) {
    matched.push({ pattern: ["git", "branch"], decision: "approval_required", risk: "read_only", reason: "已识别为只读分支查询" });
  }
  const denied = matched.find(function deny(rule) { return rule.decision === "deny"; });
  if (denied) return denied;
  const basename = normalizeProgramName(program.split(/[\\/]/).at(-1) ?? program).toLowerCase();
  const gitProtection = basename === "git" && !dryRunClean ? protectedGitCommand(args) : undefined;
  if (gitProtection) return gitProtection;
  if (["rm", "del", "rmdir", "format", "shutdown"].includes(basename)) {
    return { decision: "deny", risk: "destructive", reason: "禁止直接执行破坏性系统命令" };
  }
  // 只识别无配置加载、单一字面相对文件名的删除；不解释任意 PowerShell 脚本或扩展执行范围。
  const literalDeletion = (argv[0] === "powershell" || argv[0] === "pwsh")
    && args.length === 4
    && args.slice(0, 3).join(" ").toLowerCase() === "-noprofile -noninteractive -command"
    && /^Remove-Item -LiteralPath '[A-Za-z0-9_][A-Za-z0-9_. -]*' -ErrorAction Stop$/i.test(args[3]);
  if (literalDeletion && !matched.some(function deniesDeletion(rule) { return rule.decision === "deny"; })) {
    return { decision: "approval_required", risk: "destructive", reason: "删除当前工作目录中的单一字面文件，需要单次确认" };
  }
  if (matched.length === 0) return { decision: "approval_required", risk: "unknown", reason: "命令不在已识别的风险分类中" };
  const strictest = matched.reduce((current, rule) => decisionWeight[rule.decision] > decisionWeight[current.decision] ? rule : current);
  if (strictest.decision === "deny") return strictest;
  if (strictest.risk === "destructive" || strictest.risk === "external_side_effect") return strictest;
  if (args.some(function expandsCommandEffects(argument) { return /^--(?:pre|ext-diff|textconv|output|exec|exec-path)(?:=|$)/.test(argument) || argv[0] === "rg" && /^-r(?:.+)?$/.test(argument); })) {
    return { decision: "approval_required", risk: "unknown", reason: "命令选项可能执行其他程序或写入文件，需重新确认风险" };
  }
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
