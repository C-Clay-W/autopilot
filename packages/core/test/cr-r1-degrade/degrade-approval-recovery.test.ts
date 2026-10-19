/**
 * cr-r1-degrade 回归（CR 20261016 R1 修复 + R2 fail-closed 后的休眠底座）：
 * 1. workspace-write 沙箱失效时普通批准重放被 fail-closed deny（R1 攻击路径因降级移除而
 *    结构性消除：不存在无沙箱直执通道）；沙箱恢复后同一批准仍可正常消费一次（不回归）。
 * 2. R1 保留休眠的降级审批权威底座仍正确：冻结 → validateApproval 持久原子认领一次 →
 *    崩溃窗口/重复重放拒绝（供未来受控执行方式复用时回归）。
 * 3. 输入变更与过期 TTL 的降级决策在权威底座被拒绝。
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_SANDBOX_EXEC_CONSTRAINT } from "../../src/runtime/domain/sandbox-policy";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SandboxExecutionBinding, ToolExecutionContext } from "../../src/internal/tools/types";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createApprovalService } from "../../src/runtime/application/approval-service";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import type { FrozenRunConfig } from "../../src/runtime/domain";
import type { RunConfig } from "../../src/runtime/protocol";
import type { SandboxPort } from "../../src/runtime/ports";

const temporaryRoots: string[] = [];

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建独立临时工作区。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cr-r1-degrade-"));
  temporaryRoots.push(root);
  return root;
}

/** 可控沙箱 Port：status 前 failTimes 次返回不可用（带脱敏诊断），之后恢复 full。 */
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

/** 构造真实 ApprovalService + 真实 resolver validateApproval 桥（权威底座入口）。 */
async function createAuthorityFixture() {
  const workspaceRoot = await createTemporaryWorkspace();
  const ports = createMemoryPorts(workspaceRoot);
  const approvals = createApprovalService({ ...ports });
  const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: { permissionMode: "ask" }, approvalService: approvals });
  const sessionId = "s-cr-r1";
  const turnId = "t-cr-r1";
  const agentOptions = resolver.buildAgentOptions({ workspaceRoot } as FrozenRunConfig, { permissionMode: "ask" } as RunConfig, sessionId, turnId);
  if (!agentOptions.validateApproval) throw new Error("expected validateApproval bridge");
  return { workspaceRoot, ports, approvals, validateApproval: agentOptions.validateApproval, sessionId, turnId };
}

/** 创建 run_command 执行器。 */
function createCommandExecutor(workspaceRoot: string, binding: SandboxExecutionBinding, validateApproval?: ToolExecutionContext["validateApproval"]): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    workspaceTrusted: false,
    sandbox: binding,
    ...(validateApproval ? { validateApproval } : {}),
  });
}

/** 在权威底座手工冻结一份降级审批记录与对应决定（休眠语义：不经执行链签发）。 */
async function seedDegradeDecision(fixture: Awaited<ReturnType<typeof createAuthorityFixture>>, approvalId: string, options: { decision?: string; inputHash?: string; expiresAt?: string } = {}) {
  const key = { sessionId: fixture.sessionId, turnId: fixture.turnId, approvalId };
  const constraint = NO_SANDBOX_EXEC_CONSTRAINT;
  const request = { recordType: "sandbox_degrade_request" as const, ...key, callId: "c-degrade", toolName: "run_command", normalizedInputHash: options.inputHash ?? "hash-degrade", constraint, expiresAt: options.expiresAt ?? "2099-01-01T00:00:00Z" };
  expect(await fixture.ports.approvalStore.saveDegradeApproval(request)).toBe(true);
  await fixture.ports.approvalStore.saveDecision({ ...key, callId: "c-degrade", toolName: "run_command", normalizedInputHash: request.normalizedInputHash, constraint, expiresAt: request.expiresAt, decision: options.decision ?? "allow_once", createdAt: "2026-10-14T00:00:00Z" });
  return request;
}

describe("cr-r1-degrade 降级权威链（R1 修复 + R2 fail-closed）", () => {
  it("workspace-write 沙箱失效：普通批准重放 fail-closed deny 且批准不被消耗；沙箱恢复后正常消费一次", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const probeFile = path.join(workspaceRoot, "r1-normal-probe.txt");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(probeFile)}, 'x')`;
    const input = { program: "node", args: ["-e", script], cwd: "." };
    const okPort = createDegradeSandboxPort({ failTimes: 0 });
    const issuing = createCommandExecutor(workspaceRoot, { port: okPort.port, mode: "workspace-write" });
    const pending = await issuing.execute({ callId: "c-r1-normal", toolName: "run_command", input });
    if (pending.status !== "approval_required") throw new Error(`expected normal approval, got ${pending.status}`);
    expect(pending.approval.constraint).not.toBe(NO_SANDBOX_EXEC_CONSTRAINT);

    // 恢复：新 Executor（pending 为空）携带普通批准重放，同调用沙箱失效 → deny，零执行。
    const failPort = createDegradeSandboxPort();
    const resumed = createCommandExecutor(workspaceRoot, { port: failPort.port, mode: "workspace-write" });
    const replay = await resumed.execute({ callId: "c-r1-normal", toolName: "run_command", input, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(replay.status).toBe("denied");
    if (replay.status !== "denied") throw new Error("unreachable");
    expect(replay.error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(failPort.getPrepared()).toBe(0);
    expect(existsSync(probeFile)).toBe(false);

    // 对照：沙箱恢复后，在签发批准的原 Executor 上同一未被消耗的批准仍按沙箱语义正常消费一次（不回归）。
    const done = await issuing.execute({ callId: "c-r1-normal", toolName: "run_command", input, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(done.status).toBe("success");
    if (done.status !== "success") throw new Error("unreachable");
    expect((done.output as { sandbox?: { enforcement?: string } }).sandbox?.enforcement).toBe("full");
    expect(okPort.getPrepared()).toBe(1);
  });

  it("休眠降级权威底座：冻结后 validateApproval 持久原子认领一次，重放拒绝", async () => {
    const fixture = await createAuthorityFixture();
    const request = await seedDegradeDecision(fixture, "a-dormant");
    const validate = (inputHash: string) => fixture.validateApproval({
      approvalId: "a-dormant",
      decision: "allow_once",
      callId: request.callId,
      toolName: request.toolName,
      inputHash,
      constraint: request.constraint,
    });
    expect(await validate("hash-degrade")).toBe(true);
    // 已认领后重复重放（崩溃窗口/重复 continue）不得再次直执。
    expect(await validate("hash-degrade")).toBe(false);
  });

  it("休眠降级权威底座：输入变更与过期 TTL 的决策被拒绝", async () => {
    const fixture = await createAuthorityFixture();
    const request = await seedDegradeDecision(fixture, "a-mismatch");
    expect(await fixture.validateApproval({ approvalId: "a-mismatch", decision: "allow_once", callId: request.callId, toolName: request.toolName, inputHash: "other-hash", constraint: request.constraint })).toBe(false);
    await seedDegradeDecision(fixture, "a-expired", { expiresAt: "2020-01-01T00:00:00Z" });
    expect(await fixture.validateApproval({ approvalId: "a-expired", decision: "allow_once", callId: request.callId, toolName: request.toolName, inputHash: "hash-degrade", constraint: request.constraint })).toBe(false);
  });
});
