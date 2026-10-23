/**
 * internal/tools/host-execution.test.ts — Talk-Plan1022 S1 Windows 宿主执行的定向合成测试。
 *
 * 覆盖：宿主 port 下 run_command/start_background_job 的逐次审批闭环（全模式不跳过）、
 * 批准后宿主直执一次成功、拒绝零启动、外部目标经宿主范围签发/认领能力、宿主执行零沙箱
 * 包装调用（prepare 恒为 0）、审批卡如实说明无隔离与后台通道未接通、macOS 形态 binding
 * 照常走沙箱包装路径、升级前遗留的外部 allow_session/allow_workspace 授权不能代替本次
 * 无隔离确认（CR R1）、宿主外部卡标记未知范围与宿主事实而沙箱卡保留精确目标措辞（CR R4/C4）。
 * 仅 spawn node --version 与 node -e 写 fixture 临时文件，不触网络、
 * 不加载 SRT。审批消费分两条真实路径：同实例内存 pendingApprovals（非外部命令）与
 * 持久 ApprovalService（外部命令恢复）。
 */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../runtime/adapters/memory";
import { createApprovalService } from "../../runtime/application/approval-service";
import type { SandboxPort } from "../../runtime/ports";
import type { SandboxExecutionRequest } from "../../runtime/domain/sandbox-policy";
import { createRunCommandTool } from "./builtins/run-command-tool";
import { createStartBackgroundJobTool } from "./builtins/start-background-job-tool";
import type { JobService } from "../../runtime/application/job-service";
import { ToolExecutor } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";
import type { ExternalExecutionAuthority, ToolExecutionRequest, ToolExecutionResult, ToolPermissionMode } from "./types";

const roots: string[] = [];
afterEach(async function cleanFixtures() { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** 记录 status/prepare 调用次数的宿主执行 fake port；prepare 恒拒绝以证明零沙箱包装。 */
function createHostPort(): SandboxPort & { statusCalls: number; prepareCalls: SandboxExecutionRequest[] } {
  return {
    statusCalls: 0,
    prepareCalls: [],
    async status() {
      this.statusCalls += 1;
      return { platform: "windows", backend: "host-execution", enforcement: "unavailable", installed: false, provisioned: false };
    },
    async setup() {
      return { platform: "windows", backend: "host-execution", enforcement: "unavailable", installed: false, provisioned: false };
    },
    async prepare(request) {
      this.prepareCalls.push(request);
      throw new Error("宿主执行模式下不应调用沙箱包装");
    },
    async release() {},
    async shutdown() {},
  };
}

/** macOS 形态 fake port：enforcement full，prepare 返回真包装以走完整沙箱执行路径。 */
function createMacPort(prepared: SandboxExecutionRequest[]): SandboxPort {
  return {
    async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; },
    async setup() { throw new Error("禁止setup"); },
    async prepare(request) {
      prepared.push(request);
      return { executionId: "mac-fixture", executable: "node", args: [...request.args], env: {}, enforcement: "full" };
    },
    async release() {},
    async shutdown() {},
  };
}

/** 宿主执行 fixture：真实 ApprovalService + 宿主 port；run_command 直执、后台 Job 以 stub 记录。 */
async function fixture(toolName: "run_command" | "start_background_job" = "run_command") {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan1022-host-"));
  roots.push(root);
  await mkdir(path.join(root, "workspace"));
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "outside", "target.txt"), "seed");
  const workspaceRoot = await realpath(path.join(root, "workspace"));
  const target = await realpath(path.join(root, "outside", "target.txt"));
  const ports = createMemoryPorts(workspaceRoot);
  // 投影快照可读写：allow_workspace 的旧外部授权必须投影为 synced 才算成立，用于模拟升级前遗留 grant。
  const snapshot = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
  const approvals = createApprovalService({ ...ports, externalRuleProjector: {
    async read() { return snapshot; },
    async project(input) {
      if (input.action === "add") snapshot.allow.push(input.rule);
      else snapshot.allow = snapshot.allow.filter(function retain(rule) { return rule !== input.rule; });
    },
  } });
  const port = createHostPort();
  const jobStarts: unknown[] = [];
  const turnId = "t1";
  await ports.sessionStore.save({ id: "s1", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
  await ports.turnStore.save({ id: turnId, sessionId: "s1", status: "waiting_approval", frozenRunConfig: { workspaceRoot }, startedAt: 1 });
  const registry = new ToolRegistry();
  if (toolName === "run_command") registry.register(createRunCommandTool());
  else registry.register(createStartBackgroundJobTool({
    workspaceRoot, workspaceId: workspaceRoot, sessionId: "s1", turnId,
    jobs: {
      async start(input: import("../../runtime/domain/job").StartJobInput) { jobStarts.push(input); return { id: "job-stub", workspaceId: input.workspaceId, sessionId: input.sessionId, program: input.program, args: input.args, cwd: input.cwd, status: "running", startedAt: 1, updatedAt: 1, output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } }; },
    } as unknown as JobService,
  }));
  const authority: ExternalExecutionAuthority = {
    async freeze(input) { await approvals.freezeExecutionApproval({ workspaceRoot, sessionId: "s1", turnId, ...input }); },
    async authorize(input) { return approvals.authorizeExecution({ workspaceRoot, sessionId: "s1", turnId, ...input }); },
  };
  function executor(mode: ToolPermissionMode = "full_access", overrides?: { resolvePersistentGrantTrue?: boolean; sandboxPort?: SandboxPort }) {
    return new ToolExecutor(registry, {
      workspaceRoot,
      executionSessionId: "s1",
      permissionMode: mode,
      workspaceTrusted: true,
      sandbox: { port: overrides?.sandboxPort ?? port, mode: "workspace-write" },
      externalExecutionAuthority: authority,
      ...(overrides?.resolvePersistentGrantTrue ? { resolvePersistentGrant: async () => true } : {}),
    });
  }
  /** 记录审批 checkpoint 并提交决定，返回可回放的 approval 凭证。 */
  async function record(result: ToolExecutionResult, request: ToolExecutionRequest, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny" = "allow_once") {
    if (result.status !== "approval_required") throw new Error("期望 approval_required");
    await ports.checkpointStore.save("s1", { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: request.callId, name: request.toolName, input: request.input }] });
    await ports.transcriptStore.append("s1", { sessionId: "s1", turnId, seq: 1, timestamp: ports.clock.timestamp(), event: { type: "approval_required", turnId, stepId: "step", callId: request.callId, toolName: request.toolName, result } });
    const saved = await approvals.submit({ sessionId: "s1", turnId, approvalId: result.approval.approvalId, decision });
    return saved.approvalId;
  }
  return { root, workspaceRoot, target, port, approvals, jobStarts, executor, record };
}

describe("Talk-Plan1022 S1 Windows 宿主执行", function hostExecutionSuite() {
  it("全模式逐次审批：grant/full_access/auto_approve 不跳过，审批卡如实说明无隔离且 allowedDecisions 收窄", async function requiresPerCallApproval() {
    const f = await fixture();
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["--version"], cwd: "." } };
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      const result = await f.executor(mode).execute(request);
      expect(result.status).toBe("approval_required");
      if (result.status === "approval_required") {
        expect(result.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
        expect(result.approval.reason).toContain("宿主执行");
        expect(result.approval.reason).toContain("未启用沙箱隔离");
        expect(result.display?.executionMode).toBe("unisolated");
        // S3：审批卡携带结构化执行方式事实，Web/CLI 据此渲染无隔离说明。
        expect(result.approval.display?.executionMode).toBe("unisolated");
      }
    }
    const granted = await f.executor("auto_approve", { resolvePersistentGrantTrue: true });
    await expect(granted.execute(request)).resolves.toMatchObject({ status: "approval_required" });
    expect(f.port.prepareCalls).toHaveLength(0);
  });

  it("批准后宿主直执一次成功、结果展示 unisolated、SRT 包装调用为零；allow_once 不复用", async function executesOnceAfterApproval() {
    const f = await fixture();
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["--version"], cwd: ".", timeoutMs: 10000 } };
    const exec = f.executor();
    const approvalId = await f.record(await exec.execute(request), request);
    const result = await exec.execute({ ...request, approval: { approvalId, decision: "allow_once" } });
    expect(result).toMatchObject({ status: "success" });
    if (result.status === "success") {
      expect((result.output as { exitCode: number }).exitCode).toBe(0);
      expect(result.display?.executionMode).toBe("unisolated");
    }
    expect(f.port.prepareCalls).toHaveLength(0);
    const second = await f.executor().execute({ ...request, callId: "c2" });
    expect(second.status).toBe("approval_required");
  });

  it("拒绝后零执行；只读命令同样逐次确认", async function denyAndReadOnlyStillAsk() {
    const f = await fixture();
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["--version"], cwd: "." } };
    const exec = f.executor();
    const approvalId = await f.record(await exec.execute(request), request, "deny");
    const denied = await exec.execute({ ...request, approval: { approvalId, decision: "deny" } });
    expect(denied.status).toBe("denied");
    const readOnly = await f.executor("auto_approve").execute({ ...request, callId: "c3" });
    expect(readOnly.status).toBe("approval_required");
  });

  it("外部目标：宿主范围签发能力、批准后真实执行并写入目标", async function externalTargetThroughHostScope() {
    const f = await fixture();
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["-e", "require('fs').writeFileSync(process.argv[1],'written')", f.target], cwd: ".", externalWriteTarget: f.target, timeoutMs: 15000 } };
    const first = await f.executor().execute(request);
    expect(first.status).toBe("approval_required");
    if (first.status === "approval_required") {
      expect(first.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
      // CR R4：宿主命令即便声明了外部目标，也不得宣称"仅覆盖精确目标"；宿主事实单独标识来源。
      expect(first.approval.display?.unknownScope).toBe(true);
      expect(first.approval.display?.hostExecution).toBe(true);
      expect(first.approval.display?.executionMode).toBe("unisolated");
    }
    const approvalId = await f.record(first, request);
    const result = await f.executor().execute({ ...request, approval: { approvalId, decision: "allow_once" } });
    expect(result).toMatchObject({ status: "success" });
    await expect(readFile(f.target, "utf8")).resolves.toBe("written");
    expect(f.port.prepareCalls).toHaveLength(0);
  });

  it("CR R4/C4：沙箱平台外部命令卡保持精确目标措辞，且不携带宿主执行事实", async function sandboxExternalCardKeepsPreciseScope() {
    const f = await fixture();
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["--version"], cwd: ".", externalWriteTarget: f.target, timeoutMs: 10000 } };
    const result = await f.executor("full_access", { sandboxPort: createMacPort([]) }).execute(request);
    expect(result.status).toBe("approval_required");
    if (result.status === "approval_required") {
      // 沙箱形态仍由 OS 精确限定文件范围：保留原有精确目标措辞来源（unknownScope 缺省）。
      expect(result.approval.display?.unknownScope).toBeUndefined();
      expect(result.approval.display?.hostExecution).toBeUndefined();
      expect(result.approval.display?.executionMode).toBe("sandboxed");
    }
  });

  it.each([
    ["run_command", "allow_session"],
    ["run_command", "allow_workspace"],
    ["start_background_job", "allow_session"],
    ["start_background_job", "allow_workspace"],
  ] as const)("CR R1：旧 %s 外部持久授权（%s）不能让宿主调用跳过逐次确认", async function legacyGrantCannotSkipHostApproval(toolName, decision) {
    const f = await fixture(toolName);
    // 仅前台命令真实写目标文件；后台 Job 由 stub 记录启动次数，目标文件始终是零执行的观察点。
    const args = toolName === "run_command"
      ? ["-e", "require('fs').writeFileSync(process.argv[1],'written')", f.target]
      : ["--version"];
    const request: ToolExecutionRequest = { callId: "c1", toolName, input: { program: "node", args, cwd: ".", externalWriteTarget: f.target, ...(toolName === "run_command" ? { timeoutMs: 15000 } : {}) } };
    // 1) 升级前沙箱形态：真实审批一次并"记住"，由 ApprovalService 写入旧持久授权。
    const legacyCard = await f.executor("full_access", { sandboxPort: createMacPort([]) }).execute(request);
    if (legacyCard.status !== "approval_required") throw new Error("期望升级前审批卡");
    await f.record(legacyCard, request, decision);
    const grantQuery = { workspaceRoot: f.workspaceRoot, sessionId: "s1", toolName, constraint: legacyCard.approval.constraint! };
    await expect(f.approvals.hasPersistentGrant(grantQuery)).resolves.toBe(true);

    // 2) 升级后宿主 port、未携带本次审批：旧 grant 不能代替无隔离确认，必须重新弹卡且零执行。
    const card = await f.executor().execute(request);
    expect(card.status).toBe("approval_required");
    expect(f.jobStarts).toHaveLength(0);
    await expect(readFile(f.target, "utf8")).resolves.toBe("seed");

    // 3) 本次 allow_once 经 ApprovalService 原子消费后恰好执行一次。
    const approvalId = await f.record(card, request);
    const approved = await f.executor().execute({ ...request, approval: { approvalId, decision: "allow_once" } });
    expect(approved).toMatchObject({ status: "success" });
    expect(f.jobStarts).toHaveLength(toolName === "start_background_job" ? 1 : 0);
    await expect(readFile(f.target, "utf8")).resolves.toBe(toolName === "run_command" ? "written" : "seed");

    // 4) grant 仍然有效也不能免除下一调用的确认。
    await writeFile(f.target, "seed");
    const second = await f.executor().execute({ ...request, callId: "c2" });
    expect(second.status).toBe("approval_required");
    expect(f.jobStarts).toHaveLength(toolName === "start_background_job" ? 1 : 0);
    await expect(readFile(f.target, "utf8")).resolves.toBe("seed");

    // 5) 拒绝优先：本次拒绝不启动任何目标。
    const denyRequest: ToolExecutionRequest = { ...request, callId: "c3" };
    const denyCard = await f.executor().execute(denyRequest);
    expect(denyCard.status).toBe("approval_required");
    const denied = await f.executor().execute({ ...denyRequest, approval: { approvalId: await f.record(denyCard, denyRequest, "deny"), decision: "deny" } });
    expect(denied.status).toBe("denied");
    expect(f.jobStarts).toHaveLength(toolName === "start_background_job" ? 1 : 0);
    await expect(readFile(f.target, "utf8")).resolves.toBe("seed");
  });

  it("start_background_job：宿主范围贯穿 JobService——审批逐次确认、批准后恰好一次启动且输入带 host 标记、拒绝零启动", async function backgroundJobHostDispatch() {
    const f = await fixture("start_background_job");
    const request: ToolExecutionRequest = { callId: "c1", toolName: "start_background_job", input: { program: "node", args: ["--version"], cwd: "." } };
    const exec = f.executor();
    const first = await exec.execute(request);
    expect(first.status).toBe("approval_required");
    if (first.status === "approval_required") {
      // S2：审批卡仍如实说明无隔离事实，但不再宣称通道未接通。
      expect(first.approval.reason).toContain("宿主执行");
      expect(first.approval.reason).toContain("未启用沙箱隔离");
      expect(first.approval.reason).not.toContain("尚未接通");
      expect(first.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
      expect(first.approval.display?.executionMode).toBe("unisolated");
    }
    const approvalId = await f.record(first, request);
    const approved = await exec.execute({ ...request, approval: { approvalId, decision: "allow_once" } });
    expect(approved).toMatchObject({ status: "success" });
    if (approved.status === "success") {
      expect(approved.output).toMatchObject({ jobId: "job-stub", sandbox: { mode: "workspace-write", execution: "host" } });
      expect(approved.display?.executionMode).toBe("unisolated");
    }
    // S1 审批链核验结果贯穿：恰一次启动，输入携带宿主执行范围，无沙箱包装调用。
    expect(f.jobStarts).toHaveLength(1);
    expect((f.jobStarts[0] as { sandbox: { execution?: string } }).sandbox.execution).toBe("host");
    expect(f.port.prepareCalls).toHaveLength(0);
    const again = await f.executor().execute({ ...request, callId: "c2" });
    expect(again.status).toBe("approval_required");
    expect(f.jobStarts).toHaveLength(1);
  });

  it("macOS 形态 binding 不变：照常探测并走沙箱包装执行，宿主分支不介入", async function macosBehaviorUnchanged() {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan1022-mac-"));
    roots.push(root);
    await mkdir(path.join(root, "workspace"));
    const workspaceRoot = await realpath(path.join(root, "workspace"));
    const prepared: SandboxExecutionRequest[] = [];
    const registry = new ToolRegistry();
    registry.register(createRunCommandTool());
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      executionSessionId: "s1",
      permissionMode: "full_access",
      workspaceTrusted: true,
      sandbox: { port: createMacPort(prepared), mode: "workspace-write" },
    });
    const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: ["--version"], cwd: ".", timeoutMs: 10000 } };
    const result = await executor.execute(request);
    expect(result).toMatchObject({ status: "success" });
    if (result.status === "success") {
      expect((result.output as { sandbox: { enforcement: string } }).sandbox.enforcement).toBe("full");
    }
    expect(prepared).toHaveLength(1);
  });
});
