/**
 * P4 工具层基础测试：覆盖 Schema、审批、拒绝、取消与受控文件读写的核心终态。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createRAGAgent } from "../../index";
import { createReadFileTool } from "./builtins/read-file-tool";
import { createEditFileTool } from "./builtins/edit-file-tool";
import { MAX_TEXT_LINE_CHARACTERS, MAX_TEXT_SCAN_BYTES } from "./builtins/text-read-limits";
import { createRunCommandTool } from "./builtins/run-command-tool";
import { createWriteFileTool } from "./builtins/write-file-tool";
import { ToolExecutor } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";
import type { SandboxExecutionBinding } from "./types";
import { SandboxPortError } from "../../runtime/ports";
import type { SandboxPort } from "../../runtime/ports";
import { SANDBOX_ERROR_CODES, type SandboxMode, type SandboxPolicy } from "../../runtime/domain/sandbox-policy";

const temporaryRoots: string[] = [];
const securityFixtureRoot = path.resolve(process.cwd(), "../../test/fixtures/security");

/** 透传式 fake 沙箱 Port：prepare 原样返回 argv（不包装），记录调用供测试断言。 */
function createFakeSandboxPort(options: { enforcement?: "full" | "partial" | "unavailable" } = {}) {
  const enforcement = options.enforcement ?? "full";
  const prepared: Array<{ program: string; cwd: string; mode: SandboxMode }> = [];
  const released: string[] = [];
  const port: SandboxPort = {
    async status() {
      return { platform: "macos", backend: "fake", enforcement };
    },
    async setup() {
      throw new Error("fake sandbox setup 不可用");
    },
    async prepare(request) {
      prepared.push({ program: request.program, cwd: request.cwd, mode: request.policy.mode });
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement };
    },
    async release(executionId) {
      released.push(executionId);
    },
    async shutdown() {},
  };
  return { port, prepared, released };
}

/** 构造绑定指定工作区的默认沙箱 binding（透传 fake）。 */
function createFakeSandboxBinding(workspaceRoot: string, mode: SandboxMode = "workspace-write"): SandboxExecutionBinding {
  return { port: createFakeSandboxPort().port, mode };
}

/** 构造与 fake binding 对应的已解析执行范围，供绕过 ToolExecutor 的直接工具调用使用。 */
function createFakeSandboxScope(workspaceRoot: string, port: SandboxPort, mode: SandboxMode = "workspace-write"): { port: SandboxPort; policy: SandboxPolicy } {
  return { port, policy: { mode, workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] } };
}

/** 创建独立临时工作区，使文件工具测试不接触真实项目文件。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rag-next-p4-"));
  temporaryRoots.push(root);
  return root;
}

/** 等待子进程 fixture 写入 PID，避免依赖不稳定的固定延时。 */
async function waitForFixtureFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise<void>(function wait(resolve) { setTimeout(resolve, 20); });
    }
  }
  throw new Error(`fixture 未在预期时间写入: ${filePath}`);
}

/** 确认指定 PID 已退出，避免 timeout/cancel 仅杀父进程而留下孤儿子进程。 */
async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>(function wait(resolve) { setTimeout(resolve, 20); });
  }
  return false;
}

/** 清理测试异常时残留的 fixture 进程，防止失败用例污染后续回归。 */
function stopFixtureProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 子进程已退出时无需额外处理。
  }
}

/** 创建标准 Agent 文件与命令工具执行器；默认注入透传 fake 沙箱，传 null 模拟未装配 backend。 */
function createAgentToolExecutor(
  workspaceRoot: string,
  permissionMode: "ask" | "auto_approve" | "full_access" = "ask",
  workspaceTrusted = false,
  sandbox?: SandboxExecutionBinding | null,
): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createEditFileTool());
  registry.register(createWriteFileTool());
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode,
    workspaceTrusted,
    fileReadStates: new Map(),
    agentFlow: {
      async search() { return []; },
      async searchAcrossTables() { return { results: [] }; },
    },
    ...(sandbox === undefined ? { sandbox: createFakeSandboxBinding(workspaceRoot) } : sandbox !== null ? { sandbox } : {}),
  });
}

/** 清理每个测试创建的临时工作区，避免留下测试副作用。 */
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P4 工具执行器", () => {
  it("仅向模型暴露安全工具定义并拒绝未知工具", async () => {
    const agent = createRAGAgent();
    const definitions = agent.getToolDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual(["read_file"]);
    expect(definitions[0]).not.toHaveProperty("execute");
    const result = await agent.executeTool({ callId: "unknown-1", toolName: "unknown_tool", input: {} });
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("TOOL_NOT_FOUND");
  });

  it("仅在标准 Agent Runtime 注册文件发现工具", async () => {
    const rag = createRAGAgent();
    const agent = createAgent({ rag });
    expect(rag.getToolDefinitions().map((definition) => definition.name)).toEqual(["read_file"]);
    expect(agent.getToolDefinitions().map((definition) => definition.name)).toEqual([
      "glob_files",
      "grep_files",
      "read_file",
      "edit_file",
      "write_file",
      "run_command",
      "todo_write",
    ]);
    expect(agent.getToolDefinitions().find((definition) => definition.name === "run_command")?.description).toContain("不得改用功能等价的内置工具绕过审批");
    expect(agent.getToolDefinitions().find((definition) => definition.name === "grep_files")?.description).toContain("用户明确要求执行某个命令时必须遵从原请求");
  });

  it("为新建和覆写生成审批，并只接受冻结输入对应的 allow_once", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot);
    const createPending = await executor.execute({ callId: "create-1", toolName: "write_file", input: { path: "note.txt", content: "first" } });
    expect(createPending.status).toBe("approval_required");
    if (createPending.status !== "approval_required") throw new Error("expected create approval request");
    const created = await executor.execute({
      callId: "create-1",
      toolName: "write_file",
      input: { path: "note.txt", content: "first" },
      approval: { approvalId: createPending.approval.approvalId, decision: "allow_once" },
    });
    expect(created.status).toBe("success");
    const read = await executor.execute({ callId: "read-1", toolName: "read_file", input: { path: "note.txt", limit: 1000 } });
    expect(read.status).toBe("success");
    const hash = read.status === "success" ? String((read.output as { sha256: string }).sha256) : "";
    const pending = await executor.execute({ callId: "update-1", toolName: "write_file", input: { path: "note.txt", content: "second", expectedSha256: hash } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const mismatched = await executor.execute({
      callId: "update-1",
      toolName: "write_file",
      input: { path: "note.txt", content: "tampered", expectedSha256: hash },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(mismatched.status === "error" && mismatched.error.code).toBe("APPROVAL_MISMATCH");
    const completed = await executor.execute({
      callId: "update-1",
      toolName: "write_file",
      input: { path: "note.txt", content: "second", expectedSha256: hash },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(completed.status).toBe("success");
    expect(await readFile(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("second");
  });

  it("按命令副作用和工作区信任执行权限矩阵（Stage 3 起已确认可沙箱的调用在 auto_approve+Trust 下自动放行）", async function enforcesCommandModeMatrix() {
    const workspaceRoot = await createTemporaryWorkspace();
    let persistentGrantChecks = 0;
    const registry = new ToolRegistry();
    registry.register(createRunCommandTool());
    const askSandbox = createFakeSandboxPort();
    const askExecutor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "ask",
      workspaceTrusted: false,
      sandbox: { port: askSandbox.port, mode: "workspace-write" },
      resolvePersistentGrant: async function resolvePersistentGrant() {
        // 模拟无已存授权的授权库：ask 下仍会查询（新行为），但未命中必须逐次审批。
        persistentGrantChecks += 1;
        return false;
      },
      agentFlow: {
        async search() { return []; },
        async searchAcrossTables() { return { results: [] }; },
      },
    });
    const unknownCommand = { program: "node", args: ["-e", "process.stdout.write('ok')"], cwd: "." };

    const first = await askExecutor.execute({ callId: "command-ask-1", toolName: "run_command", input: unknownCommand });
    expect(first.status).toBe("approval_required");
    expect(first.status === "approval_required" && first.approval.risk).toBe("unknown");
    // 2.2：ask 下改为查询持久授权（精确命令约束），未命中仍逐次审批。
    expect(persistentGrantChecks).toBe(1);
    if (first.status !== "approval_required") throw new Error("expected approval request");
    expect(first.approval.allowedDecisions).toContain("allow_workspace");
    const allowed = await askExecutor.execute({ callId: "command-ask-1", toolName: "run_command", input: unknownCommand, approval: { approvalId: first.approval.approvalId, decision: "allow_once" } });
    expect(allowed.status).toBe("success");
    expect(askSandbox.prepared).toHaveLength(1);
    expect(askSandbox.released).toHaveLength(1);

    const second = await askExecutor.execute({ callId: "command-ask-2", toolName: "run_command", input: unknownCommand });
    expect(second.status).toBe("approval_required");
    // 每次执行（含携带 allow_once 审批的那次）都查询一次持久授权。
    expect(persistentGrantChecks).toBe(3);

    const readOnly = await createAgentToolExecutor(workspaceRoot, "auto_approve", false)
      .execute({ callId: "command-read-only", toolName: "run_command", input: { program: "git", args: ["status"], cwd: "." } });
    expect(readOnly.status).toBe("success");

    const untrustedMutation = await createAgentToolExecutor(workspaceRoot, "auto_approve", false)
      .execute({ callId: "command-untrusted-mutation", toolName: "run_command", input: { program: "mkdir", args: ["untrusted-directory"], cwd: "." } });
    expect(untrustedMutation.status).toBe("approval_required");
    expect(untrustedMutation.status === "approval_required" && untrustedMutation.approval.risk).toBe("workspace_mutating");

    const trustedMutation = await createAgentToolExecutor(workspaceRoot, "auto_approve", true)
      .execute({ callId: "command-trusted-mutation", toolName: "run_command", input: { program: "git", args: ["add", "tracked.txt"], cwd: "." } });
    expect(trustedMutation.status).toBe("success");

    // G4：已确认可在沙箱内执行（fake enforcement=full）时，外部副作用与未知风险在
    // auto_approve + Trust 下自动放行；成功结果必须携带安全沙箱事实。
    const external = await createAgentToolExecutor(workspaceRoot, "auto_approve", true)
      .execute({ callId: "command-external", toolName: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('ext')"], cwd: "." } });
    expect(external.status).toBe("success");
    expect(external.status === "success" && (external.output as { sandbox?: unknown }).sandbox).toEqual({ enforcement: "full", mode: "workspace-write" });

    const outside = await createAgentToolExecutor(workspaceRoot, "auto_approve", true)
      .execute({ callId: "command-outside", toolName: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('outside-ok')", "/outside-probe"], cwd: "." } });
    expect(outside.status).toBe("success");

    const automaticUnknown = await createAgentToolExecutor(workspaceRoot, "auto_approve", true)
      .execute({ callId: "command-auto-unknown", toolName: "run_command", input: unknownCommand });
    expect(automaticUnknown.status).toBe("success");

    const fullAccess = await createAgentToolExecutor(workspaceRoot, "full_access", false)
      .execute({ callId: "command-full-access", toolName: "run_command", input: unknownCommand });
    expect(fullAccess.status).toBe("success");
  });

  it("ask 下记住的精确命令自动放行；参数变化生成新约束必须重新审批（2.2）", async function allowsRememberedCommandGrantInAskMode() {
    const workspaceRoot = await createTemporaryWorkspace();
    const registry = new ToolRegistry();
    registry.register(createRunCommandTool());
    const seenConstraints: string[] = [];
    // 模拟授权库：只有被"记住"（加入集合）的精确约束才命中。
    const rememberedConstraints = new Set<string>();
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "ask",
      workspaceTrusted: false,
      sandbox: { port: createFakeSandboxPort().port, mode: "workspace-write" },
      resolvePersistentGrant: async function resolvePersistentGrant(request) {
        seenConstraints.push(request.constraint ?? "");
        return rememberedConstraints.has(request.constraint ?? "");
      },
      agentFlow: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; } },
    });
    const command = { program: "node", args: ["-e", "process.stdout.write('ok')"], cwd: "." };

    const first = await executor.execute({ callId: "remembered-1", toolName: "run_command", input: command });
    expect(first.status).toBe("approval_required");
    // 授权库收到 cmd:v2 精确约束（绑定平台、平台解析后的程序身份、完整 argv 与 canonical cwd）；
    // 旧 program: 宽约束不再出现，会合并 POSIX 程序身份的 cmd:v1 也已停止签发（CR 20261016 R6）。
    expect(seenConstraints).toHaveLength(1);
    expect(seenConstraints[0].startsWith("cmd:v2:")).toBe(true);
    if (first.status !== "approval_required") throw new Error("expected approval request");
    expect(first.approval.allowedDecisions).toEqual(["allow_once", "allow_workspace", "deny"]);
    rememberedConstraints.add(seenConstraints[0]);

    // 完全相同的命令命中记忆，直接放行。
    const repeat = await executor.execute({ callId: "remembered-2", toolName: "run_command", input: command });
    expect(repeat.status).toBe("success");

    // 同程序不同参数生成不同约束，不命中记忆，重新审批。
    const changed = await executor.execute({ callId: "remembered-3", toolName: "run_command", input: { ...command, args: ["-e", "process.stdout.write('changed')"] } });
    expect(changed.status).toBe("approval_required");
  });

  it("run_command 沙箱未装配或不可用时一律 fail-closed deny（R2：不弹降级卡）", async function deniesCommandWithoutSandbox() {
    const workspaceRoot = await createTemporaryWorkspace();
    const unknownCommand = { program: "node", args: ["-e", "process.stdout.write('ok')"], cwd: "." };

    // 未绑定沙箱底座：无法确认执行方式，任何模式都 fail-closed，不进入审批。
    const unbound = await createAgentToolExecutor(workspaceRoot, "auto_approve", true, null)
      .execute({ callId: "command-no-sandbox", toolName: "run_command", input: unknownCommand });
    expect(unbound.status).toBe("denied");
    expect(unbound.status === "denied" && unbound.error.code).toBe("SANDBOX_UNAVAILABLE");

    // workspace-write 沙箱不可用：3 次探测后 fail-closed deny，不弹降级卡，批准前零执行。
    const unavailablePort = createFakeSandboxPort({ enforcement: "unavailable" });
    const degrade = await createAgentToolExecutor(workspaceRoot, "auto_approve", true, { port: unavailablePort.port, mode: "workspace-write" })
      .execute({ callId: "command-unavailable-sandbox", toolName: "run_command", input: unknownCommand });
    expect(degrade.status).toBe("denied");
    expect(degrade.status === "denied" && degrade.error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(unavailablePort.prepared).toHaveLength(0);

    // read-only 沙箱不可用：维持 fail-closed deny（降级=无隔离写，禁止）。
    const readOnly = await createAgentToolExecutor(workspaceRoot, "auto_approve", true, { port: createFakeSandboxPort({ enforcement: "unavailable" }).port, mode: "read-only" })
      .execute({ callId: "command-unavailable-readonly", toolName: "run_command", input: unknownCommand });
    expect(readOnly.status).toBe("denied");
    expect(readOnly.status === "denied" && readOnly.error.code).toBe("SANDBOX_UNAVAILABLE");
  });

  it("run_command 直接执行缺少沙箱范围时 fail-closed（绕过 ToolExecutor 的路径）", async function rejectsToolWithoutScope() {
    const workspaceRoot = await createTemporaryWorkspace();
    const tool = createRunCommandTool();
    await expect(tool.execute(
      { program: process.execPath, args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 5_000 },
      { workspaceRoot, permissionMode: "full_access", agentFlow: { async search() { return []; } } },
    )).rejects.toMatchObject({ toolError: { code: "SANDBOX_UNAVAILABLE" } });
  });

  it("run_command 沙箱 prepare 可用性失败重试耗尽后抛结构化耗尽错误且不启动命令（R4）", async function mapsPrepareFailure() {
    const workspaceRoot = await createTemporaryWorkspace();
    const failingPort: SandboxPort = {
      async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; },
      async setup() { throw new Error("fake setup"); },
      async prepare() {
        throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "沙箱 runner 初始化或包装失败，目标命令未启动");
      },
      async release() {},
      async shutdown() {},
    };
    const tool = createRunCommandTool();
    // R4：可用性失败在 SANDBOX_START_MAX_ATTEMPTS 内重试，耗尽后抛 SandboxPrepareExhaustedError
    //（code=SANDBOX_UNAVAILABLE），由 ToolExecutor 转 fail-closed deny；直连调用看到结构化错误本体。
    await expect(tool.execute(
      { program: process.execPath, args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 5_000 },
      { workspaceRoot, permissionMode: "full_access", sandboxPolicy: createFakeSandboxScope(workspaceRoot, failingPort), agentFlow: { async search() { return []; } } },
    )).rejects.toMatchObject({ name: "SandboxPrepareExhaustedError", code: "SANDBOX_UNAVAILABLE" });
  });

  it("只向展示层提供脱敏且有界的 Tool 与 Approval facts", async function exposesSafeDisplayFacts() {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot);
    const content = "raw-file-content-must-not-enter-display";
    const write = await executor.execute({ callId: "display-write", toolName: "write_file", input: { path: "safe.txt", content } });
    expect(write.status).toBe("approval_required");
    if (write.status !== "approval_required") throw new Error("expected approval request");
    expect(write.display).toEqual(expect.objectContaining({ titleKey: "tool.write.completed", target: "safe.txt", summary: "create" }));
    expect(write.approval.display).toEqual(expect.objectContaining({ operation: "create", effect: "workspace", resource: "safe.txt" }));
    expect(JSON.stringify(write.display)).not.toContain(content);
    expect(JSON.stringify(write.approval.display)).not.toContain(content);

    const command = await executor.execute({
      callId: "display-command",
      toolName: "run_command",
      input: { program: "node", args: ["-e", "process.stdout.write('ok')", "--token", "raw-token-must-not-enter-display"], cwd: "." },
    });
    expect(command.status).toBe("approval_required");
    if (command.status !== "approval_required") throw new Error("expected command approval request");
    expect(command.approval.display?.actionPreview).toContain("<redacted>");
    expect(command.approval.display?.actionPreview).not.toContain("raw-token-must-not-enter-display");

    const inlineSecret = await executor.execute({
      callId: "display-inline-secret",
      toolName: "run_command",
      input: { program: "node", args: ["-e", "process.env.TOKEN='inline-secret-must-not-enter-display'"], cwd: "." },
    });
    expect(inlineSecret.status).toBe("approval_required");
    expect(inlineSecret.status === "approval_required" && inlineSecret.approval.display?.actionPreview).not.toContain("inline-secret-must-not-enter-display");
  });

  it("MCP host 审批预览明确显示未隔离", async function labelsUnisolatedMcpApproval() {
    const workspaceRoot = await createTemporaryWorkspace();
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp__fixture__read",
      description: "fixture MCP tool",
      inputSchema: z.object({}),
      metadata: { effect: "external", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
      createActionFacts: function createActionFacts() {
        return { toolName: "mcp__fixture__read", effect: "external", destructive: false, operation: "mcp_tools_call", risk: "external_side_effect", executionIsolation: "unisolated", requiresApproval: true };
      },
      execute: async function execute() { return {}; },
      serializeOutput: function serializeOutput(output) { return output; },
    });
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "ask",
      workspaceTrusted: true,
      fileReadStates: new Map(),
      agentFlow: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; } },
    });

    const result = await executor.execute({ callId: "mcp-host-display", toolName: "mcp__fixture__read", input: {} });
    expect(result.status).toBe("approval_required");
    if (result.status !== "approval_required") throw new Error("expected MCP approval request");
    expect(result.approval.display?.actionPreview).toBe("MCP server 执行边界：未隔离（宿主直接运行）");
  });

  it("按权限模式和工作区信任执行文件写入权限矩阵", async function enforcesFileWriteModeMatrix() {
    const workspaceRoot = await createTemporaryWorkspace();
    const ask = await createAgentToolExecutor(workspaceRoot, "ask", false)
      .execute({ callId: "write-ask", toolName: "write_file", input: { path: "ask.txt", content: "ask" } });
    expect(ask.status).toBe("approval_required");

    const untrustedAuto = await createAgentToolExecutor(workspaceRoot, "auto_approve", false)
      .execute({ callId: "write-auto-untrusted", toolName: "write_file", input: { path: "untrusted.txt", content: "untrusted" } });
    expect(untrustedAuto.status).toBe("approval_required");

    const trustedAuto = await createAgentToolExecutor(workspaceRoot, "auto_approve", true)
      .execute({ callId: "write-auto-trusted", toolName: "write_file", input: { path: "trusted.txt", content: "trusted" } });
    expect(trustedAuto.status).toBe("success");

    const fullAccess = await createAgentToolExecutor(workspaceRoot, "full_access", false)
      .execute({ callId: "write-full-access", toolName: "write_file", input: { path: "full-access.txt", content: "full access" } });
    expect(fullAccess.status).toBe("success");
    expect(await readFile(path.join(workspaceRoot, "trusted.txt"), "utf8")).toBe("trusted");
    expect(await readFile(path.join(workspaceRoot, "full-access.txt"), "utf8")).toBe("full access");
  });

  it("以固定内存保留大输出的头尾和总字节数", async function boundsCommandOutputInMemory() {
    const workspaceRoot = await createTemporaryWorkspace();
    const tool = createRunCommandTool();
    const output = await tool.execute({
      program: process.execPath,
      args: [path.join(securityFixtureRoot, "large-stdout.mjs"), "65536"],
      cwd: ".",
      timeoutMs: 5_000,
    }, {
      workspaceRoot,
      permissionMode: "full_access",
      sandboxPolicy: createFakeSandboxScope(workspaceRoot, createFakeSandboxPort().port),
      agentFlow: { async search() { return []; } },
    });
    expect(output.totalStdoutBytes).toBe(65_536);
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stderrTruncated).toBe(false);
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(String(output.stdout), "utf8")).toBeLessThanOrEqual(30_100);
    expect(String(output.stdout)).toContain("…[输出已截断]…");
    expect(String(output.stdout).startsWith("x")).toBe(true);
    expect(String(output.stdout).endsWith("x")).toBe(true);
  });

  it("超时会终止命令的完整子进程树", async function terminatesCommandProcessTreeOnTimeout() {
    const workspaceRoot = await createTemporaryWorkspace();
    const pidFile = path.join(workspaceRoot, "child-worker.pid");
    const tool = createRunCommandTool();
    let workerPid: number | undefined;
    try {
      const execution = tool.execute({
        program: process.execPath,
        args: [path.join(securityFixtureRoot, "processes", "child-tree.mjs"), pidFile],
        cwd: ".",
        timeoutMs: 250,
      }, {
        workspaceRoot,
        permissionMode: "full_access",
        sandboxPolicy: createFakeSandboxScope(workspaceRoot, createFakeSandboxPort().port),
        agentFlow: { async search() { return []; } },
      });
      workerPid = Number.parseInt((await waitForFixtureFile(pidFile)).trim(), 10);
      expect(Number.isSafeInteger(workerPid)).toBe(true);
      await expect(execution).rejects.toMatchObject({ toolError: { code: "EXECUTION_TIMEOUT" } });
      expect(await waitForProcessExit(workerPid)).toBe(true);
    } finally {
      stopFixtureProcess(workerPid);
    }
  });

  it("取消会终止命令的完整子进程树", async function terminatesCommandProcessTreeOnAbort() {
    const workspaceRoot = await createTemporaryWorkspace();
    const pidFile = path.join(workspaceRoot, "aborted-child-worker.pid");
    const controller = new AbortController();
    const tool = createRunCommandTool();
    let workerPid: number | undefined;
    try {
      const execution = tool.execute({
        program: process.execPath,
        args: [path.join(securityFixtureRoot, "processes", "child-tree.mjs"), pidFile],
        cwd: ".",
        timeoutMs: 5_000,
      }, {
        workspaceRoot,
        permissionMode: "full_access",
        signal: controller.signal,
        sandboxPolicy: createFakeSandboxScope(workspaceRoot, createFakeSandboxPort().port),
        agentFlow: { async search() { return []; } },
      });
      workerPid = Number.parseInt((await waitForFixtureFile(pidFile)).trim(), 10);
      expect(Number.isSafeInteger(workerPid)).toBe(true);
      controller.abort();
      await expect(execution).rejects.toMatchObject({ toolError: { code: "EXECUTION_CANCELLED" } });
      expect(await waitForProcessExit(workerPid)).toBe(true);
    } finally {
      stopFixtureProcess(workerPid);
    }
  });

  it("不会把分页读取的哈希交给完整覆写使用", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "lines.txt"), "one\ntwo\nthree", "utf8");
    const partial = await executor.execute({ callId: "partial-read", toolName: "read_file", input: { path: "lines.txt", limit: 1 } });
    expect(partial.status).toBe("success");
    expect(partial.status === "success" && (partial.output as { sha256: string | null }).sha256).toBeNull();
  });

  it("read_file 默认读取 2000 行且拒绝单次超过 2000 行", function validatesReadPageSize() {
    const schema = createReadFileTool().inputSchema;
    expect(schema.parse({ path: "note.txt" })).toMatchObject({ offset: 1, limit: 2000 });
    expect(schema.parse({ path: "note.txt", offset: 1800, limit: 2000 })).toMatchObject({ offset: 1800, limit: 2000 });
    expect(schema.safeParse({ path: "note.txt", limit: 2001 }).success).toBe(false);
  });

  it("流式读取超过 256KB 的 UTF-8 BOM、CRLF 和跨 chunk 行，并保存完整原始字节哈希", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const longLine = "x".repeat(64 * 1024 - 8);
    const rows = ["head", longLine, "after-long-line", ...Array.from({ length: 24_000 }, function createRow(_, index) { return `row-${index + 1}`; })];
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${rows.join("\r\n")}\r\n`, "utf8")]);
    await writeFile(path.join(workspaceRoot, "streamed.txt"), bytes);
    const readStates = new Map<string, { sha256: string; mtimeMs: number; observedRanges: Array<{ startLine: number; endLine: number }> }>();
    const tool = createReadFileTool();
    const context = {
      workspaceRoot,
      permissionMode: "ask" as const,
      fileReadStates: readStates,
      agentFlow: { async search() { return []; } },
    };

    const head = await tool.execute({ path: "streamed.txt", offset: 1, limit: 1 }, context);
    expect(head).toMatchObject({ content: "head", startLine: 1, endLine: 1, truncated: true, sha256: null, encoding: "utf8-bom" });

    const middle = await tool.execute({ path: "streamed.txt", offset: 12_000, limit: 3 }, context);
    expect(middle).toMatchObject({ content: "row-11997\nrow-11998\nrow-11999", startLine: 12_000, endLine: 12_002, totalLines: rows.length + 1, truncated: true, sha256: null, encoding: "utf8-bom" });
    expect(readStates.get("streamed.txt")?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const tail = await tool.execute({ path: "streamed.txt", offset: rows.length, limit: 10 }, context);
    expect(tail).toMatchObject({ content: "row-24000\n", startLine: rows.length, endLine: rows.length + 1, truncated: false });
  });

  it("流式读取 UTF-16LE BOM 时使用 UTF-16LE 解码并保留跨 chunk 文本", async function readsUtf16Le() {
    const workspaceRoot = await createTemporaryWorkspace();
    const rows = Array.from({ length: 24_000 }, function row(_, index) { return `第${index + 1}行`; });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${rows.join("\r\n")}\r\n`, "utf16le")]);
    await writeFile(path.join(workspaceRoot, "utf16le.txt"), bytes);
    const tool = createReadFileTool();
    const result = await tool.execute({ path: "utf16le.txt", offset: 12_000, limit: 2 }, {
      workspaceRoot,
      permissionMode: "ask",
      fileReadStates: new Map(),
      agentFlow: { async search() { return []; } },
    });
    expect(result).toMatchObject({ content: "第12000行\n第12001行", encoding: "utf16le", startLine: 12_000, endLine: 12_001 });
  });

  it("对超长单行、二进制和已取消的流式读取返回稳定错误", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const tool = createReadFileTool();
    const context = { workspaceRoot, permissionMode: "ask" as const, agentFlow: { async search() { return []; } } };
    await writeFile(path.join(workspaceRoot, "too-long.txt"), "x".repeat(MAX_TEXT_LINE_CHARACTERS + 1), "utf8");
    await expect(tool.execute({ path: "too-long.txt", offset: 1, limit: 200 }, context)).rejects.toMatchObject({ toolError: { code: "FILE_TOO_LARGE" } });
    await writeFile(path.join(workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    await expect(tool.execute({ path: "binary.bin", offset: 1, limit: 200 }, context)).rejects.toMatchObject({ toolError: { code: "BINARY_FILE" } });
    await writeFile(path.join(workspaceRoot, "too-large.txt"), Buffer.alloc(MAX_TEXT_SCAN_BYTES + 1, 0x61));
    await expect(tool.execute({ path: "too-large.txt", offset: 1, limit: 200 }, context)).rejects.toMatchObject({ toolError: { code: "FILE_TOO_LARGE" } });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ path: "too-long.txt", offset: 1, limit: 200 }, { ...context, signal: controller.signal })).rejects.toMatchObject({ toolError: { code: "EXECUTION_CANCELLED" } });
  });

  it("允许大文件已观察区间内的审批编辑，拒绝未观察和已陈旧的编辑", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot);
    const lines = Array.from({ length: 30_000 }, function createLine(_, index) { return `line-${index + 1} payload`; });
    await writeFile(path.join(workspaceRoot, "large.txt"), `${lines.join("\n")}\n`, "utf8");
    const observed = await executor.execute({ callId: "large-read", toolName: "read_file", input: { path: "large.txt", offset: 18_999, limit: 5 } });
    expect(observed.status).toBe("success");
    expect(observed.status === "success" && (observed.output as { totalLines: number; truncated: boolean }).totalLines).toBe(30_001);
    expect(observed.status === "success" && (observed.output as { totalLines: number; truncated: boolean }).truncated).toBe(true);

    const unobserved = await executor.execute({ callId: "unobserved-edit", toolName: "edit_file", input: { path: "large.txt", oldString: "line-20000 payload", newString: "line-20000-edited" } });
    expect(unobserved.status === "error" && unobserved.error.code).toBe("FILE_NOT_READ");

    const pending = await executor.execute({ callId: "large-edit", toolName: "edit_file", input: { path: "large.txt", oldString: "line-19000 payload", newString: "line-19000-edited" } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const edited = await executor.execute({ callId: "large-edit", toolName: "edit_file", input: { path: "large.txt", oldString: "line-19000 payload", newString: "line-19000-edited" }, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(edited.status).toBe("success");
    expect(edited.status === "success" && edited.display).toMatchObject({
      titleKey: "tool.edit.completed",
      target: "large.txt",
      diff: { files: 1, added: 1, removed: 1 },
    });
    expect(await readFile(path.join(workspaceRoot, "large.txt"), "utf8")).toContain("line-19000-edited");

    await writeFile(path.join(workspaceRoot, "large.txt"), "changed-outside-agent\n", "utf8");
    const stale = await executor.execute({ callId: "stale-edit", toolName: "edit_file", input: { path: "large.txt", oldString: "line-19000-edited", newString: "line-19000-again" } });
    expect(stale.status === "error" && stale.error.code).toBe("FILE_STALE");
  });

  it("按每个行内替换 span 校验观察范围，replaceAll 不得越过未读取区域", async function validatesEveryReplacementSpan() {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeFile(path.join(workspaceRoot, "ranges.txt"), "one\nvisible target text\nthree\nhidden target text\nfive\n", "utf8");
    const readStates = new Map<string, { sha256: string; mtimeMs: number; observedRanges: Array<{ startLine: number; endLine: number }> }>();
    const context = { workspaceRoot, permissionMode: "ask" as const, fileReadStates: readStates, agentFlow: { async search() { return []; } } };
    await createReadFileTool().execute({ path: "ranges.txt", offset: 1, limit: 3 }, context);

    await expect(createEditFileTool().execute({ path: "ranges.txt", oldString: "visible", newString: "shown", replaceAll: false }, context)).resolves.toMatchObject({ replacements: 1 });
    expect(readStates.get("ranges.txt")?.observedRanges).toEqual([{ startLine: 1, endLine: 3 }]);
    await expect(createEditFileTool().execute({ path: "ranges.txt", oldString: "target", newString: "edited", replaceAll: true }, context)).rejects.toMatchObject({ toolError: { code: "FILE_NOT_READ" } });
    await expect(createEditFileTool().execute({ path: "ranges.txt", oldString: "hidden", newString: "blocked", replaceAll: false }, context)).rejects.toMatchObject({ toolError: { code: "FILE_NOT_READ" } });
  });

  it("工作区授权按编辑路径复用，不受每次 oldString/newString 变化影响", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const constraints: Array<string | undefined> = [];
    const hashes: string[] = [];
    const registry = new ToolRegistry();
    registry.register(createReadFileTool());
    registry.register(createEditFileTool());
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "ask",
      fileReadStates: new Map(),
      resolvePersistentGrant: async ({ constraint, inputHash }) => {
        constraints.push(constraint);
        hashes.push(inputHash);
        return constraint === "path:note.txt";
      },
      agentFlow: {
        async search() { return []; },
        async searchAcrossTables() { return { results: [] }; },
      },
    });
    await writeFile(path.join(workspaceRoot, "note.txt"), "first\nsecond\n", "utf8");
    await executor.execute({ callId: "read-note", toolName: "read_file", input: { path: "note.txt", limit: 100 } });

    const first = await executor.execute({ callId: "edit-note-1", toolName: "edit_file", input: { path: "note.txt", oldString: "first", newString: "first changed" } });
    const second = await executor.execute({ callId: "edit-note-2", toolName: "edit_file", input: { path: "note.txt", oldString: "second", newString: "second changed" } });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(constraints).toEqual(["path:note.txt", "path:note.txt"]);
    expect(new Set(hashes).size).toBe(2);
    expect(await readFile(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("first changed\nsecond changed\n");
  });

  it("外部目标预检取代路径硬拒：穿越与链接指向外部可读取，UNC/设备与危险命令仍拒绝（Talk-Plan1013 Stage 1）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
    await symlink(outsideRoot, path.join(workspaceRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
    const executor = createAgentToolExecutor(workspaceRoot);
    // 相对路径 `..` 逃逸与链接指向外部：读取例外允许直接读取原文件，不抛 PATH_TRAVERSAL/PATH_UNSAFE_LINK。
    const escapedRead = await executor.execute({ callId: "path-1", toolName: "read_file", input: { path: "../" + path.basename(outsideRoot) + "/secret.txt" } });
    expect(escapedRead.status).toBe("success");
    expect(escapedRead.status === "success" && (escapedRead.output as { content: string }).content).toBe("outside");
    const unc = await executor.execute({ callId: "path-unc", toolName: "read_file", input: { path: "\\\\server\\share\\secret.txt" } });
    expect(unc.status === "error" && unc.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
    const linkRead = await executor.execute({ callId: "path-link", toolName: "read_file", input: { path: "escape/secret.txt" } });
    expect(linkRead.status).toBe("success");
    expect(linkRead.status === "success" && (linkRead.output as { content: string }).content).toBe("outside");
    const forbidden = await executor.execute({ callId: "command-1", toolName: "run_command", input: { program: "del", args: ["x.txt"] } });
    expect(forbidden.status).toBe("denied");
    const fullAccessExecutor = createAgentToolExecutor(workspaceRoot, "full_access");
    const fullAccessForbidden = await fullAccessExecutor.execute({ callId: "command-full-access", toolName: "run_command", input: { program: "del", args: ["x.txt"] } });
    expect(fullAccessForbidden.status).toBe("denied");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await executor.execute({ callId: "cancel-1", toolName: "read_file", input: { path: "missing.txt" } }, { signal: controller.signal });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.status === "cancelled" && cancelled.interruption.safeToRetry).toBe(true);
  });

  it("write_file 在 read-only 沙箱下返回 FS_SANDBOX_DENIED 且磁盘零变化（Stage 5）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot, "ask", true, createFakeSandboxBinding(workspaceRoot, "read-only"));
    const pending = await executor.execute({ callId: "ro-create", toolName: "write_file", input: { path: "note.txt", content: "first" } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const denied = await executor.execute({
      callId: "ro-create",
      toolName: "write_file",
      input: { path: "note.txt", content: "first" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(denied.status === "error" && denied.error.code).toBe("FS_SANDBOX_DENIED");
    await expect(readFile(path.join(workspaceRoot, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("edit_file 在 read-only 沙箱下返回 FS_SANDBOX_DENIED 且内容零变化（Stage 5）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeFile(path.join(workspaceRoot, "note.txt"), "first\nsecond\n", "utf8");
    const executor = createAgentToolExecutor(workspaceRoot, "ask", true, createFakeSandboxBinding(workspaceRoot, "read-only"));
    await executor.execute({ callId: "ro-read", toolName: "read_file", input: { path: "note.txt" } });
    const pending = await executor.execute({ callId: "ro-edit", toolName: "edit_file", input: { path: "note.txt", oldString: "first", newString: "changed" } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const denied = await executor.execute({
      callId: "ro-edit",
      toolName: "edit_file",
      input: { path: "note.txt", oldString: "first", newString: "changed" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(denied.status === "error" && denied.error.code).toBe("FS_SANDBOX_DENIED");
    expect(await readFile(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("read-only 下 tempRoot 不构成文件工具写旁路（Stage 5）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot, "auto_approve", true, {
      port: createFakeSandboxPort().port,
      mode: "read-only",
      tempRoot: path.join(workspaceRoot, ".autopilot", "tmp"),
    });
    const denied = await executor.execute({ callId: "ro-temp", toolName: "write_file", input: { path: ".autopilot/tmp/x.txt", content: "temp" } });
    expect(denied.status === "error" && denied.error.code).toBe("FS_SANDBOX_DENIED");
    await expect(readFile(path.join(workspaceRoot, ".autopilot", "tmp", "x.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("danger-full-access 下文件工具不放宽 schema：工作区内可写、外部绝对路径仍需精确授权（Talk-Plan1013 Stage 1 gate）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot, "full_access", true, createFakeSandboxBinding(workspaceRoot, "danger-full-access"));
    const inside = await executor.execute({ callId: "dfa-inside", toolName: "write_file", input: { path: "note.txt", content: "inside" } });
    expect(inside.status).toBe("success");
    const outside = await executor.execute({ callId: "dfa-outside", toolName: "write_file", input: { path: path.join(outsideRoot, "secret.txt"), content: "outside" } });
    expect(outside.status).toBe("approval_required");
    // 未授权外部修改零磁盘变化：目标不存在，沙箱模式也未放宽 gate。
    await expect(readFile(path.join(outsideRoot, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("inside");
  });

  it("auto_approve+Trust 下指向工作区外的链接目标修改走外部 gate，工作区内 symlink swap 仍被锁内拒绝（Stage 5 竞态保持）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
    await symlink(outsideRoot, path.join(workspaceRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
    const executor = createAgentToolExecutor(workspaceRoot, "auto_approve", true);
    // Talk-Plan1013 Stage 1：链接指向外部 = 外部修改，auto_approve+Trust 也不能放行，目标零变化。
    const escape = await executor.execute({ callId: "swap-escape", toolName: "write_file", input: { path: "escape/secret.txt", content: "breach" } });
    expect(escape.status).toBe("approval_required");
    expect(await readFile(path.join(outsideRoot, "secret.txt"), "utf8")).toBe("outside");

    // 既有真实文件在读取后被替换为链接目标：锁内重新 canonicalize 后 assertRegularFile 拒绝非普通文件。
    // Windows 无特权环境不允许 file symlink（EPERM），统一改用 junction（指向目录，同样非普通文件）。
    await writeFile(path.join(workspaceRoot, "note.txt"), "original", "utf8");
    const observed = await executor.execute({ callId: "swap-read", toolName: "read_file", input: { path: "note.txt" } });
    const hash = observed.status === "success" ? String((observed.output as { sha256: string }).sha256) : "";
    await rm(path.join(workspaceRoot, "note.txt"));
    const swapTargetDir = path.join(workspaceRoot, "swap-target");
    await mkdir(swapTargetDir, { recursive: true });
    await writeFile(path.join(swapTargetDir, "content.txt"), "target", "utf8");
    await symlink(swapTargetDir, path.join(workspaceRoot, "note.txt"), process.platform === "win32" ? "junction" : "file");
    const swapped = await executor.execute({ callId: "swap-overwrite", toolName: "write_file", input: { path: "note.txt", content: "next", expectedSha256: hash } });
    expect(swapped.status === "error" && swapped.error.code).toBe("FILE_NOT_READ");
    expect(await readFile(path.join(swapTargetDir, "content.txt"), "utf8")).toBe("target");
  });

  it("缺沙箱绑定时文件工具沿用既有工作区围栏（Stage 5 兼容旧上下文）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createAgentToolExecutor(workspaceRoot, "auto_approve", true, null);
    const created = await executor.execute({ callId: "legacy-write", toolName: "write_file", input: { path: "note.txt", content: "legacy" } });
    expect(created.status).toBe("success");
    expect(await readFile(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("legacy");
  });
});
