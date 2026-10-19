/**
 * cr-r4-prepare-retry 回归（CR 20261016 R4）：
 * 1. run_command 前台链的沙箱 prepare（Adapter initialize/wrap，目标 spawn 之前）失败时，
 *    仅"确定未启动"的可用性失败（UNAVAILABLE/NOT_PROVISIONED/RUNNER_FAILED）在
 *    SANDBOX_START_MAX_ATTEMPTS 内重试；前 2 次 RUNNER_FAILED 第 3 次恢复 → 成功，prepare 恰 3 次。
 * 2. 重试耗尽 → ToolExecutor 按 R2 fail-closed 语义 deny（SANDBOX_UNAVAILABLE）终态化：
 *    目标命令零执行（无 spawn、无 release），逐次脱敏诊断出现在拒绝消息中。
 * 3. POLICY_DENIED 与非 SandboxPortError 立即失败不重试，prepare 只调用 1 次。
 *
 * 审批重放必须在同一 Executor 上完成：签发阶段仅探测 status（恒 full），prepare 不被调用，
 * 脚本化失败计数不受影响；跨 Executor 重放无 validateApproval 桥会被审批消费拒绝。
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SandboxExecutionBinding } from "../../src/internal/tools/types";
import { SANDBOX_ERROR_CODES } from "../../src/runtime/domain/sandbox-policy";
import { SandboxPortError, type SandboxPort } from "../../src/runtime/ports";

const temporaryRoots: string[] = [];

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建独立临时工作区。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cr-r4-prepare-"));
  temporaryRoots.push(root);
  return root;
}

/** 脚本化 prepare Port：status 恒 full；prepare 按调用次序抛 scriptedFailures 中的错误，耗尽后成功。 */
function createScriptedPreparePort(scriptedFailures: Error[]) {
  let prepared = 0;
  let released = 0;
  const port: SandboxPort = {
    async status() {
      return { platform: "macos" as const, backend: "fake", enforcement: "full" as const };
    },
    async setup() {
      throw new Error("fake sandbox setup 不可用");
    },
    async prepare(request) {
      prepared += 1;
      const error = prepared <= scriptedFailures.length ? scriptedFailures[prepared - 1] : undefined;
      if (error) throw error;
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" as const };
    },
    async release() {
      released += 1;
    },
    async shutdown() {},
  };
  return { port, getPrepared: () => prepared, getReleased: () => released };
}

/** 创建 run_command 执行器（ask 模式，注入指定沙箱 binding）。 */
function createCommandExecutor(workspaceRoot: string, binding: SandboxExecutionBinding): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    workspaceTrusted: false,
    sandbox: binding,
  });
}

/** 在同一 Executor 上先取批准（prepare 不被调用），再携带批准重放执行。 */
async function executeWithApproval(workspaceRoot: string, binding: SandboxExecutionBinding, input: { program: string; args: string[]; cwd: string }) {
  const executor = createCommandExecutor(workspaceRoot, binding);
  const pending = await executor.execute({ callId: "c-r4", toolName: "run_command", input });
  if (pending.status !== "approval_required") throw new Error(`expected approval, got ${pending.status}`);
  return executor.execute({ callId: "c-r4", toolName: "run_command", input, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
}

describe("cr-r4-prepare-retry 沙箱包装重试（prepare 耗尽 fail-closed deny）", () => {
  it("prepare 前 2 次 RUNNER_FAILED 第 3 次恢复：命令成功执行，prepare 恰好调用 3 次", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const probeFile = path.join(workspaceRoot, "r4-recover-probe.txt");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(probeFile)}, 'x')`;
    const input = { program: "node", args: ["-e", script], cwd: "." };

    const flaky = createScriptedPreparePort([
      new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动 1（测试模拟）"),
      new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动 2（测试模拟）"),
    ]);
    const result = await executeWithApproval(workspaceRoot, { port: flaky.port, mode: "workspace-write" }, input);

    expect(result.status).toBe("success");
    expect(flaky.getPrepared()).toBe(3);
    expect(existsSync(probeFile)).toBe(true);
  });

  it("prepare 3 次全 RUNNER_FAILED：denied SANDBOX_UNAVAILABLE、目标零执行（无 spawn 无 release）、逐次诊断在消息中", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const probeFile = path.join(workspaceRoot, "r4-exhausted-probe.txt");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(probeFile)}, 'x')`;
    const input = { program: "node", args: ["-e", script], cwd: "." };

    const exhausted = createScriptedPreparePort([
      new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动 1（测试模拟）"),
      new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动 2（测试模拟）"),
      new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动 3（测试模拟）"),
    ]);
    const result = await executeWithApproval(workspaceRoot, { port: exhausted.port, mode: "workspace-write" }, input);

    expect(result.status).toBe("denied");
    if (result.status !== "denied") throw new Error("unreachable");
    expect(result.error.code).toBe(SANDBOX_ERROR_CODES.UNAVAILABLE);
    expect(result.error.message).toContain("目标命令未启动");
    expect(result.error.message).toContain("第 1 次包装失败");
    expect(result.error.message).toContain("第 3 次包装失败");
    expect(exhausted.getPrepared()).toBe(3);
    // 目标命令从未启动：probe 未写入，release 资源释放路径也未触达。
    expect(existsSync(probeFile)).toBe(false);
    expect(exhausted.getReleased()).toBe(0);
  });

  it("POLICY_DENIED 立即失败不重试：prepare 只调用 1 次，按普通工具错误返回", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const input = { program: "node", args: ["-e", "process.exit(0)"], cwd: "." };

    const denying = createScriptedPreparePort([new SandboxPortError(SANDBOX_ERROR_CODES.POLICY_DENIED, "OS 拒绝写入（测试模拟）")]);
    const result = await executeWithApproval(workspaceRoot, { port: denying.port, mode: "workspace-write" }, input);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe(SANDBOX_ERROR_CODES.POLICY_DENIED);
    expect(denying.getPrepared()).toBe(1);
  });

  it("非 SandboxPortError 立即失败不重试：prepare 只调用 1 次", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const input = { program: "node", args: ["-e", "process.exit(0)"], cwd: "." };

    const broken = createScriptedPreparePort([new Error("adapter 内部错误（测试模拟）")]);
    const result = await executeWithApproval(workspaceRoot, { port: broken.port, mode: "workspace-write" }, input);

    expect(result.status).toBe("error");
    expect(broken.getPrepared()).toBe(1);
  });
});
