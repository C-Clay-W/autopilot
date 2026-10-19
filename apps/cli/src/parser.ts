/**
 * CLI argv 与 slash command 的最小确定性 parser。
 *
 * parser 只做语法、选项归属和局部值校验，不创建 Runtime、不读取工作区，
 * 也不会把未知命令静默转换为普通模型 prompt。
 */

import type {
  CliAction,
  CliActionParseResult,
  CliCommand,
  CliHostOptions,
  CliInvocation,
  CliOutputFormat,
  CliParseResult,
  CliSlashCommand,
} from "./types.js";

/** 交互 TTY 可用的 slash 命令目录；只列出 parser 已真正支持的命令。 */
export const CLI_SLASH_COMMANDS: readonly CliSlashCommand[] = [
  { name: "/exit", usage: "/exit", description: "退出当前 CLI 会话" },
  { name: "/cancel", usage: "/cancel", description: "取消正在运行的 Turn" },
  { name: "/queue", usage: "/queue <prompt>", description: "把下一条 prompt 排队" },
  { name: "/compact", usage: "/compact", description: "压缩当前 Turn 上下文" },
  { name: "/context", usage: "/context [all]", description: "查看当前上下文用量（all 展开完整细节）" },
  { name: "/jobs", usage: "/jobs [show|output|stop <id>]", description: "管理当前 Session 的后台任务" },
  { name: "/model", usage: "/model", description: "查看或设置下一个 Turn 的模型" },
  { name: "/effort", usage: "/effort", description: "查看或设置下一个 Turn 的推理强度" },
  { name: "/skill", usage: "/skill [name]", description: "打开 Skill picker 或选择 Skill" },
  { name: "/permissions", usage: "/permissions [mode | grants | revoke <constraint>]", description: "查看/设置权限模式，或查看与撤销持久授权" },
  { name: "/approve", usage: "/approve <decision>", description: "提交当前工具审批决定" },
  { name: "/undo", usage: "/undo [confirm]", description: "预览并确认撤销当前会话最近一轮文件修改" },
];

/** 返回当前 prompt 可用的 slash 命令建议；只有输入 `/` 或命令前缀时打开。 */
export function getSlashCommandSuggestions(input: string): CliSlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || /\s/u.test(trimmed)) return [];
  const query = trimmed.toLocaleLowerCase();
  return CLI_SLASH_COMMANDS.filter(function matchSlashCommand(command) {
    return command.name.startsWith(query);
  });
}

/** 返回稳定的 CLI 帮助文本。 */
export function renderHelp(): string {
  return [
    "Usage:",
    "  autopilot                     enter interactive chat (bare command, current directory)",
    "  autopilot project open [path] [--workspace-root <path>] [--state-root <path>]",
    "  autopilot project list | current | remove <workspaceId>",
    "  autopilot session list | rename <id> <title> | delete <id> --yes",
    "  autopilot trust status | revoke",
    "  autopilot config show|get|set ... --scope user|project|local",
    "  autopilot mcp list | approve <server> [--yes] | revoke <server>",
    "  autopilot job list | show <id> | output <id> | kill <id>",
    "  autopilot undo --session <id> --yes",
    "  autopilot doctor [--connectivity]",
    "  autopilot sandbox status | setup --yes",
    "  autopilot chat [prompt] [--session <id>] [--output interactive|text|jsonl]",
    "  autopilot resume [--session <id>] [--output interactive|text|jsonl]",
    "",
    "Options:",
    "  --workspace-root <path>  canonical Agent workspace root",
    "  --state-root <path>      explicit durable Runtime state root (default: stable workspace identity)",
    "  --trust-root <path>      explicit trust record root",
    "  -h, --help               show this help",
    "",
    "Permissions: ask requires confirmation; auto_approve only auto-runs safe writes and workspace commands after Trust; full_access still enforces path, schema, and destructive-command guards.",
    "Limits: settings.json maxTurns, AGENT_MAX_STEPS and AGENT_MAX_DURATION_MS are optional (unset means no step/time cap); maxTurns maps to per-run steps without a fixed platform cap; AGENT_MAX_TOOL_RETRIES defaults to 5 and is capped at 10.",
    "Exit codes: 0 success/normal exit, 1 runtime error, 2 usage error, 130 SIGINT, 143 SIGTERM.",
    "Interactive uses Ink on a TTY and Plain fallback otherwise; --output jsonl never emits ANSI or prompts.",
  ].join("\n");
}

/** 读取需要值的 argv 选项；缺失值统一返回 usage error。 */
function readOptionValue(argv: readonly string[], index: number, option: string): { value?: string; nextIndex: number; error?: string } {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    return { nextIndex: index, error: `选项 ${option} 需要一个值` };
  }
  return { value, nextIndex: index + 1 };
}

/** 将输出模式解析为固定联合类型。 */
function parseOutputFormat(value: string): CliOutputFormat | undefined {
  if (value === "interactive" || value === "text" || value === "jsonl") return value;
  return undefined;
}

/** 解析 argv；不触碰 Runtime 或文件系统。 */
export function parseArgv(argv: readonly string[]): CliParseResult {
  if (argv.length === 0) {
    const command: CliCommand = { type: "chat", output: "interactive" };
    return { kind: "command", invocation: createInvocation(command, {}) };
  }

  let commandName: string | undefined;
  let subcommand: string | undefined;
  let output: CliOutputFormat = "interactive";
  let sessionId: string | undefined;
  let scope: "user" | "project" | "local" | undefined;
  let yes = false;
  let connectivity = false;
  const positional: string[] = [];
  const host: CliHostOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") return { kind: "help", text: renderHelp() };

    if (token === "--jsonl") {
      output = "jsonl";
      continue;
    }

    if (token === "--yes") {
      yes = true;
      continue;
    }

    if (token === "--connectivity") {
      connectivity = true;
      continue;
    }

    if (token === "--state-root" || token === "--trust-root" || token === "--workspace-root" || token === "--session" || token === "--output" || token === "--scope") {
      const option = readOptionValue(argv, index, token);
      if (option.error || !option.value) return { kind: "error", message: option.error ?? `选项 ${token} 需要一个值` };
      index = option.nextIndex;
      if (token === "--state-root") host.stateRoot = option.value;
      else if (token === "--trust-root") host.trustRoot = option.value;
      else if (token === "--workspace-root") host.workspaceRoot = option.value;
      else if (token === "--session") sessionId = option.value;
      else if (token === "--scope") {
        if (option.value !== "user" && option.value !== "project" && option.value !== "local") return { kind: "error", message: `--scope 不支持值 ${option.value}` };
        scope = option.value;
      }
      else {
        const parsedOutput = parseOutputFormat(option.value);
        if (!parsedOutput) return { kind: "error", message: `--output 不支持值 ${option.value}` };
        output = parsedOutput;
      }
      continue;
    }

    if (token === "-s") {
      const option = readOptionValue(argv, index, "-s");
      if (option.error || !option.value) return { kind: "error", message: option.error ?? "选项 -s 需要一个值" };
      index = option.nextIndex;
      sessionId = option.value;
      continue;
    }

    if (token.startsWith("-")) return { kind: "error", message: `未知选项 ${token}` };

    if (!commandName) {
      commandName = token;
      continue;
    }

    if ((commandName === "project" || commandName === "session" || commandName === "trust" || commandName === "config" || commandName === "mcp" || commandName === "job" || commandName === "sandbox") && !subcommand) {
      subcommand = token;
      continue;
    }

    positional.push(token);
  }

  if (commandName === "project") {
    if (subcommand === "open") {
      if (sessionId || output !== "interactive" || scope || yes || connectivity) return { kind: "error", message: "project open 不接受当前选项" };
      if (positional.length > 1) return { kind: "error", message: "project open 最多接受一个 path" };
      const command: CliCommand = { type: "project_open", path: positional[0] };
      return { kind: "command", invocation: createInvocation(command, host) };
    }
    if (subcommand === "list" && positional.length === 0 && !sessionId && output === "interactive" && !scope && !yes && !connectivity) return { kind: "command", invocation: createInvocation({ type: "project_list" }, host) };
    if (subcommand === "current" && positional.length === 0 && !sessionId && output === "interactive" && !scope && !yes && !connectivity) return { kind: "command", invocation: createInvocation({ type: "project_current" }, host) };
    if (subcommand === "remove" && positional.length === 1 && !sessionId && output === "interactive" && !scope && !yes && !connectivity) return { kind: "command", invocation: createInvocation({ type: "project_remove", workspaceId: positional[0] }, host) };
    return { kind: "error", message: "project 支持 open|list|current|remove，且参数或选项不合法" };
  }

  if (commandName === "session") {
    if (sessionId || output !== "interactive" || scope || connectivity) return { kind: "error", message: "session 不接受聊天、scope 或 connectivity 选项" };
    if (subcommand === "list" && positional.length === 0 && !yes) return { kind: "command", invocation: createInvocation({ type: "session_list" }, host) };
    if (subcommand === "rename" && positional.length >= 2 && !yes) return { kind: "command", invocation: createInvocation({ type: "session_rename", sessionId: positional[0], title: positional.slice(1).join(" ") }, host) };
    if (subcommand === "delete" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "session_delete", sessionId: positional[0], yes }, host) };
    return { kind: "error", message: "session 支持 list|rename <id> <title>|delete <id> --yes" };
  }

  if (commandName === "trust") {
    if (positional.length !== 0 || sessionId || output !== "interactive" || scope || yes || connectivity) return { kind: "error", message: "trust 参数或选项不合法" };
    if (subcommand === "status") return { kind: "command", invocation: createInvocation({ type: "trust_status" }, host) };
    if (subcommand === "revoke") return { kind: "command", invocation: createInvocation({ type: "trust_revoke" }, host) };
    return { kind: "error", message: "trust 支持 status|revoke" };
  }

  if (commandName === "config") {
    if (!scope) return { kind: "error", message: "config 必须显式提供 --scope user|project|local" };
    if (sessionId || output !== "interactive" || yes || connectivity) return { kind: "error", message: "config 不接受聊天或确认选项" };
    if (subcommand === "show" && positional.length === 0) return { kind: "command", invocation: createInvocation({ type: "config_show", scope }, host) };
    if (subcommand === "get" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "config_get", scope, key: positional[0] }, host) };
    if (subcommand === "set" && positional.length === 2) return { kind: "command", invocation: createInvocation({ type: "config_set", scope, key: positional[0], value: positional[1] }, host) };
    return { kind: "error", message: "config 支持 show|get <key>|set <key> <value>，且必须显式 --scope" };
  }

  if (commandName === "mcp") {
    if (sessionId || output !== "interactive" || scope || connectivity) return { kind: "error", message: "mcp 不接受聊天、scope 或 connectivity 选项" };
    if (subcommand === "list" && positional.length === 0 && !yes) return { kind: "command", invocation: createInvocation({ type: "mcp_list" }, host) };
    if (subcommand === "approve" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "mcp_approve", serverName: positional[0], yes }, host) };
    if (subcommand === "revoke" && positional.length === 1 && !yes) return { kind: "command", invocation: createInvocation({ type: "mcp_revoke", serverName: positional[0] }, host) };
    return { kind: "error", message: "mcp 支持 list|approve <server> [--yes]|revoke <server>" };
  }

  if (commandName === "job") {
    if (sessionId || output !== "interactive" || scope || yes || connectivity) return { kind: "error", message: "job 不接受聊天、scope 或确认选项" };
    if (subcommand === "list" && positional.length === 0) return { kind: "command", invocation: createInvocation({ type: "job_list" }, host) };
    if (subcommand === "show" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "job_show", jobId: positional[0] }, host) };
    if (subcommand === "output" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "job_output", jobId: positional[0] }, host) };
    if (subcommand === "kill" && positional.length === 1) return { kind: "command", invocation: createInvocation({ type: "job_kill", jobId: positional[0] }, host) };
    return { kind: "error", message: "job 支持 list|show <id>|output <id>|kill <id>" };
  }

  if (commandName === "undo") {
    if (subcommand || positional.length !== 0 || !sessionId || output !== "interactive" || scope || connectivity) return { kind: "error", message: "undo 需要 --session <id> --yes" };
    return { kind: "command", invocation: createInvocation({ type: "undo", sessionId, yes }, host) };
  }

  if (commandName === "doctor") {
    if (subcommand || positional.length !== 0 || sessionId || output !== "interactive" || scope || yes) return { kind: "error", message: "doctor 只接受可选 --connectivity" };
    return { kind: "command", invocation: createInvocation({ type: "doctor", connectivity }, host) };
  }

  if (commandName === "sandbox") {
    if (sessionId || output !== "interactive" || scope || connectivity) return { kind: "error", message: "sandbox 不接受聊天、scope 或 connectivity 选项" };
    if (subcommand === "status" && positional.length === 0 && !yes) return { kind: "command", invocation: createInvocation({ type: "sandbox_status" }, host) };
    // Windows provision 属于系统变更（UAC 提权），必须显式 --yes 确认。
    if (subcommand === "setup" && positional.length === 0 && yes) return { kind: "command", invocation: createInvocation({ type: "sandbox_setup", yes }, host) };
    return { kind: "error", message: "sandbox 支持 status | setup --yes" };
  }

  if (commandName === "project") {
    const command: CliCommand = { type: "project_open", path: positional[0] };
    return { kind: "command", invocation: createInvocation(command, host) };
  }

  if (commandName === "chat") {
    const prompt = positional.length > 0 ? positional.join(" ") : undefined;
    if (prompt !== undefined && prompt.trim().length === 0) {
      return { kind: "error", message: "chat prompt 不能为空" };
    }
    const command: CliCommand = {
      type: "chat",
      prompt,
      sessionId,
      output,
    };
    return { kind: "command", invocation: createInvocation(command, host) };
  }

  if (commandName === "resume") {
    if (positional.length > 0) return { kind: "error", message: "resume 不接受位置参数，请使用 --session" };
    const command: CliCommand = { type: "resume", sessionId, output };
    return { kind: "command", invocation: createInvocation(command, host) };
  }

  return { kind: "error", message: commandName ? `未知命令 ${commandName}` : "缺少命令" };
}

/** 为命令附加宿主配置，保持命令 AST 与 Composition Root 参数分离。 */
function createInvocation(command: CliCommand, host: CliHostOptions): CliInvocation {
  return { command, host };
}

/** 解析单行 slash command；普通文本不在此函数内改写。 */
export function parseSlashAction(input: string): CliActionParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    if (!trimmed) return { kind: "error", message: "prompt 不能为空" };
    return { kind: "action", action: { type: "submit_prompt", content: trimmed } };
  }
  const parts = trimmed.slice(1).split(/\s+/u).filter(Boolean);
  const name = parts[0];
  if (!name) return { kind: "error", message: "slash command 不能为空" };
  if (name === "exit") return parts.length === 1 ? { kind: "action", action: { type: "exit" } } : invalidSlashArguments(name);
  if (name === "cancel") return parts.length === 1 ? { kind: "action", action: { type: "cancel_turn" } } : invalidSlashArguments(name);
  if (name === "queue") return parseQueuedPrompt(parts);
  if (name === "compact") return parts.length === 1 ? { kind: "action", action: { type: "compact" } } : invalidSlashArguments(name);
  if (name === "context") {
    if (parts.length === 1) return { kind: "action", action: { type: "show_context", all: false } };
    if (parts.length === 2 && parts[1] === "all") return { kind: "action", action: { type: "show_context", all: true } };
    return { kind: "error", message: "/context 只接受可选 all 参数" };
  }
  if (name === "jobs") return parseJobsAction(parts);
  if (name === "model") return parseRunConfigAction("model", parts);
  if (name === "effort" || name === "reasoning") return parseRunConfigAction("effort", parts);
  if (name === "skill") {
    if (parts.length === 1) return { kind: "action", action: { type: "list_skills" } };
    if (parts.length !== 2) return { kind: "error", message: "/skill 最多接受一个 canonical Skill 名称" };
    return { kind: "action", action: { type: "select_skill", skill: parts[1] } };
  }
  if (name === "permissions") return parsePermissionsAction(parts);
  if (name === "approve") {
    if (parts.length !== 2 || !isApprovalDecision(parts[1])) {
      return { kind: "error", message: "/approve 需要 allow_once|allow_session|allow_workspace|deny" };
    }
    return { kind: "action", action: { type: "approve", decision: parts[1] } };
  }
  if (name === "undo") {
    if (parts.length === 1) return { kind: "action", action: { type: "undo_preview" } };
    if (parts.length === 2 && parts[1] === "confirm") return { kind: "action", action: { type: "undo_confirm" } };
    return { kind: "error", message: "/undo 只接受可选 confirm；请先 /undo 查看预览" };
  }
  return { kind: "error", message: `未知 slash command /${name}` };
}

/** 将 /jobs 的列表、详情、日志和停止操作解析为宿主管理 Action。 */
function parseJobsAction(parts: string[]): CliActionParseResult {
  if (parts.length === 1) return { kind: "action", action: { type: "list_jobs" } };
  if (parts.length !== 3) return { kind: "error", message: "/jobs 支持 show|output|stop <jobId>" };
  if (parts[1] === "show") return { kind: "action", action: { type: "show_job", jobId: parts[2] } };
  if (parts[1] === "output") return { kind: "action", action: { type: "read_job_output", jobId: parts[2] } };
  if (parts[1] === "stop") return { kind: "action", action: { type: "stop_job", jobId: parts[2] } };
  return { kind: "error", message: "/jobs 支持 show|output|stop <jobId>" };
}

/** 将 /queue <prompt> 解析为明确的 durable queue 投递，而不把命令文本交给模型。 */
function parseQueuedPrompt(parts: string[]): CliActionParseResult {
  const content = parts.slice(1).join(" ").trim();
  if (!content) return { kind: "error", message: "/queue 需要一条 prompt" };
  return { kind: "action", action: { type: "submit_prompt", content, delivery: "queue" } };
}

/** 检查 slash 审批决定是否属于固定宿主联合类型。 */
function isApprovalDecision(value: string): value is Extract<CliAction, { type: "approve" }>['decision'] {
  return value === "allow_once" || value === "allow_session" || value === "allow_workspace" || value === "deny";
}

/** 返回统一的 slash 参数错误。 */
function invalidSlashArguments(name: string): CliActionParseResult {
  return { kind: "error", message: `/${name} 不接受额外参数` };
}

/** 解析权限模式查询、Session 默认权限更新与持久授权查看/撤销（Talk-Plan1013 Stage 4）。 */
function parsePermissionsAction(parts: string[]): CliActionParseResult {
  if (parts.length === 1) return { kind: "action", action: { type: "open_permissions" } };
  if (parts.length === 2 && parts[1] === "grants") return { kind: "action", action: { type: "list_permission_grants" } };
  if (parts[1] === "revoke") {
    if (parts.length === 2) return { kind: "error", message: "/permissions revoke 需要从 /permissions grants 列表中复制的完整 constraint" };
    // constraint 由 ext-file:/path:/program: 前缀与路径组成，路径可含空格，按原样拼接且不再拆分。
    const constraint = parts.slice(2).join(" ").trim();
    return { kind: "action", action: { type: "revoke_permission_grant", constraint } };
  }
  if (parts.length !== 2 || !isPermissionMode(parts[1])) {
    return { kind: "error", message: "/permissions 需要 ask|auto_approve|full_access 或 grants | revoke <constraint>" };
  }
  return { kind: "action", action: { type: "set_permission_mode", mode: parts[1] } };
}

/** 检查 slash 命令是否属于 Core 的三态工具权限模式。 */
function isPermissionMode(value: string): value is "ask" | "auto_approve" | "full_access" {
  return value === "ask" || value === "auto_approve" || value === "full_access";
}

/** 将模型/effort 命令解析为 picker 查询或下一 Turn 的 Session 默认值更新。 */
function parseRunConfigAction(name: "model" | "effort", parts: string[]): CliActionParseResult {
  if (parts.length > 2) return { kind: "error", message: `/${name} 最多接受一个值` };
  if (name === "model") {
    if (!parts[1]) return { kind: "action", action: { type: "open_model_picker" } };
    const separator = parts[1].indexOf("/");
    if (separator > 0 && separator < parts[1].length - 1) {
      return { kind: "action", action: { type: "set_model", provider: parts[1].slice(0, separator), modelId: parts[1].slice(separator + 1) } };
    }
    return { kind: "action", action: { type: "set_model", modelId: parts[1] } };
  }
  return parts[1]
    ? { kind: "action", action: { type: "set_effort", effort: parts[1] } }
    : { kind: "action", action: { type: "open_effort_picker" } };
}
