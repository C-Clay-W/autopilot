/**
 * 沙箱启动失败 fail-closed 定向测试（CR 20261016 R2：无沙箱降级直执已撤）：
 * 3 次启动探测、模式分流（read-only 与 workspace-write 一律 deny / danger-full-access 直通）、
 * 重试次数边界；R5 起拒绝诊断提升为结构化 display 事实（diagnostics/executionMode），
 * error message 只保留策略原因。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_SANDBOX_EXEC_CONSTRAINT } from "../../src/runtime/domain/sandbox-policy";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SandboxExecutionBinding } from "../../src/internal/tools/types";
import type { SandboxPort } from "../../src/runtime/ports";

const temporaryRoots: string[] = [];

/** 创建独立临时工作区。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-degrade-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 可控沙箱 Port：status 前 failTimes 次返回不可用（带脱敏诊断），之后恢复 full；prepare 透传并计数。 */
function createDegradeSandboxPort(options: { failTimes?: number } = {}) {
  const failTimes = options.failTimes ?? Number.POSITIVE_INFINITY;
  let statusCalls = 0;
  let prepared = 0;
  const port: SandboxPort = {
    async status() {
      statusCalls++;
      return statusCalls <= failTimes
        ? { platform: "windows" as const, backend: "fake-srt", enforcement: "unavailable" as const, diagnostics: ["provision 未完成：测试模拟"] }
        : { platform: "macos" as const, backend: "fake", enforcement: "full" as const };
    },
    async setup() {
      throw new Error("fake sandbox setup 不可用");
    },
    async prepare(request) {
      prepared++;
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" as const };
    },
    async release() {},
    async shutdown() {},
  };
  return { port, getStatusCalls: () => statusCalls, getPrepared: () => prepared };
}

/** 创建 ask 模式执行器；permissionMode 与信任可覆盖。 */
function createExecutor(workspaceRoot: string, binding: SandboxExecutionBinding, permissionMode: "ask" | "auto_approve" | "full_access" = "ask", workspaceTrusted = false): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode,
    workspaceTrusted,
    sandbox: binding,
  });
}

const commandInput = { program: "node", args: ["-e", "process.stdout.write('degrade-ok')"], cwd: "." } as const;

describe("沙箱启动失败 fail-closed（R2）", () => {
  it("workspace-write 连续 3 次启动失败后 fail-closed deny：不弹降级卡、SANDBOX_UNAVAILABLE、含诊断、恰好探测 3 次、零执行", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const sandboxPort = createDegradeSandboxPort();
    const executor = createExecutor(workspaceRoot, { port: sandboxPort.port, mode: "workspace-write" });
    const result = await executor.execute({ callId: "c-degrade-1", toolName: "run_command", input: commandInput });
    expect(result.status).toBe("denied");
    if (result.status !== "denied") throw new Error(`expected denied, got ${result.status}`);
    expect(result.error.code).toBe("SANDBOX_UNAVAILABLE");
    // R5：诊断不再拼接进 message，提升为结构化 display 事实；执行方式标注 unavailable。
    expect(result.error.message).not.toContain("provision 未完成：测试模拟");
    expect(result.display?.executionMode).toBe("unavailable");
    expect(result.display?.diagnostics).toContain("provision 未完成：测试模拟");
    expect(sandboxPort.getStatusCalls()).toBe(3);
    // 沙箱包装与目标命令均未启动。
    expect(sandboxPort.getPrepared()).toBe(0);
  });

  it("workspace-write 携带普通命令批准重放、沙箱仍不可用：同样 fail-closed deny，批准不被消耗", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const sandboxPort = createDegradeSandboxPort();
    const executor = createExecutor(workspaceRoot, { port: sandboxPort.port, mode: "workspace-write" });
    // 先在沙箱可用时取得普通命令批准。
    const okPort = createDegradeSandboxPort({ failTimes: 0 });
    const issuing = createExecutor(workspaceRoot, { port: okPort.port, mode: "workspace-write" });
    const first = await issuing.execute({ callId: "c-degrade-2", toolName: "run_command", input: commandInput });
    if (first.status !== "approval_required") throw new Error("expected normal approval");
    // 沙箱失效后重放同一批准：无沙箱直执通道不存在，deny 且批准未被消耗。
    const denied = await executor.execute({ callId: "c-degrade-2", toolName: "run_command", input: commandInput, approval: { approvalId: first.approval.approvalId, decision: "allow_once" } });
    expect(denied.status).toBe("denied");
    if (denied.status !== "denied") throw new Error("unreachable");
    expect(denied.error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(sandboxPort.getPrepared()).toBe(0);
    // 沙箱恢复后，在签发批准的原 Executor 上同一批准仍可正常消费一次（未在失败重放中被消耗）。
    const done = await issuing.execute({ callId: "c-degrade-2", toolName: "run_command", input: commandInput, approval: { approvalId: first.approval.approvalId, decision: "allow_once" } });
    expect(done.status).toBe("success");
    if (done.status !== "success") throw new Error("unreachable");
    expect((done.output as { sandbox?: { enforcement?: string } }).sandbox?.enforcement).toBe("full");
    expect(okPort.getPrepared()).toBe(1);
  });

  it("第 1/2 次失败后第 3 次探测成功：不弹降级审批，走普通沙箱执行流程", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const sandboxPort = createDegradeSandboxPort({ failTimes: 2 });
    const executor = createExecutor(workspaceRoot, { port: sandboxPort.port, mode: "workspace-write" });
    // ask 模式：探测恢复后与常态一致，仍需普通命令审批，批准后沙箱内执行。
    const first = await executor.execute({ callId: "c-degrade-4", toolName: "run_command", input: commandInput });
    expect(first.status).toBe("approval_required");
    if (first.status !== "approval_required") throw new Error("unreachable");
    expect(first.approval.constraint).not.toBe(NO_SANDBOX_EXEC_CONSTRAINT);
    const approved = await executor.execute({ callId: "c-degrade-4", toolName: "run_command", input: commandInput, approval: { approvalId: first.approval.approvalId, decision: "allow_once" } });
    expect(approved.status).toBe("success");
    if (approved.status !== "success") throw new Error("unreachable");
    expect((approved.output as { sandbox?: { enforcement?: string } }).sandbox?.enforcement).toBe("full");
    // R5：沙箱内执行的结构化执行方式为 sandboxed。
    expect(approved.display?.executionMode).toBe("sandboxed");
    expect(sandboxPort.getStatusCalls()).toBe(4);
    expect(sandboxPort.getPrepared()).toBe(1);
  });

  it("read-only 沙箱不可用保持 fail-closed deny，诊断以结构化 display 事实投影", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const sandboxPort = createDegradeSandboxPort();
    const executor = createExecutor(workspaceRoot, { port: sandboxPort.port, mode: "read-only" });
    const result = await executor.execute({ callId: "c-degrade-5", toolName: "run_command", input: commandInput });
    expect(result.status).toBe("denied");
    if (result.status !== "denied") throw new Error("unreachable");
    expect(result.error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(result.error.message).not.toContain("provision 未完成：测试模拟");
    expect(result.display?.diagnostics).toContain("provision 未完成：测试模拟");
  });

  it("danger-full-access 沙箱不可用时直接执行，不弹降级审批，放行行为与沙箱可用时一致，展示标注未隔离", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const sandboxPort = createDegradeSandboxPort();
    const executor = createExecutor(workspaceRoot, { port: sandboxPort.port, mode: "danger-full-access" }, "auto_approve", true);
    const result = await executor.execute({ callId: "c-degrade-6", toolName: "run_command", input: commandInput });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect((result.output as { sandbox?: { enforcement?: string } }).sandbox?.enforcement).toBe("unavailable");
    // R5：直执结果的结构化执行方式为 unisolated，展示层不得宣称隔离。
    expect(result.display?.executionMode).toBe("unisolated");
    expect(sandboxPort.getPrepared()).toBe(0);
  });
});
