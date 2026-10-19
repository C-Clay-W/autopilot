#!/usr/bin/env node
/**
 * agent CLI 的 Step 5.3 运行入口。
 *
 * 入口只负责 argv、Composition Root、Plain Controller 和进程生命周期的编排；
 * Session、Turn、审批、恢复和持久化规则全部委托给 Core Runtime。
 */

import { WEB_SEARCH_DATA_FLOW_NOTICE } from "@autopilot-agent/presentation";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  AgentRuntimeError,
  WorkspaceTrustError,
  type AgentRuntime,
  type Job,
  type JobView,
  type Project,
  type Session,
} from "@autopilot-agent/core";
import { createCliCompositionRoot, type CliCompositionRoot, type CreateCliCompositionRootOptions } from "./composition-root.js";
import { createCliController, type CliController, type CliControllerResult } from "./controller.js";
import { classifyCliError } from "./error-diagnostics.js";
import { parseArgv, parseSlashAction, renderHelp } from "./parser.js";
import { createPlainRenderer } from "./renderer.js";
import { runCliTui, runCliTrustDialog } from "./tui.js";
import type { CliAction, CliCommand, CliExitCode, CliOutputFormat, CliParseResult } from "./types.js";

/** CLI 主入口使用的最小输出/输入流接口。 */
export interface CliMainStreams {
  stdout: { write(chunk: string): void; isTTY?: boolean; columns?: number };
  stderr: { write(chunk: string): void; isTTY?: boolean };
  stdin?: (NodeJS.ReadableStream & { isTTY?: boolean });
}

/** CLI 可监听的进程信号来源；抽象后可测试且不会残留真实监听器。 */
export interface CliSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

/** CLI 运行依赖；生产入口使用真实 Composition Root 和 process，测试可注入 double。 */
export interface CliMainDependencies {
  createCompositionRoot?: (options: CreateCliCompositionRootOptions) => CliCompositionRoot;
  signalSource?: CliSignalSource;
  forceExit?: (code: 130) => void;
  cwd?: string;
}

/** 将宿主信号映射为固定 CLI 退出码。 */
export function exitCodeForSignal(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

/** 将控制器结果写入约定的 stdout/stderr 通道。 */
function writeControllerResult(result: CliControllerResult, streams: CliMainStreams): void {
  const target = result.kind === "error" || result.kind === "unavailable" ? streams.stderr : streams.stdout;
  for (const line of result.lines) target.write(`${line}\n`);
  if (result.lines.length === 0 && result.message) target.write(`${result.message}\n`);
}

/** 将 Runtime/Trust 异常收窄为不泄露绝对路径、凭据或原始输入的诊断。 */
function formatCliError(error: unknown): string {
  const classification = classifyCliError(error);
  if (classification.category === "config_directory") return classification.code;
  if (error instanceof WorkspaceTrustError) return `WORKSPACE_TRUST_REQUIRED: ${error.status}`;
  if (error instanceof AgentRuntimeError) return `${error.code}: ${sanitizeErrorMessage(error.message)}`;
  return "CLI_RUNTIME_ERROR";
}

/** 对错误摘要做长度和常见敏感字段脱敏。 */
function sanitizeErrorMessage(message: string): string {
  return message
    .slice(0, 500)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|mnt|workspace|Volumes)\/)[^\s"'`]+/gu, "[path]")
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret|dsn)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
}

/** 输出管理命令的单行安全结果；保留 JSON 可解析性并统一遮蔽凭据和绝对路径。 */
function writeManagementResult(streams: CliMainStreams, value: unknown): void {
  const safe = sanitizeManagementValue(value);
  streams.stdout.write(`${typeof safe === "string" ? safe : JSON.stringify(safe)}\n`);
}

/** 在序列化前逐字段限制字符串并脱敏，保证长数组仍是完整有效 JSON。 */
function sanitizeManagementValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeManagementString(value);
  if (Array.isArray(value)) return value.map(sanitizeManagementValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(function sanitizeEntry(entry) {
      return [entry[0], sanitizeManagementValue(entry[1])];
    }));
  }
  return value;
}

/** 管理字段先做独立长度限制与二次脱敏，不截断已经序列化的 JSON。 */
function sanitizeManagementString(value: string): string {
  return value
    .slice(0, 16 * 1024)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|mnt|workspace|Volumes)\/)[^\s"'`]+/gu, "[path]")
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret|dsn)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
}

/** 将 Core 安全 JobView 补充独立命令所需身份，不读取命令、路径、PID 或 owner。 */
function summarizeJob(job: Job, view: JobView): Record<string, unknown> {
  return {
    id: job.id,
    sessionId: job.sessionId,
    turnId: job.turnId,
    ...view,
    snapshotKind: view.controlState === "owned" ? "live" : "stored",
  };
}

/** 通过 durable 身份定位 Job 后改走 Session 绑定 API，避免独立命令绕过 owner 与安全投影。 */
async function readIndependentJob(runtime: AgentRuntime, workspaceRoot: string, jobId: string) {
  const job = await runtime.jobs.get(jobId);
  if (!job || job.workspaceId !== workspaceRoot) throw new AgentRuntimeError("JOB_NOT_FOUND", "JOB_NOT_FOUND");
  const scoped = runtime.jobs.forSession({ workspaceId: workspaceRoot, sessionId: job.sessionId });
  return { job, scoped, read: await scoped.read({ jobId, waitMs: 0 }) };
}

/** 将 MCP 服务收口为身份、授权与执行隔离事实，绝不输出命令、参数、cwd 或环境变量。 */
function summarizeMcpServer(server: { serverName: string; approved: boolean; executionMode: "sandbox" | "host"; isolation: "sandboxed" | "unisolated" }): Record<string, unknown> {
  return { serverName: server.serverName, approved: server.approved, executionMode: server.executionMode, isolation: server.isolation };
}

/** 读取交互删除确认；非 TTY 调用方必须使用 --yes，避免 stdin 被误消费。 */
async function confirmSessionDelete(streams: CliMainStreams, session: Session): Promise<boolean> {
  const input = streams.stdin ?? process.stdin;
  if (streams.stdout.isTTY !== true || input.isTTY !== true) return false;
  streams.stdout.write(`delete session ${session.id} (${session.title ?? "untitled"})? [y/N] `);
  const inputInterface = readline.createInterface({ input, output: streams.stdout as NodeJS.WritableStream });
  try {
    const answer = await new Promise<string>(function readConfirmation(resolve) {
      inputInterface.question("", resolve);
    });
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    inputInterface.close();
  }
}

/** 显示 MCP 的最小安全授权摘要并读取一次显式确认；非 TTY 只能使用 --yes。 */
async function confirmMcpApproval(streams: CliMainStreams, server: { serverName: string }): Promise<boolean> {
  const input = streams.stdin ?? process.stdin;
  if (streams.stdout.isTTY !== true || input.isTTY !== true) return false;
  streams.stdout.write(`approve MCP server ${server.serverName} for this workspace? [y/N] `);
  const inputInterface = readline.createInterface({ input, output: streams.stdout as NodeJS.WritableStream });
  try {
    const answer = await new Promise<string>(function readConfirmation(resolve) { inputInterface.question("", resolve); });
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    inputInterface.close();
  }
}

/** 将 Doctor DTO 投影为稳定的纯文本行，不暴露路径、凭据和 Provider 正文。 */
function writeDoctorResult(streams: CliMainStreams, checks: Awaited<ReturnType<CliCompositionRoot["doctor"]>>): void {
  for (const check of checks) streams.stdout.write(`${check.status} ${check.name}: ${sanitizeErrorMessage(check.detail)}\n`);
}

/** 按 workspaceRoot 找到既有 Project，否则通过 Runtime 创建最小 Project。 */
async function ensureProject(runtime: AgentRuntime, workspaceRoot: string): Promise<Project> {
  const projects = await runtime.projects.list();
  const existing = projects.find(function findProject(project) { return project.workspaceRoot === workspaceRoot; });
  if (existing) return existing;
  return runtime.projects.create({ name: path.basename(workspaceRoot) || "project", workspaceRoot });
}

/** 读取指定 Session 或创建当前 Project 下的新 Session。 */
async function ensureChatSession(runtime: AgentRuntime, project: Project, sessionId: string | undefined, prompt: string | undefined): Promise<Session> {
  if (sessionId) {
    const session = await runtime.sessions.get(sessionId);
    if (!session) throw new AgentRuntimeError("SESSION_NOT_FOUND", `Session ${sessionId} 不存在`);
    if (session.projectId && session.projectId !== project.id) throw new AgentRuntimeError("INVALID_INPUT", "Session 不属于当前受信任 Project");
    return session;
  }
  return runtime.sessions.create({
    projectId: project.id,
    title: prompt?.trim().slice(0, 80),
  });
}

/** 读取指定或最近的可恢复 Session；没有可用 Session 时返回稳定错误。 */
async function selectResumeSession(runtime: AgentRuntime, project: Project, sessionId: string | undefined): Promise<Session> {
  if (sessionId) return ensureChatSession(runtime, project, sessionId, undefined);
  const sessions = (await runtime.sessions.list())
    .filter(function selectProjectSession(item) { return !item.projectId || item.projectId === project.id; })
    .sort(function sortRecent(left, right) { return right.updatedAt - left.updatedAt; });
  for (const session of sessions) {
    const state = await runtime.turns.getRecoverableState({ sessionId: session.id });
    if (state?.recoverable && (state.status === "awaiting_approval" || state.status === "interrupted_recoverable" || state.status === "limit_reached")) return session;
  }
  throw new AgentRuntimeError("INVALID_INPUT", "没有可恢复的 Turn；已完成或失败的 Turn 不能 resume");
}

/** 在一次 Runtime 操作期间注册并清理 SIGINT/SIGTERM，活动 turn 统一走 cancel。 */
async function runWithSignals(
  controller: CliController,
  operation: () => Promise<CliControllerResult>,
  signalSource: CliSignalSource,
): Promise<{ result: CliControllerResult; exitCode: CliExitCode }> {
  let signalExitCode: 130 | 143 | undefined;
  let cancellation: Promise<void> | undefined;

  /** 收到宿主信号时请求 Core 取消当前 turn。 */
  function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    signalExitCode = exitCodeForSignal(signal);
    cancellation = controller.dispatch({ type: "cancel_turn" }).then(function ignoreCancellationResult() { return undefined; }).catch(function ignoreCancellationError() { return undefined; });
  }

  function handleSigint(): void { handleSignal("SIGINT"); }
  function handleSigterm(): void { handleSignal("SIGTERM"); }

  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);
  try {
    const result = await operation();
    if (cancellation) await cancellation;
    return { result, exitCode: signalExitCode ?? result.exitCode };
  } finally {
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }
}

/** 将一行输入映射为安全 Action，并运行 Plain Controller。 */
async function runInputLoop(
  controller: CliController,
  format: CliOutputFormat,
  streams: CliMainStreams,
  signalSource: CliSignalSource,
  showPrompt = format !== "jsonl",
): Promise<CliExitCode> {
  const input = streams.stdin ?? process.stdin;
  const inputInterface = readline.createInterface({ input, crlfDelay: Infinity });
  let requestedExitCode: 130 | 143 | undefined;
  let cancellation: Promise<void> | undefined;
  const closeInput = function closeInput(): void { inputInterface.close(); };

  /** 输入信号统一取消活动 turn，并关闭 EOF 读取器。 */
  function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    requestedExitCode = exitCodeForSignal(signal);
    cancellation = controller.dispatch({ type: "cancel_turn" }).then(function ignoreCancellationResult() { return undefined; }).catch(function ignoreCancellationError() { return undefined; });
    closeInput();
  }

  function handleSigint(): void { handleSignal("SIGINT"); }
  function handleSigterm(): void { handleSignal("SIGTERM"); }
  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);

  let lastExitCode: CliExitCode = 0;
  try {
    if (showPrompt) streams.stdout.write("> ");
    for await (const rawLine of inputInterface) {
      if (requestedExitCode) break;
      const parsed = parseSlashAction(String(rawLine));
      if (parsed.kind === "error") {
        streams.stderr.write(`${parsed.message}\n`);
        lastExitCode = 2;
        if (showPrompt) streams.stdout.write("> ");
        continue;
      }
      const result = await controller.dispatch(parsed.action);
      writeControllerResult(result, streams);
      lastExitCode = result.exitCode;
      if (result.kind === "exit") break;
      if (showPrompt) streams.stdout.write("> ");
    }
    if (cancellation) await cancellation;
    return requestedExitCode ?? lastExitCode;
  } finally {
    inputInterface.close();
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }
}

/** 执行已经通过 parser 校验的 CLI 命令。 */
async function executeInvocation(
  invocation: Extract<CliParseResult, { kind: "command" }>['invocation'],
  streams: CliMainStreams,
  dependencies: CliMainDependencies,
): Promise<CliExitCode> {
  const command = invocation.command;
  const workspaceRoot = invocation.host.workspaceRoot ?? (command.type === "project_open" ? command.path : undefined);
  const rootFactory = dependencies.createCompositionRoot ?? createCliCompositionRoot;
  const root = rootFactory({
    stateRoot: invocation.host.stateRoot,
    trustRoot: invocation.host.trustRoot,
    workspaceRoot,
    cwd: dependencies.cwd ?? process.cwd(),
  });
  root.ensureUserConfigDirectory();
  const signalSource = dependencies.signalSource ?? process;
  const input = streams.stdin ?? process.stdin;
  const hasTty = streams.stdout.isTTY === true && (streams.stdin?.isTTY ?? process.stdin.isTTY) === true;

  // Registry 只管理宿主级索引，不需要也不允许为 list/remove 建立 Runtime 或读取工作区配置。
  if (command.type === "project_list") {
    const entries = root.listWorkspaceRegistry().map(function toProjectListEntry(entry) {
      return { workspaceId: entry.workspaceId, displayName: entry.displayName, lastOpenedAt: entry.lastOpenedAt, available: fs.existsSync(entry.workspaceRoot) };
    }).sort(function sortRecent(left, right) { return right.lastOpenedAt - left.lastOpenedAt; });
    writeManagementResult(streams, entries);
    return 0;
  }
  if (command.type === "project_remove") {
    if (!root.removeWorkspaceRegistry(command.workspaceId)) {
      streams.stderr.write("WORKSPACE_REGISTRY_ENTRY_NOT_FOUND\n");
      return 1;
    }
    writeManagementResult(streams, `project registry removed: ${command.workspaceId}; source files, sessions, and trust were not deleted`);
    return 0;
  }

  // Trust 引导：先解析 canonical 工作区并读取信任状态；未信任时不创建 Runtime/Project/Session。
  const trust = await root.resolveTrust();
  if (command.type === "doctor") {
    writeDoctorResult(streams, await root.doctor(trust.workspaceRoot, command.connectivity));
    return 0;
  }
  if (command.type === "sandbox_status") {
    writeManagementResult(streams, await root.sandboxStatus(trust.workspaceRoot));
    return 0;
  }
  if (command.type === "trust_status") {
    writeManagementResult(streams, { status: trust.trustEntry.status });
    return 0;
  }
  if (command.type === "trust_revoke") {
    const revoked = await root.revokeTrust(trust.workspaceRoot);
    writeManagementResult(streams, `trust revoked: ${revoked.status}; future capability, Runtime, and Provider initialization is blocked`);
    return 0;
  }
  if (command.type === "project_current") {
    writeManagementResult(streams, { workspaceId: root.listWorkspaceRegistry().find(function isCurrent(entry) { return entry.workspaceRoot === trust.workspaceRoot; })?.workspaceId, trust: trust.trustEntry.status });
    return 0;
  }
  if (command.type === "config_show" || command.type === "config_get" || command.type === "config_set") {
    if (command.scope !== "user" && trust.trustEntry.status !== "trusted") {
      streams.stderr.write(`WORKSPACE_TRUST_REQUIRED: ${trust.trustEntry.status}\n`);
      return 1;
    }
    if (command.type === "config_show") writeManagementResult(streams, root.showConfig(command.scope, trust.workspaceRoot));
    if (command.type === "config_get") writeManagementResult(streams, { key: command.key, value: root.getConfig(command.scope, command.key, trust.workspaceRoot) });
    if (command.type === "config_set") writeManagementResult(streams, root.setConfig(command.scope, command.key, command.value, trust.workspaceRoot));
    return 0;
  }
  if (trust.trustEntry.status !== "trusted") {
    const interactive = (command.type === "project_open" || ("output" in command && command.output === "interactive")) && hasTty;
    if (!interactive) {
      streams.stderr.write(`WORKSPACE_TRUST_REQUIRED: ${trust.trustEntry.status}\n`);
      return 1;
    }
    const decision = await runCliTrustDialog({
      workspaceRoot: trust.workspaceRoot,
      streams: { stdout: streams.stdout, stdin: input as NodeJS.ReadStream },
      signalSource,
      env: process.env,
    });
    if (decision !== "granted") return 0;
    await root.grantTrust(trust.workspaceRoot);
    const confirmed = await root.getTrustStatus(trust.workspaceRoot);
    if (confirmed.status !== "trusted") {
      streams.stderr.write(`WORKSPACE_TRUST_REQUIRED: ${confirmed.status}\n`);
      return 1;
    }
  }
  root.ensureProjectAutopilotDirectory(trust.workspaceRoot);

  if (command.type === "sandbox_setup") {
    // Windows provision 属于系统级变更；UAC 结果经脱敏能力报告返回，不做自动重试。
    writeManagementResult(streams, await root.sandboxSetup(trust.workspaceRoot));
    return 0;
  }

  if (command.type === "mcp_list" || command.type === "mcp_approve" || command.type === "mcp_revoke") {
    const servers = await root.listMcp(trust.workspaceRoot);
    if (command.type === "mcp_list") {
      writeManagementResult(streams, servers.map(summarizeMcpServer));
      return 0;
    }
    const server = servers.find(function matchServer(item) { return item.serverName === command.serverName; });
    if (!server) throw new AgentRuntimeError("INVALID_INPUT", "MCP_SERVER_NOT_FOUND");
    if (command.type === "mcp_approve") {
      if (server.executionMode === "host") {
        streams.stderr.write("WARNING: MCP server will run directly on the host without OS sandbox isolation.\n");
      }
      const confirmed = command.yes || await confirmMcpApproval(streams, server);
      if (!confirmed) {
        streams.stderr.write("MCP_APPROVAL_CONFIRMATION_REQUIRED\n");
        return 1;
      }
      writeManagementResult(streams, { serverName: (await root.approveMcp(trust.workspaceRoot, server.serverName)).serverName, approved: true, executionMode: server.executionMode, isolation: server.isolation });
      return 0;
    }
    writeManagementResult(streams, { serverName: server.serverName, approved: false, revoked: await root.revokeMcp(trust.workspaceRoot, server.serverName) });
    return 0;
  }

  const runtime = await root.createRuntime(trust.workspaceRoot);
  try {

  if (command.type === "job_list" || command.type === "job_show" || command.type === "job_output" || command.type === "job_kill") {
    if (command.type === "job_list") {
      const jobs = await runtime.jobs.list(trust.workspaceRoot);
      const summaries = await Promise.all(jobs.map(async function summarizeIndependentJob(job) {
        const scoped = runtime.jobs.forSession({ workspaceId: trust.workspaceRoot, sessionId: job.sessionId });
        const read = await scoped.read({ jobId: job.id, waitMs: 0 });
        return summarizeJob(job, read.job);
      }));
      writeManagementResult(streams, summaries);
      return 0;
    }
    const found = await readIndependentJob(runtime, trust.workspaceRoot, command.jobId);
    if (command.type === "job_kill") {
      const stopped = await found.scoped.stop({ jobId: command.jobId, source: "host" });
      writeManagementResult(streams, { job: summarizeJob(found.job, stopped) });
      return 0;
    }
    writeManagementResult(streams, command.type === "job_output"
      ? { job: summarizeJob(found.job, found.read.job), output: found.read.output, waitOutcome: found.read.waitOutcome }
      : { job: summarizeJob(found.job, found.read.job) });
    return 0;
  }

  if (command.type === "undo") {
    if (!command.yes) {
      streams.stderr.write("UNDO_CONFIRMATION_REQUIRED: use --yes after reviewing an interactive /undo preview\n");
      return 2;
    }
    const session = await runtime.sessions.get(command.sessionId);
    if (!session) throw new AgentRuntimeError("SESSION_NOT_FOUND", `Session ${command.sessionId} 不存在`);
    const preview = await runtime.undo.preview({ sessionId: session.id });
    if (preview.status !== "available") {
      streams.stderr.write(`UNDO_NOT_AVAILABLE: ${preview.reason ?? "UNKNOWN"}\n`);
      return 1;
    }
    const completed = await runtime.undo.execute({ sessionId: session.id, confirmed: true });
    writeManagementResult(streams, completed);
    return completed.status === "completed" ? 0 : 1;
  }

  if (command.type === "project_open") {
    const project = await ensureProject(runtime, trust.workspaceRoot);
    streams.stdout.write(`project ready: ${project.id}\n`);
    return 0;
  }

  if (command.type === "session_list" || command.type === "session_rename" || command.type === "session_delete") {
    const project = await ensureProject(runtime, trust.workspaceRoot);
    const sessions = (await runtime.sessions.list())
      .filter(function inCurrentProject(item) { return !item.projectId || item.projectId === project.id; })
      .sort(function sortRecent(left, right) { return right.updatedAt - left.updatedAt; });
    if (command.type === "session_list") {
      writeManagementResult(streams, sessions.map(function summarizeSession(session) {
        return { id: session.id, title: session.title ?? "", status: session.status, updatedAt: session.updatedAt };
      }));
      return 0;
    }
    const session = sessions.find(function findSession(item) { return item.id === command.sessionId; });
    if (!session) throw new AgentRuntimeError("SESSION_NOT_FOUND", `Session ${command.sessionId} 不存在或不属于当前 Project`);
    if (command.type === "session_rename") {
      const renamed = await runtime.sessions.rename(session.id, command.title);
      writeManagementResult(streams, { id: renamed.id, title: renamed.title, updatedAt: renamed.updatedAt });
      return 0;
    }
    const confirmed = command.yes || await confirmSessionDelete(streams, session);
    if (!confirmed) {
      streams.stderr.write("SESSION_DELETE_CONFIRMATION_REQUIRED: pass --yes in non-interactive mode\n");
      return 2;
    }
    const deleted = await runtime.sessions.delete(session.id);
    writeManagementResult(streams, { id: session.id, deleted });
    return 0;
  }

  if (command.type !== "chat" && command.type !== "resume") {
    throw new AgentRuntimeError("INVALID_INPUT", "不支持的 CLI 管理命令");
  }

  const configurationError = root.getStartupConfigurationError?.();
  if (configurationError) {
    streams.stderr.write(`${configurationError}\n`);
    return 1;
  }

  const project = await ensureProject(runtime, trust.workspaceRoot);
  const session = command.type === "resume"
    ? await selectResumeSession(runtime, project, command.sessionId)
    : await ensureChatSession(runtime, project, command.sessionId, command.prompt);
  const renderer = command.output === "interactive" && hasTty
    ? { format: "text" as const, render: function renderTuiEvent(): string { return ""; } }
    : createPlainRenderer(command.output === "jsonl" ? "jsonl" : "text");
  const controller = createCliController({
    runtime,
    renderer,
    sessionId: session.id,
    workspaceRoot: trust.workspaceRoot,
    getRuntimeStatusDefaults: root.getRuntimeStatusDefaults,
    listSkills: root.listSkills,
    resolveSkill: root.resolveSkill,
  });

  const recoverable = command.type === "chat" && !command.prompt
    ? await runtime.turns.getRecoverableState({ sessionId: session.id })
    : undefined;
  if (recoverable?.recoverable && recoverable.status === "awaiting_user_input") {
    const blocked = await controller.resume();
    writeControllerResult(blocked, streams);
    return blocked.exitCode;
  }

  if (command.output === "interactive" && hasTty) {
    const initial = command.type === "resume"
      ? { type: "resume" as const }
      : command.prompt
        ? { type: "start" as const, content: command.prompt }
        : undefined;
    const tuiResult = await runCliTui({
      controller,
      sessionId: session.id,
      workspaceRoot: trust.workspaceRoot,
      streams: {
        stdout: streams.stdout,
        stderr: streams.stderr,
        stdin: input as NodeJS.ReadStream,
      },
      signalSource,
      initial,
      closeWhenIdle: initial !== undefined,
      env: process.env,
      forceExit: dependencies.forceExit ?? function forceProcessExit(code): void { process.exit(code); },
    });
    return tuiResult.exitCode;
  }

  streams.stderr.write(`${WEB_SEARCH_DATA_FLOW_NOTICE}\n`);
  const effectiveOutput: CliOutputFormat = command.output === "interactive" ? "text" : command.output;
  const showPlainPrompt = command.output !== "interactive" && effectiveOutput !== "jsonl";

  if (command.type === "chat" && command.prompt) {
    const executed = await runWithSignals(controller, function startPrompt() {
      return controller.dispatch({ type: "submit_prompt", content: command.prompt! });
    }, signalSource);
    writeControllerResult(executed.result, streams);
    if (executed.result.projection.status === "waiting_approval" && effectiveOutput !== "jsonl") {
      return runInputLoop(controller, effectiveOutput, streams, signalSource, showPlainPrompt);
    }
    return executed.exitCode;
  }

  if (command.type === "chat") return runInputLoop(controller, effectiveOutput, streams, signalSource, showPlainPrompt);

  const resumed = await runWithSignals(controller, function resumeTurn() {
    return controller.resume();
  }, signalSource);
  writeControllerResult(resumed.result, streams);
  if (resumed.result.projection.status === "waiting_approval" && effectiveOutput !== "jsonl") {
    return runInputLoop(controller, effectiveOutput, streams, signalSource, showPlainPrompt);
  }
  return resumed.exitCode;
  } finally {
    await runtime.shutdown?.();
  }
}

/** 执行 Step 5.3 CLI 入口并返回固定退出码。 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  streams: CliMainStreams = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  dependencies: CliMainDependencies = {},
): Promise<CliExitCode> {
  const parsed = parseArgv(argv);
  if (parsed.kind === "help") {
    streams.stdout.write(`${parsed.text}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    streams.stderr.write(`${parsed.message}\n\n${renderHelp()}\n`);
    return 2;
  }
  try {
    return await executeInvocation(parsed.invocation, streams, dependencies);
  } catch (error) {
    streams.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(function finish(exitCode: CliExitCode) {
    process.exitCode = exitCode;
  });
}
