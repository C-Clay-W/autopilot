/**
 * 后台 Job 工具测试：验证它只能经 ToolExecutor 的统一 Policy 门启动，
 * 且沙箱范围缺失/不可用时 fail-closed（SANDBOX_UNAVAILABLE），不产生任何 Job。
 */

import { describe, expect, it } from "vitest";
import { createStartBackgroundJobTool } from "./start-background-job-tool";
import { ToolExecutor } from "../tool-executor";
import { ToolRegistry } from "../tool-registry";
import { SANDBOX_ERROR_CODES, type SandboxExecutionRequest, type SandboxPolicy, type SandboxPreparedCommand } from "../../../runtime/domain/sandbox-policy";
import { SandboxPortError, type SandboxPort } from "../../../runtime/ports";
import type { SandboxCapabilityReport } from "../../../runtime/domain/sandbox-policy";
import type { JobService } from "../../../runtime/application/job-service";

/** 透传式 fake 沙箱 Port：记录 prepare 调用供断言（JobService double 场景不会真正 prepare）。 */
function createFakeSandboxPort(options: { enforcement?: "full" | "partial" | "unavailable" } = {}) {
  const enforcement = options.enforcement ?? "full";
  const prepared: SandboxExecutionRequest[] = [];
  const port: SandboxPort = {
    async status() { return { platform: "macos", backend: "fake", enforcement }; },
    async setup() { throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "fake sandbox setup 不可用"); },
    async prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      prepared.push(request);
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement };
    },
    async release() {},
    async shutdown() {},
  };
  return { port, prepared };
}

/** 宿主执行 fake port：backend host-execution，prepare 恒拒（宿主路径不应触达）。 */
function createHostExecutionPort() {
  const port: SandboxPort = {
    async status(): Promise<SandboxCapabilityReport> { return { platform: "windows", backend: "host-execution", enforcement: "unavailable", installed: false, provisioned: false }; },
    async setup(): Promise<SandboxCapabilityReport> { return { platform: "windows", backend: "host-execution", enforcement: "unavailable", installed: false, provisioned: false }; },
    async prepare() { throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "宿主执行模式不提供沙箱包装"); },
    async release() {},
    async shutdown() {},
  };
  return { port };
}

/** 构造与工具 workspaceRoot 对应的冻结沙箱策略。 */
function fakePolicy(workspaceRoot: string): SandboxPolicy {
  return { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
}

/** 创建记录 start 输入的 JobService double。 */
function createJobs(): { jobs: JobService; startInputs: Array<Record<string, unknown>> } {
  const startInputs: Array<Record<string, unknown>> = [];
  const jobs: JobService = {
    async start(input) {
      startInputs.push(input as unknown as Record<string, unknown>);
      return { id: "job-1", workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId, program: input.program, args: input.args, cwd: input.cwd, status: "running", startedAt: 1, updatedAt: 1, output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } };
    },
    async poll() { throw new Error("unused"); }, async readOutput() { throw new Error("unused"); }, async write() { throw new Error("unused"); }, async kill() { throw new Error("unused"); }, async list() { return []; }, async get() { return null; }, async hasActiveJobs() { return false; },
    forSession() { return { async list() { return { jobs: [] }; }, async read() { throw new Error("unused"); }, async stop() { throw new Error("unused"); }, async verifyServiceOwnership() { return "unverifiable" as const; } }; },
    async shutdown() {},
  };
  return { jobs, startInputs };
}

/** 为工具创建带沙箱绑定的可信 Work 执行器。 */
function executorFor(jobs: JobService, workspaceRoot: string, sandbox?: { port: SandboxPort; mode: "workspace-write" } | null): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createStartBackgroundJobTool({ jobs, workspaceId: workspaceRoot, workspaceRoot, sessionId: "s1", turnId: "t1" }));
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "full_access",
    workspaceTrusted: true,
    ...(sandbox === undefined ? { sandbox: { port: createFakeSandboxPort().port, mode: "workspace-write" as const } } : sandbox !== null ? { sandbox } : {}),
  });
}

describe("start_background_job", function suite() {
  it("复用命令 hard deny，只有 Policy 放行且沙箱就绪后才把冻结范围交给 JobService", async function usesPolicyEngine() {
    const fake = createJobs();
    const workspaceRoot = "/tmp/ws";
    const executor = executorFor(fake.jobs, workspaceRoot);
    const denied = await executor.execute({ callId: "deny", toolName: "start_background_job", input: { program: "rm", args: ["-rf", "x"], cwd: "." } });
    expect(denied.status).toBe("denied");
    expect(fake.startInputs).toHaveLength(0);
    const allowed = await executor.execute({ callId: "allow", toolName: "start_background_job", input: { program: "C:\\private\\tools\\PowerShell.EXE", args: ["-Command", "install", "--token", "secret-canary"], cwd: "." } });
    expect(allowed.status).toBe("success");
    if (allowed.status !== "success") throw new Error("expected success");
    expect(allowed.output).toEqual({ jobId: "job-1", status: "running", startedAt: 1, sandbox: { mode: "workspace-write" } });
    expect(allowed.display).toMatchObject({ target: "powershell", summary: "job-1 · 当前状态：running", job: { action: "start", jobId: "job-1", programLabel: "powershell", observedStatus: "running" } });
    expect(JSON.stringify(allowed)).not.toMatch(/private|--token|secret-canary/i);
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.startInputs[0]).toMatchObject({ workspaceId: workspaceRoot, sessionId: "s1", turnId: "t1" });
    expect(fake.startInputs[0].sandbox).toEqual({ port: expect.anything(), policy: fakePolicy(workspaceRoot) });
  });

  it("沙箱绑定缺失时 fail-closed deny（SANDBOX_UNAVAILABLE），不转审批也不启动", async function deniesWithoutBinding() {
    const fake = createJobs();
    const executor = executorFor(fake.jobs, "/tmp/ws", null);
    const result = await executor.execute({ callId: "unbound", toolName: "start_background_job", input: { program: "node", args: ["--version"], cwd: "." } });
    expect(result).toMatchObject({ status: "denied", error: { code: SANDBOX_ERROR_CODES.UNAVAILABLE } });
    expect(fake.startInputs).toHaveLength(0);
  });

  it("沙箱能力不可执行时 fail-closed deny，prepare 不被调用", async function deniesUnavailableCapability() {
    const fake = createJobs();
    const unavailablePort = createFakeSandboxPort({ enforcement: "unavailable" });
    const executor = executorFor(fake.jobs, "/tmp/ws", { port: unavailablePort.port, mode: "workspace-write" });
    const result = await executor.execute({ callId: "unavailable", toolName: "start_background_job", input: { program: "node", args: ["--version"], cwd: "." } });
    expect(result).toMatchObject({ status: "denied", error: { code: SANDBOX_ERROR_CODES.UNAVAILABLE } });
    expect(fake.startInputs).toHaveLength(0);
    expect(unavailablePort.prepared).toHaveLength(0);
  });

  it("宿主执行范围原样贯穿 JobService，输出标记 execution host，prepare 零调用", async function passesHostScopeThrough() {
    const fake = createJobs();
    const workspaceRoot = "/tmp/ws";
    const hostPort = createHostExecutionPort();
    const registry = new ToolRegistry();
    registry.register(createStartBackgroundJobTool({ jobs: fake.jobs, workspaceId: workspaceRoot, workspaceRoot, sessionId: "s1", turnId: "t1" }));
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "full_access",
      workspaceTrusted: true,
      sandbox: { port: hostPort.port, mode: "workspace-write" },
    });
    const request = { callId: "host", toolName: "start_background_job", input: { program: "node", args: ["--version"], cwd: "." } };
    const first = await executor.execute(request);
    expect(first.status).toBe("approval_required");
    if (first.status !== "approval_required") throw new Error("期望宿主逐次确认");
    const allowed = await executor.execute({ ...request, approval: { approvalId: first.approval.approvalId, decision: "allow_once" as const } });
    expect(allowed).toMatchObject({ status: "success" });
    if (allowed.status !== "success") throw new Error("expected success");
    expect(allowed.output).toEqual({ jobId: "job-1", status: "running", startedAt: 1, sandbox: { mode: "workspace-write", execution: "host" } });
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.startInputs[0].sandbox).toEqual({ execution: "host", policy: fakePolicy(workspaceRoot) });
  });

  it("绕过 ToolExecutor 的直接调用缺少沙箱范围时 fail-closed", async function rejectsDirectCallWithoutScope() {
    const fake = createJobs();
    const tool = createStartBackgroundJobTool({ jobs: fake.jobs, workspaceId: "/tmp/ws", workspaceRoot: "/tmp/ws", sessionId: "s1", turnId: "t1" });
    await expect(tool.execute({ program: "node", args: ["--version"], cwd: "." }, { permissionMode: "full_access" } as never)).rejects.toMatchObject({ toolError: { code: SANDBOX_ERROR_CODES.UNAVAILABLE } });
    expect(fake.startInputs).toHaveLength(0);
  });
});
