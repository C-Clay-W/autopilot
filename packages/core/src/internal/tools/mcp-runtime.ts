/**
 * MCP stdio Runtime：在精确授权后启动本机 server，桥接 JSON-RPC 与统一 ToolRegistry。
 * server 描述只能定义模型 schema，不能改变本地 PolicyEngine 的安全结论。
 *
 * Talk-Plan1013 Stage 3：host 无法限制隐藏外部写，明确阻塞；只有显式 sandbox
 * 才能进入启动链。server grant 不转换为外部文件写 capability。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SandboxPolicy, SandboxPreparedCommand } from "../../runtime/domain/sandbox-policy";
import type { CredentialStore, SandboxPort } from "../../runtime/ports";
import { getMcpServerGrantConstraint, type McpCapability, type McpServerConfig } from "../../runtime/protocol";
import { getPlatformExecutable } from "./process-utils";
import { resolveSandboxPolicy } from "./sandbox-policy-resolver";
import { decideCommandPermission, normalizeProgramName } from "./permissions/command-policy";
import { resolveFileTarget } from "./permissions/path-access-policy";
import { createToolError, TOOL_ERROR_CODES } from "./tool-error";
import type { AgentToolDefinition, SandboxExecutionBinding, SandboxExecutionScope, ToolActionFacts, ToolExecutionContext, ToolPermissionMode } from "./types";
import { PolicyEngine } from "./policy-engine";

const MCP_CALL_TIMEOUT_MS = 30_000;
const MCP_RESPONSE_LIMIT_BYTES = 60_000;
const MCP_LINE_LIMIT_BYTES = 60_000;

/** 按平台环境变量命名规则写入单个子进程变量；Windows 同名不同大小写时由后写值覆盖。 */
function setEnvironmentEntry(env: NodeJS.ProcessEnv, key: string, value: string | undefined, caseInsensitive: boolean): void {
  if (caseInsensitive) {
    for (const existingKey of Object.keys(env)) {
      if (existingKey !== key && existingKey.toUpperCase() === key.toUpperCase()) delete env[existingKey];
    }
  }
  env[key] = value;
}

/** MCP server 生命周期；不会向模型暴露原始 stderr、路径或环境变量。 */
export type McpServerState = "configured" | "starting" | "ready" | "degraded" | "failed" | "stopped";

/** 无授权、配置冲突、沙箱拒绝或连接失败时给宿主的脱敏诊断。 */
export interface McpRuntimeDiagnostic {
  serverName: string;
  code: "MCP_SERVER_APPROVAL_REQUIRED" | "MCP_SERVER_DENIED" | "MCP_SERVER_SANDBOX_FAILED" | "MCP_SERVER_FAILED" | "MCP_TOOL_CONFLICT";
}

/** 为 Runtime 注入 MCP 所需的受控能力；CredentialStore 只在 spawn 前按需解析。 */
export interface McpRuntimeOptions {
  capability: McpCapability;
  workspaceRoot?: string;
  workspaceTrusted?: boolean;
  resolvePersistentGrant?: ToolExecutionContext["resolvePersistentGrant"];
  credentialStore?: CredentialStore;
  /** 当前 Turn 冻结的沙箱绑定；只供显式 sandbox 模式使用，缺失或不可执行时不启动。 */
  sandbox?: SandboxExecutionBinding;
  /** 宿主冻结的审批模式；仅参与沙箱正交组合判定，不放宽隔离。 */
  permissionMode?: ToolPermissionMode;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ManagedServer {
  config: McpServerConfig;
  state: McpServerState;
  child?: ChildProcess;
  /** 已 prepare 的沙箱执行资源；与 server 进程同生共死，真实终态（崩溃/关闭/启动失败）时释放。 */
  executionId?: string;
  pending: Map<number, PendingRequest>;
  buffer: Buffer;
}

/** 将 JSON 文本裁剪到 UTF-8 字节上限，绝不以 UTF-16 code unit 截断。 */
function truncateUtf8(value: string, limitBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limitBytes) return value;
  for (let length = Math.min(limitBytes, bytes.length); length >= Math.max(0, limitBytes - 3); length -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch { /* 去掉未完成的多字节字符后重试。 */ }
  }
  return "";
}

/** 将进入模型的 MCP 结果限制为完整 JSON 的 UTF-8 字节预算。 */
function serializeMcpOutput(output: unknown): unknown {
  const serialized = JSON.stringify(output) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= MCP_RESPONSE_LIMIT_BYTES) return output;
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ content: "", truncated: true }), "utf8");
  return { content: truncateUtf8(serialized, MCP_RESPONSE_LIMIT_BYTES - wrapperBytes), truncated: true };
}

/** MCP server 启动的本地事实；与 run_command 共用命令风险与 hard deny 底座。 */
export function createMcpServerStartActionFacts(server: McpServerConfig): ToolActionFacts {
  const command = decideCommandPermission(server.command, server.args ?? []);
  return {
    toolName: "mcp_server_start",
    effect: command.risk === "read_only" ? "none" : command.risk === "workspace_mutating" ? "workspace" : "external",
    destructive: command.risk === "destructive",
    operation: "mcp_server_start",
    resource: normalizeProgramName(server.command),
    risk: command.risk,
    stableConstraint: getMcpServerGrantConstraint(server),
    hardDenyReason: command.decision === "deny" ? command.reason : undefined,
    requiresApproval: command.decision !== "deny",
    approval: { reason: command.reason, preview: { serverName: server.name, program: server.command, args: server.args ?? [], cwd: server.cwd ?? "." } },
  };
}

/** 将 server/tool 名称归一化为 ToolRegistry 可接受且稳定的命名空间。 */
function getMcpToolName(serverName: string, toolName: string): string {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "") || "tool";
  return `mcp__${normalize(serverName)}__${normalize(toolName)}`.slice(0, 64);
}

/** 按平台终止 MCP server 及其子进程树，timeout/cancel 后绝不保留孤儿进程。 */
function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** 创建单个受控 MCP stdio runtime；initialize 必须在模型第一次采样前完成。 */
export class McpStdioRuntime {
  private readonly policyEngine = new PolicyEngine();
  private readonly servers = new Map<string, ManagedServer>();
  private readonly tools: AgentToolDefinition<unknown, unknown>[] = [];
  private readonly diagnostics: McpRuntimeDiagnostic[] = [];
  private nextRequestId = 1;

  constructor(private readonly options: McpRuntimeOptions) {
    for (const config of options.capability.servers.filter((server) => server.enabled !== false)) {
      this.servers.set(config.name, { config, state: "configured", pending: new Map(), buffer: Buffer.alloc(0) });
    }
  }

  /** 启动已获精确 workspace grant 的 server，并产出可注册的统一 ToolDefinition。 */
  async initialize(): Promise<void> {
    for (const server of this.servers.values()) await this.initializeServer(server);
  }

  /** 返回仅在 ready server 上可见的 MCP ToolDefinition；调用方照常注册到 ToolRegistry。 */
  getToolDefinitions(): readonly AgentToolDefinition<unknown, unknown>[] { return this.tools; }

  /** 返回脱敏的 server 状态，供 CLI/Doctor 展示。 */
  getServerStates(): Array<{ serverName: string; state: McpServerState; executionMode: "sandbox" | "host"; isolation: "sandboxed" | "unisolated" }> {
    return [...this.servers.values()].map((server) => ({
      serverName: server.config.name,
      state: server.state,
      executionMode: getMcpExecutionMode(server.config),
      isolation: getMcpIsolation(server.config),
    }));
  }

  /** 返回启动期诊断；不含 command、cwd、stderr 或环境变量。 */
  getDiagnostics(): readonly McpRuntimeDiagnostic[] { return this.diagnostics; }

  /** 正常关闭全部 server；先发 shutdown，超时后清理完整进程树，并释放沙箱执行资源。 */
  async shutdown(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async (server) => {
      if (!server.child || server.state === "stopped") return;
      try { await this.request(server, "shutdown", {}, 1_000); } catch { /* 超时后强制结束。 */ }
      terminateProcessTree(server.child);
      server.state = "stopped";
      this.releaseSandbox(server);
    }));
  }

  /** 依次执行 grant、Policy、spawn、initialize 与 tools/list；任一步失败仅降级当前 server。 */
  private async initializeServer(server: ManagedServer): Promise<void> {
    if (this.options.workspaceTrusted !== true || !this.options.workspaceRoot) {
      this.diagnostics.push({ serverName: server.config.name, code: "MCP_SERVER_DENIED" });
      return;
    }
    const facts = createMcpServerStartActionFacts(server.config);
    const grantMatched = await this.options.resolvePersistentGrant?.({
      toolName: facts.toolName,
      inputHash: facts.stableConstraint ?? "",
      input: { serverName: server.config.name },
      constraint: facts.stableConstraint,
      risk: facts.risk,
    }) === true;
    const policy = this.policyEngine.evaluate({
      context: { workspaceRoot: this.options.workspaceRoot, workspaceTrusted: this.options.workspaceTrusted, permissionMode: "ask" },
      metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
      facts,
      grantMatched,
    });
    if (policy.decision !== "allow") {
      this.diagnostics.push({ serverName: server.config.name, code: policy.decision === "deny" ? "MCP_SERVER_DENIED" : "MCP_SERVER_APPROVAL_REQUIRED" });
      return;
    }
    // server grant 不能为未隔离进程授予全盘修改能力；host 必须在 spawn 前明确阻塞。
    if (getMcpExecutionMode(server.config) === "host") {
      server.state = "failed";
      this.diagnostics.push({ serverName: server.config.name, code: "MCP_SERVER_SANDBOX_FAILED" });
      return;
    }
    try {
      server.state = "starting";
      const cwd = await resolveFileTarget(this.options.workspaceRoot, server.config.cwd ?? ".");
      if (!cwd.exists) throw new Error("MCP_CWD_INVALID");
      let executable: string;
      let args: string[];
      let prepared: SandboxPreparedCommand | undefined;
      {
        // sandbox 为默认路径；准备失败时只拒绝，不切换为 host。
        const scope = await this.resolveSandboxScope();
        if (!scope) {
          this.diagnostics.push({ serverName: server.config.name, code: "MCP_SERVER_SANDBOX_FAILED" });
          server.state = "failed";
          return;
        }
        const program = getPlatformExecutable(server.config.command);
        try {
          prepared = await scope.port.prepare({
            commandId: randomUUID(),
            program,
            args: server.config.args ?? [],
            cwd: cwd.canonicalTarget,
            policy: scope.policy,
          });
        } catch {
          // 沙箱拒绝/runner 失败只影响本 server；诊断使用稳定码，不透出底层平台文案。
          this.diagnostics.push({ serverName: server.config.name, code: "MCP_SERVER_SANDBOX_FAILED" });
          server.state = "failed";
          return;
        }
        server.executionId = prepared.executionId;
        executable = prepared.executable;
        args = [...prepared.args];
      }
      const childEnvironment = await this.resolveEnvironment(server.config);
      for (const [key, value] of Object.entries(prepared?.env ?? {})) {
        setEnvironmentEntry(childEnvironment, key, value, process.platform === "win32");
      }
      const child = spawn(executable, [...args], {
        cwd: cwd.canonicalTarget,
        // 受控 env 为底，沙箱注入的同名变量按平台规则覆盖；server 不继承完整宿主环境。
        env: childEnvironment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      server.child = child;
      child.stdout?.on("data", (chunk: Buffer) => this.handleOutput(server, chunk));
      child.on("error", () => this.failServer(server));
      child.on("exit", () => this.failServer(server));
      await this.request(server, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "autopilot", version: "1" } }, MCP_CALL_TIMEOUT_MS);
      this.notify(server, "notifications/initialized", {});
      const result = await this.request(server, "tools/list", {}, MCP_CALL_TIMEOUT_MS) as { tools?: unknown };
      const descriptors = Array.isArray(result?.tools) ? result.tools.filter((item): item is McpToolDescriptor => this.isToolDescriptor(item)) : [];
      const names = new Set<string>();
      for (const descriptor of descriptors) {
        const name = getMcpToolName(server.config.name, descriptor.name);
        if (names.has(name) || this.tools.some((tool) => tool.name === name)) throw new Error("MCP_TOOL_CONFLICT");
        names.add(name);
        this.tools.push(this.createToolDefinition(server, descriptor, name));
      }
      server.state = "ready";
    } catch (error) {
      this.diagnostics.push({ serverName: server.config.name, code: (error as Error).message === "MCP_TOOL_CONFLICT" ? "MCP_TOOL_CONFLICT" : "MCP_SERVER_FAILED" });
      this.failServer(server);
    }
  }

  /** 仅接受 MCP tools/list 的最小受控字段，避免 server 任意对象影响 Runtime 定义。 */
  private isToolDescriptor(value: unknown): value is McpToolDescriptor {
    return Boolean(value) && typeof value === "object" && typeof (value as McpToolDescriptor).name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test((value as McpToolDescriptor).name);
  }

  /** 将远端 schema 转为本地 Zod；失败时拒绝该 server，而不是退化为无约束输入。 */
  private createToolDefinition(server: ManagedServer, descriptor: McpToolDescriptor, name: string): AgentToolDefinition<unknown, unknown> {
    let inputSchema: z.ZodType;
    try { inputSchema = z.fromJSONSchema(descriptor.inputSchema ?? { type: "object", additionalProperties: false }); }
    catch { throw new Error("MCP_TOOL_SCHEMA_INVALID"); }
    const runtime = this;
    return {
      name,
      description: descriptor.description?.slice(0, 1_000) || `MCP 工具 ${descriptor.name}`,
      inputSchema,
      metadata: { effect: "external", destructive: false, concurrency: { max: 1, resourceKey: `mcp:${server.config.name}` }, retry: { safe: false }, timeout: { defaultMs: MCP_CALL_TIMEOUT_MS, maxMs: MCP_CALL_TIMEOUT_MS } },
      createActionFacts(input) {
        return { toolName: name, effect: "external", destructive: false, operation: "mcp_tools_call", resource: server.config.name, risk: "external_side_effect", executionIsolation: getMcpIsolation(server.config), requiresApproval: true, approval: { reason: "MCP 外部工具调用需要用户审批", preview: { serverName: server.config.name, toolName: descriptor.name, input } } };
      },
      async execute(input, context) {
        if (server.state !== "ready") throw createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, "MCP server 当前不可用");
        const onAbort = () => { if (server.child) terminateProcessTree(server.child); };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        try { return await runtime.request(server, "tools/call", { name: descriptor.name, arguments: input }, MCP_CALL_TIMEOUT_MS); }
        finally { context.signal?.removeEventListener("abort", onAbort); }
      },
      serializeOutput(output) {
        return serializeMcpOutput(output);
      },
    };
  }

  /** 构造受控子进程环境；Windows 只继承 PATH 与四个启动系统变量，其他 libuv 必需变量及 TMP 用空值中和。 */
  private async resolveEnvironment(server: McpServerConfig): Promise<NodeJS.ProcessEnv> {
    const isWindows = process.platform === "win32";
    const env: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
    if (isWindows) {
      for (const key of ["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT"] as const) {
        const value = process.env[key];
        if (value !== undefined) setEnvironmentEntry(env, key, value, true);
      }
      for (const key of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR", "TMP"] as const) {
        let exists = false;
        for (const existingKey of Object.keys(env)) {
          if (existingKey.toUpperCase() === key) {
            exists = true;
            break;
          }
        }
        if (!exists) setEnvironmentEntry(env, key, "", true);
      }
    }
    for (const [key, value] of Object.entries(server.env ?? {})) {
      const resolvedValue = typeof value === "string" ? value : (await this.options.credentialStore?.resolve(value.credentialRef))?.apiKey;
      if (!resolvedValue) throw new Error("MCP_CREDENTIAL_UNAVAILABLE");
      setEnvironmentEntry(env, key, resolvedValue, isWindows);
    }
    return env;
  }

  /** 向 stdio 写入一条 JSON-RPC request，并在超时、崩溃或无效响应时稳定失败。 */
  private request(server: Pick<ManagedServer, "child" | "pending">, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!server.child?.stdin?.writable) return Promise.reject(new Error("MCP_SERVER_UNAVAILABLE"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { server.pending.delete(id); reject(new Error("MCP_REQUEST_TIMEOUT")); }, timeoutMs);
      server.pending.set(id, { resolve(value) { clearTimeout(timeout); resolve(value); }, reject(error) { clearTimeout(timeout); reject(error); } });
      server.child!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** 发送无需响应的 JSON-RPC 通知，初始化完成后按 MCP 协议通知 server。 */
  private notify(server: Pick<ManagedServer, "child">, method: string, params: unknown): void {
    server.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** 按 JSONL 边界读取响应；任何单行在 JSON.parse 前都不能超过硬字节上限。 */
  private handleOutput(server: ManagedServer, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        this.appendOutputFragment(server, chunk.subarray(offset));
        return;
      }
      const fragment = chunk.subarray(offset, newline);
      if (server.buffer.length + fragment.length > MCP_LINE_LIMIT_BYTES) {
        this.failServer(server);
        return;
      }
      const line = Buffer.concat([server.buffer, fragment]);
      server.buffer = Buffer.alloc(0);
      this.handleLine(server, line);
      offset = newline + 1;
    }
  }

  /** 追加尚未换行的响应分片，超过预算立即关闭 server，避免无限缓冲。 */
  private appendOutputFragment(server: ManagedServer, fragment: Buffer): void {
    if (server.buffer.length + fragment.length > MCP_LINE_LIMIT_BYTES) {
      this.failServer(server);
      return;
    }
    server.buffer = Buffer.concat([server.buffer, fragment]);
  }

  /** 解析一条已经受限的 JSON-RPC 行；无关噪声不会进入模型、日志或诊断。 */
  private handleLine(server: ManagedServer, line: Buffer): void {
    try {
      const message = JSON.parse(line.toString("utf8")) as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof message.id !== "number") return;
      const pending = server.pending.get(message.id);
      if (!pending) return;
      server.pending.delete(message.id);
      if (message.error) pending.reject(new Error("MCP_REMOTE_ERROR")); else pending.resolve(message.result);
    } catch { /* server 噪声严格丢弃。 */ }
  }

  /** server 崩溃只影响本 capability，拒绝在途请求且不影响内置工具。 */
  private failServer(server: Pick<ManagedServer, "state" | "child" | "pending" | "executionId">): void {
    if (server.state === "stopped") return;
    server.state = "failed";
    for (const pending of server.pending.values()) pending.reject(new Error("MCP_SERVER_FAILED"));
    server.pending.clear();
    if (server.child) terminateProcessTree(server.child);
    this.releaseSandbox(server);
  }

  /** 解析 MCP server 启动的沙箱范围；绑定缺失或能力不可执行时返回 undefined（fail-closed，不裸跑）。 */
  private async resolveSandboxScope(): Promise<SandboxExecutionScope | undefined> {
    const binding = this.options.sandbox;
    if (!binding) return undefined;
    const capability = await binding.port.status();
    const resolution = resolveSandboxPolicy({
      mode: binding.mode,
      workspaceRoot: this.options.workspaceRoot,
      tempRoot: binding.tempRoot,
      capability,
      permissionMode: this.options.permissionMode ?? "ask",
      workspaceTrusted: this.options.workspaceTrusted === true,
    });
    if (!resolution.executable) return undefined;
    return { port: binding.port, policy: resolution.policy };
  }

  /** 释放已 prepare 的沙箱执行资源；幂等，server 真实终态（崩溃/关闭）时调用。 */
  private releaseSandbox(server: Pick<ManagedServer, "executionId">): void {
    const executionId = server.executionId;
    const port = this.options.sandbox?.port;
    if (!executionId || !port) return;
    server.executionId = undefined;
    void port.release(executionId).catch(function ignoreCleanupFailure() { /* release 契约幂等不抛；防御 Port 实现异常。 */ });
  }
}

/** 返回 MCP 执行方式；只有显式 sandbox 才进入沙箱，缺省和 host 均按 host 处理。 */
function getMcpExecutionMode(server: McpServerConfig): "sandbox" | "host" {
  return server.execution === "sandbox" ? "sandbox" : "host";
}

/** 返回本地 MCP server 实际采用的隔离事实，供脱敏状态和工具审批展示。 */
function getMcpIsolation(server: McpServerConfig): "sandboxed" | "unisolated" {
  return getMcpExecutionMode(server) === "host" ? "unisolated" : "sandboxed";
}
