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
  CliThreadCommand,
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
    "  autopilot thread group of --thread <id>  (读取groupId/revision)",
    "  autopilot thread group enable --thread <id> --request-id <id>",
    "  autopilot thread group disable --group <id> --request-id <id>",
    "  autopilot thread create --group <id> --thread <parentId> --request-id <id> [--title <t>] [--role <label>] [--model <provider/modelId>] [--effort <level>]",
    "  autopilot thread associate --group <id> --thread <id> --request-id <id>",
    "  autopilot thread bind-host --group <id> --thread <id> --expected-revision <n> --execution-host <cli-work-v1|web-work-v1>",
    "  autopilot thread list --group <id> [--cursor <c>] [--limit <n>]",
    "  autopilot thread read --group <id> --thread <id> [--cursor <c>] [--limit <n>]",
    "  autopilot thread send --group <id> --thread <id> --mode <notify|run|steer> --request-id <id> (--message-file <path> | --message-stdin) [--reply-to <id>] [--expected-turn-id <id>] [--handoff-title <t> --handoff-file <path>]",
    "  autopilot thread wait --group <id> --thread <id> [--thread <id> ...] [--cursor <threadId>=<cursor> ...] [--task <threadId>=<messageId> ...] [--timeout-ms <n>]",
    "  autopilot thread state read --group <id>",
    "  autopilot thread state set --group <id> --request-id <id> --expected-revision <n> --key <k> (--value <json> | --value-file <path>)",
    "  autopilot thread state remove --group <id> --request-id <id> --expected-revision <n> --key <k>",
    "  autopilot thread interrupt --group <id> --thread <id> --expected-turn-id <id> --request-id <id>",
    "  autopilot thread watch --group <id> [--cursor <c>] [--limit <n>]",
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
      // 协作命令族有独立选项集；交给专用 parser，避免把 --thread/--group 泄漏给其他命令。
      if (token === "thread") return parseThreadArgv(argv.slice(index + 1), host);
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

/** 协作命令支持的带值选项；未列出的选项一律拒绝，避免拼写错误被静默忽略。 */
const THREAD_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--group", "--thread", "--request-id", "--title", "--role", "--model", "--effort",
  "--cursor", "--limit", "--mode", "--message-file", "--reply-to", "--expected-turn-id",
  "--handoff-title", "--handoff-file", "--task", "--timeout-ms", "--expected-revision", "--key",
  "--value", "--value-file", "--execution-host",
]);

/** 协作命令支持的开关选项。 */
const THREAD_FLAG_OPTIONS: ReadonlySet<string> = new Set(["--message-stdin"]);

/** 可与协作命令混排的宿主选项；值语义与全局 parser 一致。 */
const THREAD_HOST_OPTIONS: ReadonlySet<string> = new Set(["--state-root", "--trust-root", "--workspace-root"]);

/** 协作命令的原始选项集合；重复选项保留全部值，由各子命令判定是否允许重复。 */
interface ThreadArgBag {
  options: Map<string, string[]>;
  flags: Set<string>;
  positionals: string[];
  host: CliHostOptions;
}

/** 构造统一的用法错误。 */
function threadUsageError(message: string): CliParseResult {
  return { kind: "error", message };
}

/** 拆分协作命令的选项与位置参数；只做词法切分，不解释语义。 */
function readThreadArgs(tokens: readonly string[]): ThreadArgBag | { error: string } {
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const host: CliHostOptions = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (THREAD_FLAG_OPTIONS.has(token)) {
      flags.add(token);
      continue;
    }
    if (THREAD_HOST_OPTIONS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined) return { error: `选项 ${token} 需要一个值` };
      if (token === "--state-root") host.stateRoot = value;
      else if (token === "--trust-root") host.trustRoot = value;
      else host.workspaceRoot = value;
      index += 1;
      continue;
    }
    if (!THREAD_VALUE_OPTIONS.has(token)) {
      if (token.startsWith("-")) return { error: `未知选项 ${token}` };
      positionals.push(token);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined) return { error: `选项 ${token} 需要一个值` };
    const values = options.get(token) ?? [];
    values.push(value);
    options.set(token, values);
    index += 1;
  }
  return { options, flags, positionals, host };
}

/** 读取唯一必填选项；缺失、重复或空值统一返回用法错误。 */
function requiredThreadOption(bag: ThreadArgBag, name: string): { value: string } | { error: string } {
  const values = bag.options.get(name);
  if (!values || values.length !== 1 || !values[0]) return { error: `thread 命令需要且只接受一个 ${name}` };
  return { value: values[0] };
}

/** 读取可选单值选项；重复出现视为用法错误。 */
function optionalThreadOption(bag: ThreadArgBag, name: string): { value?: string } | { error: string } {
  const values = bag.options.get(name);
  if (!values) return {};
  if (values.length !== 1 || !values[0]) return { error: `选项 ${name} 只能出现一次且不能为空` };
  return { value: values[0] };
}

/** 解析有界整数选项；不接受负数或小数。 */
function threadInteger(value: string, name: string, min: number, max: number): { value: number } | { error: string } {
  if (!/^\d+$/u.test(value)) return { error: `${name} 需要非负整数` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return { error: `${name} 必须在 ${min}-${max} 之间` };
  return { value: parsed };
}

/** 组装协作命令；位置参数必须为空，避免把多余文本当成正文或身份。 */
function threadCommand(subcommand: string, command: CliThreadCommand, bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  if (bag.positionals.length > 0) return threadUsageError(`thread ${subcommand} 不接受位置参数：${bag.positionals.join(" ")}`);
  return { kind: "command", invocation: createInvocation({ type: "thread", command }, { ...host, ...bag.host }) };
}

/** 解析 `autopilot thread ...` 薄命令族；argv 契约见 CLI-Reference 第 12 节。 */
function parseThreadArgv(tokens: readonly string[], host: CliHostOptions): CliParseResult {
  const name = tokens[0];
  if (!name || name.startsWith("-")) return threadUsageError("thread 支持 group|create|associate|bind-host|list|read|send|wait|state|interrupt|watch");
  if (name === "group") return parseThreadGroup(tokens.slice(1), host);
  if (name === "state") return parseThreadState(tokens.slice(1), host);
  if (name !== "bind-host" && name !== "create" && name !== "associate" && name !== "list" && name !== "read" && name !== "send" && name !== "wait" && name !== "interrupt" && name !== "watch") {
    return threadUsageError(`未知 thread 子命令 ${name}`);
  }
  const bag = readThreadArgs(tokens.slice(1));
  if ("error" in bag) return threadUsageError(bag.error);
  if (name === "create") return parseThreadCreate(bag, host);
  if (name === "associate") return parseThreadAssociate(bag, host);
  if (name === "bind-host") return parseThreadBindHost(bag, host);
  if (name === "list") return parseThreadList(bag, host);
  if (name === "read") return parseThreadRead(bag, host);
  if (name === "send") return parseThreadSend(bag, host);
  if (name === "wait") return parseThreadWait(bag, host);
  if (name === "interrupt") return parseThreadInterrupt(bag, host);
  return parseThreadWatch(bag, host);
}

/** 解析 `thread group enable|disable`；启用与停用都必须带稳定请求编号。 */
function parseThreadGroup(tokens: readonly string[], host: CliHostOptions): CliParseResult {
  const action = tokens[0];
  const bag = readThreadArgs(tokens.slice(1));
  if ("error" in bag) return threadUsageError(bag.error);
  if (action === "of") {
    const threadId = requiredThreadOption(bag, "--thread");
    if ("error" in threadId) return threadUsageError(threadId.error);
    return threadCommand("group of", { type: "group_of", threadId: threadId.value }, bag, host);
  }
  if (action === "enable") {
    const rootThreadId = requiredThreadOption(bag, "--thread");
    if ("error" in rootThreadId) return threadUsageError(rootThreadId.error);
    const requestId = requiredThreadOption(bag, "--request-id");
    if ("error" in requestId) return threadUsageError(requestId.error);
    return threadCommand("group enable", { type: "group_enable", requestId: requestId.value, rootThreadId: rootThreadId.value }, bag, host);
  }
  if (action === "disable") {
    const groupId = requiredThreadOption(bag, "--group");
    if ("error" in groupId) return threadUsageError(groupId.error);
    const requestId = requiredThreadOption(bag, "--request-id");
    if ("error" in requestId) return threadUsageError(requestId.error);
    return threadCommand("group disable", { type: "group_disable", requestId: requestId.value, groupId: groupId.value }, bag, host);
  }
  return threadUsageError("thread group 支持 of|enable|disable");
}

/** 解析 `thread state read|set|remove`；写入必须给 expected revision 与请求编号。 */
function parseThreadState(tokens: readonly string[], host: CliHostOptions): CliParseResult {
  const action = tokens[0];
  const bag = readThreadArgs(tokens.slice(1));
  if ("error" in bag) return threadUsageError(bag.error);
  if (action !== "read" && action !== "set" && action !== "remove") return threadUsageError("thread state 支持 read|set|remove");
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  if (action === "read") return threadCommand("state read", { type: "state_read", groupId: groupId.value }, bag, host);
  const requestId = requiredThreadOption(bag, "--request-id");
  if ("error" in requestId) return threadUsageError(requestId.error);
  const revision = requiredThreadOption(bag, "--expected-revision");
  if ("error" in revision) return threadUsageError(revision.error);
  const expectedRevision = threadInteger(revision.value, "--expected-revision", 0, Number.MAX_SAFE_INTEGER);
  if ("error" in expectedRevision) return threadUsageError(expectedRevision.error);
  const key = requiredThreadOption(bag, "--key");
  if ("error" in key) return threadUsageError(key.error);
  const value = optionalThreadOption(bag, "--value");
  if ("error" in value) return threadUsageError(value.error);
  const valueFile = optionalThreadOption(bag, "--value-file");
  if ("error" in valueFile) return threadUsageError(valueFile.error);
  if (action === "remove") {
    if (value.value !== undefined || valueFile.value !== undefined) return threadUsageError("thread state remove 不接受 --value/--value-file");
    return threadCommand("state remove", { type: "state_remove", requestId: requestId.value, groupId: groupId.value, expectedRevision: expectedRevision.value, key: key.value }, bag, host);
  }
  let stateValue: { kind: "inline"; json: string } | { kind: "file"; path: string };
  if (value.value !== undefined && valueFile.value === undefined) stateValue = { kind: "inline", json: value.value };
  else if (valueFile.value !== undefined && value.value === undefined) stateValue = { kind: "file", path: valueFile.value };
  else return threadUsageError("thread state set 需要 --value 或 --value-file 二选一");
  return threadCommand("state set", {
    type: "state_set",
    requestId: requestId.value,
    groupId: groupId.value,
    expectedRevision: expectedRevision.value,
    key: key.value,
    value: stateValue,
  }, bag, host);
}

/** 解析 `thread create`；`--thread` 是父会话，模型与推理强度只能在宿主目录内选择。 */
function parseThreadCreate(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const parentThreadId = requiredThreadOption(bag, "--thread");
  if ("error" in parentThreadId) return threadUsageError(parentThreadId.error);
  const requestId = requiredThreadOption(bag, "--request-id");
  if ("error" in requestId) return threadUsageError(requestId.error);
  const title = optionalThreadOption(bag, "--title");
  if ("error" in title) return threadUsageError(title.error);
  const roleLabel = optionalThreadOption(bag, "--role");
  if ("error" in roleLabel) return threadUsageError(roleLabel.error);
  const model = optionalThreadOption(bag, "--model");
  if ("error" in model) return threadUsageError(model.error);
  const effort = optionalThreadOption(bag, "--effort");
  if ("error" in effort) return threadUsageError(effort.error);
  let modelRef: { provider: string; modelId: string } | undefined;
  if (model.value !== undefined) {
    const separator = model.value.indexOf("/");
    if (separator <= 0 || separator === model.value.length - 1) return threadUsageError("--model 需要 provider/modelId");
    modelRef = { provider: model.value.slice(0, separator), modelId: model.value.slice(separator + 1) };
  }
  if (effort.value !== undefined && effort.value !== "none" && effort.value !== "low" && effort.value !== "medium" && effort.value !== "high" && effort.value !== "max") {
    return threadUsageError("--effort 支持 none|low|medium|high|max");
  }
  return threadCommand("create", {
    type: "create",
    requestId: requestId.value,
    groupId: groupId.value,
    parentThreadId: parentThreadId.value,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(roleLabel.value !== undefined ? { roleLabel: roleLabel.value } : {}),
    ...(modelRef ? { modelRef } : {}),
    ...(effort.value !== undefined ? { reasoningEffort: effort.value } : {}),
  }, bag, host);
}

/** 解析 `thread list`；游标与条数由 Core 再校验一次。 */
function parseThreadList(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const cursor = optionalThreadOption(bag, "--cursor");
  if ("error" in cursor) return threadUsageError(cursor.error);
  const limit = optionalThreadOption(bag, "--limit");
  if ("error" in limit) return threadUsageError(limit.error);
  let limitValue: number | undefined;
  if (limit.value !== undefined) {
    const parsedLimit = threadInteger(limit.value, "--limit", 1, 100);
    if ("error" in parsedLimit) return threadUsageError(parsedLimit.error);
    limitValue = parsedLimit.value;
  }
  return threadCommand("list", {
    type: "list",
    groupId: groupId.value,
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    ...(limitValue !== undefined ? { limit: limitValue } : {}),
  }, bag, host);
}

/** 解析 `thread read`；读取不启动、不恢复目标会话。 */
function parseThreadRead(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadId = requiredThreadOption(bag, "--thread");
  if ("error" in threadId) return threadUsageError(threadId.error);
  const cursor = optionalThreadOption(bag, "--cursor");
  if ("error" in cursor) return threadUsageError(cursor.error);
  const limit = optionalThreadOption(bag, "--limit");
  if ("error" in limit) return threadUsageError(limit.error);
  let limitValue: number | undefined;
  if (limit.value !== undefined) {
    const parsedLimit = threadInteger(limit.value, "--limit", 1, 100);
    if ("error" in parsedLimit) return threadUsageError(parsedLimit.error);
    limitValue = parsedLimit.value;
  }
  return threadCommand("read", {
    type: "read",
    groupId: groupId.value,
    threadId: threadId.value,
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    ...(limitValue !== undefined ? { limit: limitValue } : {}),
  }, bag, host);
}

/** 解析 `thread send`；正文只允许文件或显式 stdin，避免 shell 二次解释。 */
function parseThreadSend(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadId = requiredThreadOption(bag, "--thread");
  if ("error" in threadId) return threadUsageError(threadId.error);
  const requestId = requiredThreadOption(bag, "--request-id");
  if ("error" in requestId) return threadUsageError(requestId.error);
  const mode = requiredThreadOption(bag, "--mode");
  if ("error" in mode) return threadUsageError(mode.error);
  if (mode.value !== "notify" && mode.value !== "run" && mode.value !== "steer") return threadUsageError("--mode 支持 notify|run|steer");
  const messageFile = optionalThreadOption(bag, "--message-file");
  if ("error" in messageFile) return threadUsageError(messageFile.error);
  const fromStdin = bag.flags.has("--message-stdin");
  if (Boolean(messageFile.value) === fromStdin) return threadUsageError("正文需要 --message-file 或 --message-stdin 二选一");
  const replyTo = optionalThreadOption(bag, "--reply-to");
  if ("error" in replyTo) return threadUsageError(replyTo.error);
  const expectedTurnId = optionalThreadOption(bag, "--expected-turn-id");
  if ("error" in expectedTurnId) return threadUsageError(expectedTurnId.error);
  if (mode.value === "steer" && expectedTurnId.value === undefined) return threadUsageError("--mode steer 必须提供 --expected-turn-id");
  if (mode.value !== "steer" && expectedTurnId.value !== undefined) return threadUsageError("只有 --mode steer 接受 --expected-turn-id");
  const handoffTitle = optionalThreadOption(bag, "--handoff-title");
  if ("error" in handoffTitle) return threadUsageError(handoffTitle.error);
  const handoffFile = optionalThreadOption(bag, "--handoff-file");
  if ("error" in handoffFile) return threadUsageError(handoffFile.error);
  if (Boolean(handoffTitle.value) !== Boolean(handoffFile.value)) return threadUsageError("交接需要同时提供 --handoff-title 与 --handoff-file");
  if (handoffTitle.value !== undefined && mode.value !== "run") return threadUsageError("交接只允许 --mode run");
  return threadCommand("send", {
    type: "send",
    requestId: requestId.value,
    groupId: groupId.value,
    threadId: threadId.value,
    mode: mode.value,
    contentSource: messageFile.value ? { kind: "file", path: messageFile.value } : { kind: "stdin" },
    ...(replyTo.value !== undefined ? { replyTo: replyTo.value } : {}),
    ...(expectedTurnId.value !== undefined ? { expectedTurnId: expectedTurnId.value } : {}),
    ...(handoffTitle.value && handoffFile.value ? { handoff: { title: handoffTitle.value, markdownFile: handoffFile.value } } : {}),
  }, bag, host);
}

/** 解析 `thread wait`；每个 `--thread` 一个目标，游标用 `--cursor <threadId>=<cursor>` 指定。 */
function parseThreadWait(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadValues = bag.options.get("--thread") ?? [];
  if (threadValues.length === 0 || threadValues.length > 8) return threadUsageError("thread wait 需要 1-8 个 --thread");
  if (new Set(threadValues).size !== threadValues.length) return threadUsageError("thread wait 的 --thread 不能重复");
  const cursors = new Map<string, string>();
  for (const entry of bag.options.get("--cursor") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) return threadUsageError("--cursor 需要 <threadId>=<cursor>");
    const target = entry.slice(0, separator);
    if (!threadValues.includes(target)) return threadUsageError(`--cursor 的目标 ${target} 不在 --thread 列表中`);
    if (cursors.has(target)) return threadUsageError(`--cursor 重复指定了 ${target}`);
    cursors.set(target, entry.slice(separator + 1));
  }
  const tasks = new Map<string, string>();
  for (const entry of bag.options.get("--task") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) return threadUsageError("--task 需要 <threadId>=<messageId>");
    const target = entry.slice(0, separator);
    if (!threadValues.includes(target) || tasks.has(target)) return threadUsageError("--task 目标必须属于 --thread 且不能重复");
    tasks.set(target, entry.slice(separator + 1));
  }
  const timeout = optionalThreadOption(bag, "--timeout-ms");
  if ("error" in timeout) return threadUsageError(timeout.error);
  const timeoutMs = timeout.value === undefined ? { value: 30_000 } : threadInteger(timeout.value, "--timeout-ms", 0, 30_000);
  if ("error" in timeoutMs) return threadUsageError(timeoutMs.error);
  return threadCommand("wait", {
    type: "wait",
    groupId: groupId.value,
    targets: threadValues.map(function toTarget(threadId) {
      const cursor = cursors.get(threadId);
      return { threadId, ...(tasks.has(threadId) ? { taskId: tasks.get(threadId)! } : {}), ...(cursor !== undefined ? { cursor } : {}) };
    }),
    timeoutMs: timeoutMs.value,
  }, bag, host);
}

/** 显式关联已有会话；只有受信人类 owner 可在 Core 中真正授权。 */
function parseThreadAssociate(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadId = requiredThreadOption(bag, "--thread");
  if ("error" in threadId) return threadUsageError(threadId.error);
  const requestId = requiredThreadOption(bag, "--request-id");
  if ("error" in requestId) return threadUsageError(requestId.error);
  return threadCommand("associate", { type: "associate", groupId: groupId.value, threadId: threadId.value, requestId: requestId.value }, bag, host);
}

/** 人类明确选择旧目标的执行档位，组版本用于拒绝迟到确认。 */
function parseThreadBindHost(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadId = requiredThreadOption(bag, "--thread");
  if ("error" in threadId) return threadUsageError(threadId.error);
  const revision = requiredThreadOption(bag, "--expected-revision");
  if ("error" in revision) return threadUsageError(revision.error);
  const executionHost = requiredThreadOption(bag, "--execution-host");
  if ("error" in executionHost) return threadUsageError(executionHost.error);
  if (!/^\d+$/u.test(revision.value) || !Number.isSafeInteger(Number(revision.value))) return threadUsageError("--expected-revision 需要非负整数");
  if (executionHost.value !== "cli-work-v1" && executionHost.value !== "web-work-v1") return threadUsageError("--execution-host 需要 cli-work-v1 或 web-work-v1");
  return threadCommand("bind-host", { type: "bind_host", groupId: groupId.value, threadId: threadId.value, expectedRevision: Number(revision.value), executionHost: executionHost.value }, bag, host);
}

/** 解析 `thread interrupt`；必须带发送时观察到的 Turn，避免中断错任务。 */
function parseThreadInterrupt(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const threadId = requiredThreadOption(bag, "--thread");
  if ("error" in threadId) return threadUsageError(threadId.error);
  const requestId = requiredThreadOption(bag, "--request-id");
  if ("error" in requestId) return threadUsageError(requestId.error);
  const expectedTurnId = requiredThreadOption(bag, "--expected-turn-id");
  if ("error" in expectedTurnId) return threadUsageError(expectedTurnId.error);
  return threadCommand("interrupt", { type: "interrupt", requestId: requestId.value, groupId: groupId.value, threadId: threadId.value, expectedTurnId: expectedTurnId.value }, bag, host);
}

/** 解析 `thread watch`；只观察组事件，Ctrl+C 只结束观察。 */
function parseThreadWatch(bag: ThreadArgBag, host: CliHostOptions): CliParseResult {
  const groupId = requiredThreadOption(bag, "--group");
  if ("error" in groupId) return threadUsageError(groupId.error);
  const cursor = optionalThreadOption(bag, "--cursor");
  if ("error" in cursor) return threadUsageError(cursor.error);
  const limit = optionalThreadOption(bag, "--limit");
  if ("error" in limit) return threadUsageError(limit.error);
  let limitValue: number | undefined;
  if (limit.value !== undefined) {
    const parsedLimit = threadInteger(limit.value, "--limit", 1, 100);
    if ("error" in parsedLimit) return threadUsageError(parsedLimit.error);
    limitValue = parsedLimit.value;
  }
  return threadCommand("watch", {
    type: "watch",
    groupId: groupId.value,
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    ...(limitValue !== undefined ? { limit: limitValue } : {}),
  }, bag, host);
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
  if (name === "resume") return parts.length === 1 ? { kind: "action", action: { type: "resume" } } : { kind: "error", message: "/resume 不接受额外参数" };
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
