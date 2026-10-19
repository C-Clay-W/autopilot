/** Stage3 单目标真实Core审批与签发合成测试；fake prepare始终拒绝，无任何真实spawn/沙箱。 */
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../runtime/adapters/memory";
import { createApprovalService } from "../../runtime/application/approval-service";
import { SandboxPortError, type SandboxPort } from "../../runtime/ports";
import type { SandboxExecutionRequest } from "../../runtime/domain/sandbox-policy";
import { computeExternalExecutionConstraint, type ExternalWriteCapability } from "../../runtime/domain/external-execution";
import { createRunCommandTool } from "./builtins/run-command-tool";
import { createStartBackgroundJobTool, startBackgroundJobSchema } from "./builtins/start-background-job-tool";
import type { JobService } from "../../runtime/application/job-service";
import { ToolExecutor } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";
import type { ExternalExecutionAuthority, ToolApprovalDecision, ToolExecutionRequest, ToolExecutionResult, ToolPermissionMode } from "./types";
import { claimExternalWriteCapability, issueExternalWriteCapability } from "./permissions/external-execution-policy";
import { createJobService } from "../../runtime/application/job-service";

const roots: string[] = [];
afterEach(async function cleanFixtures() { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** 使用真实ApprovalService/MemoryStore；仅平台prepare由mock记录后拒绝，绝不spawn。 */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage3-capability-"));
  roots.push(root);
  await mkdir(path.join(root, "workspace"));
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "outside", "target.txt"), "seed");
  const workspaceRoot = await realpath(path.join(root, "workspace"));
  const target = await realpath(path.join(root, "outside", "target.txt"));
  const ports = createMemoryPorts(workspaceRoot);
  const snapshot = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
  let failProjection = false;
  const approvals = createApprovalService({ ...ports, externalRuleProjector: {
    async read() { return snapshot; },
    async project(input) {
      if (failProjection) throw new Error("fixture projection failure");
      if (input.action === "add") snapshot.allow.push(input.rule);
      else snapshot.allow = snapshot.allow.filter(function retain(rule) { return rule !== input.rule; });
    },
  } });
  const prepared: SandboxExecutionRequest[] = [];
  const port: SandboxPort = {
    async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; },
    async setup() { throw new Error("禁止setup"); },
    async prepare(request) { prepared.push(request); throw new SandboxPortError("SANDBOX_UNAVAILABLE", "fixture精确文件能力未支持"); },
    async release() {},
    async shutdown() {},
  };

  /** 每Session/Turn独立桥接服务，恢复重建Executor仍共享durable批准/消费状态。 */
  async function executor(sessionId = "s1", mode: ToolPermissionMode = "full_access", toolName = "run_command", sandboxMode: "workspace-write" | "read-only" = "workspace-write", authorityOverride?: ExternalExecutionAuthority) {
    const turnId = `t-${sessionId}`;
    await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
    await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot }, startedAt: 1 });
    const registry = new ToolRegistry();
    registry.register(toolName === "run_command" ? createRunCommandTool() : createStartBackgroundJobTool({ workspaceRoot, workspaceId: workspaceRoot, sessionId, turnId, jobs: {
      async start(input: import("../../runtime/domain/job").StartJobInput) { await input.sandbox!.port.prepare({ commandId: input.sandbox!.policy.externalWriteCapability!.executionId, program: input.program, args: input.args, cwd: workspaceRoot, policy: input.sandbox!.policy }); throw new Error("prepare必须拒绝"); },
    } as unknown as JobService }));
    const authority: ExternalExecutionAuthority = authorityOverride ?? {
      async freeze(input) { await approvals.freezeExecutionApproval({ workspaceRoot, sessionId, turnId, ...input }); },
      async authorize(input) { return approvals.authorizeExecution({ workspaceRoot, sessionId, turnId, ...input }); },
    };
    return new ToolExecutor(registry, { workspaceRoot, executionSessionId: sessionId, permissionMode: mode, workspaceTrusted: true, sandbox: { port, mode: sandboxMode }, externalExecutionAuthority: authority });
  }

  /** 仅记录公开审批与原请求checkpoint；canonical私有目标由ApprovalStore另存。 */
  async function record(result: ToolExecutionResult, request: ToolExecutionRequest, decision: ToolApprovalDecision = "allow_once", sessionId = "s1") {
    if (result.status !== "approval_required") throw new Error("期望approval_required");
    const turnId = `t-${sessionId}`;
    expect(JSON.stringify(result.approval)).not.toContain(JSON.stringify(target).slice(1, -1));
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: request.callId, name: request.toolName, input: request.input }] });
    await ports.transcriptStore.append(sessionId, { sessionId, turnId, seq: 1, timestamp: ports.clock.timestamp(), event: { type: "approval_required", turnId, stepId: "step", callId: request.callId, toolName: request.toolName, result } });
    const saved = await approvals.submit({ sessionId, turnId, approvalId: result.approval.approvalId, decision });
    return { approvalId: saved.approvalId, decision };
  }
  const request: ToolExecutionRequest = { callId: "c1", toolName: "run_command", input: { program: "node", args: [], cwd: ".", externalWriteTarget: target } };
  return { root, workspaceRoot, target, ports, approvals, snapshot, prepared, port, executor, record, request, failProjection: function fail() { failProjection = true; } };
}

describe("Stage3 单目标执行能力", function executionCapabilities() {
  it("全部模式四项审批，模型声明/裸根参数不成为能力", async function requiresRealApproval() {
    const f = await fixture();
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      const executor = await f.executor(`s-${mode}`, mode);
      const result = await executor.execute(f.request);
      expect(result.status).toBe("approval_required");
      if (result.status === "approval_required") expect(result.approval.allowedDecisions).toEqual(["allow_once", "allow_session", "allow_workspace", "deny"]);
    }
    expect(f.prepared).toHaveLength(0);
    expect(createRunCommandTool().inputSchema.safeParse({ ...(f.request.input as object), allowedExternalWriteRoots: [path.dirname(f.target)] }).success).toBe(false);
  });

  it.each(["allow_once", "allow_session", "allow_workspace"] as const)("%s 正确签发、恢复、后续调用与独立executionId", async function lifetime(decision) {
    const f = await fixture();
    const first = await f.executor();
    const approval = await f.record(await first.execute(f.request), f.request, decision);
    const restored = await f.executor();
    const result = await restored.execute({ ...f.request, approval });
    expect(result).toMatchObject({ status: "error", error: { code: "SANDBOX_UNAVAILABLE" } });
    const capability = f.prepared[0]!.policy.externalWriteCapability!;
    expect(capability).toMatchObject({ schemaVersion: 1, lifetime: decision, toolName: "run_command", callId: "c1", target: { canonicalTarget: f.target, scope: "file", operation: "write" } });
    expect(f.prepared[0]!.commandId).toBe(capability.executionId);
    expect(f.prepared[0]!.policy.allowedDomains).toEqual([]);
    const second = await (await f.executor()).execute({ ...f.request, callId: "c2" });
    if (decision === "allow_once") {
      expect(second.status).toBe("approval_required");
      expect(await (await f.executor()).execute({ ...f.request, approval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
      expect(f.prepared).toHaveLength(1);
    } else {
      expect(second).toMatchObject({ status: "error", error: { code: "SANDBOX_UNAVAILABLE" } });
      expect(f.prepared[1]!.policy.externalWriteCapability).not.toBe(capability);
      expect(f.prepared[1]!.commandId).not.toBe(capability.executionId);
      const anotherSession = await (await f.executor("s2")).execute({ ...f.request, callId: "c3" });
      expect(anotherSession.status).toBe(decision === "allow_workspace" ? "error" : "approval_required");
    }
  });

  it("一次批准并发恢复只消费一次；TTL过期拒绝", async function atomicReplayAndExpiry() {
    const f = await fixture();
    const approval = await f.record(await (await f.executor()).execute(f.request), f.request);
    const first = await f.executor();
    const second = await f.executor();
    const results = await Promise.all([first.execute({ ...f.request, approval }), second.execute({ ...f.request, approval })]);
    expect(results.map(function code(result) { return result.status === "error" ? result.error.code : result.status; }).sort()).toEqual(["APPROVAL_MISMATCH", "SANDBOX_UNAVAILABLE"]);
    expect(f.prepared).toHaveLength(1);
    const freshRequest = { ...f.request, callId: "expired" };
    const freshApproval = await f.record(await (await f.executor()).execute(freshRequest), freshRequest);
    vi.spyOn(f.ports.clock, "timestamp").mockReturnValue("2099-01-01T00:00:00Z");
    expect(await (await f.executor()).execute({ ...freshRequest, approval: freshApproval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    expect(f.prepared).toHaveLength(1);
  });

  it("主体、命令、目标、工作区隔离；文件grant/孤儿Write投影不能给命令权", async function separatesSubjects() {
    const f = await fixture();
    await f.ports.approvalStore.savePersistentGrant({ scope: "allow_session", sessionId: "s1", toolName: "write_file", constraint: `ext-file:${f.target}`, createdAt: f.ports.clock.timestamp() });
    f.snapshot.allow.push(`Write(${f.target})`);
    const initial = await (await f.executor()).execute(f.request);
    expect(initial.status).toBe("approval_required");
    await f.record(initial, f.request, "allow_workspace");
    const changedCommand = { ...f.request, input: { ...(f.request.input as object), args: ["--version"] } };
    expect((await (await f.executor()).execute(changedCommand)).status).toBe("approval_required");
    const changedTarget = { ...f.request, input: { ...(f.request.input as object), externalWriteTarget: path.join(path.dirname(f.target), "other.txt") } };
    expect((await (await f.executor()).execute(changedTarget)).status).toBe("approval_required");
    const jobRequest = { ...f.request, toolName: "start_background_job" };
    const jobResult = await (await f.executor("s1", "full_access", "start_background_job")).execute(jobRequest);
    expect(jobResult.status).toBe("approval_required");
    const jobApproval = await f.record(jobResult, jobRequest, "allow_session");
    expect(await (await f.executor("s1", "full_access", "start_background_job")).execute({ ...jobRequest, approval: jobApproval })).toMatchObject({ status: "error", error: { code: "SANDBOX_UNAVAILABLE" } });
    expect(f.prepared[0]?.policy.externalWriteCapability?.toolName).toBe("start_background_job");
    const grant = (await f.ports.approvalStore.listPersistentGrants({ workspaceRoot: f.workspaceRoot })).find(function command(candidate) { return candidate.toolName === "run_command"; })!;
    const alternateTarget = { ...grant.executionTarget!, canonicalWorkspace: path.join(f.root, "another-workspace") };
    expect(await f.approvals.hasPersistentGrant({ workspaceRoot: alternateTarget.canonicalWorkspace, sessionId: "s1", toolName: "run_command", constraint: computeExternalExecutionConstraint("run_command", alternateTarget) })).toBe(false);
    expect(await f.approvals.hasPersistentGrant({ workspaceRoot: f.workspaceRoot, sessionId: "s1", toolName: "run_command", constraint: "ext-exec-file:v9:old" })).toBe(false);
  });

  it("pending/删投影/deny/ask/撤grant均fail-closed；私有身份不进入公开grant列表", async function narrowsProjectionAndRevokes() {
    const f = await fixture();
    const result = await (await f.executor()).execute(f.request);
    const originalApproval = await f.record(result, f.request, "allow_workspace");
    if (result.status !== "approval_required") throw new Error("需要审批");
    const query = { workspaceRoot: f.workspaceRoot, sessionId: "s1", toolName: "run_command", constraint: result.approval.constraint! };
    expect(await f.approvals.hasPersistentGrant(query)).toBe(true);
    expect(JSON.stringify(await f.approvals.listPersistentGrants())).not.toContain(JSON.stringify(f.target).slice(1, -1));
    for (const list of [f.snapshot.deny, f.snapshot.ask]) {
      list.push(`Write(${f.target})`);
      expect(await f.approvals.hasPersistentGrant(query)).toBe(false);
      list.pop();
    }
    f.snapshot.allow = [];
    expect(await f.approvals.hasPersistentGrant(query)).toBe(false);
    f.snapshot.allow.push(`Write(${f.target})`);
    await f.approvals.revokePersistentGrant(query);
    expect(await f.approvals.hasPersistentGrant(query)).toBe(false);
    expect(await (await f.executor()).execute({ ...f.request, approval: originalApproval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    f.failProjection();
    const pending = await (await f.executor()).execute({ ...f.request, callId: "pending" });
    await f.record(pending, { ...f.request, callId: "pending" }, "allow_workspace");
    expect(await f.approvals.hasPersistentGrant(query)).toBe(false);
  });

  it("链接改变后不能转移批准；read-only和注入端口对象均不能签发", async function rejectsChangedTargetAndForgery() {
    const f = await fixture();
    const alias = path.join(f.root, "alias");
    const secondRoot = path.join(f.root, "second");
    await mkdir(secondRoot);
    await writeFile(path.join(secondRoot, "target.txt"), "second");
    await symlink(path.dirname(f.target), alias, process.platform === "win32" ? "junction" : "dir");
    const linked = { ...f.request, input: { ...(f.request.input as object), externalWriteTarget: path.join(alias, "target.txt") } };
    const approval = await f.record(await (await f.executor()).execute(linked), linked);
    await unlink(alias);
    await symlink(secondRoot, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await (await f.executor()).execute({ ...linked, approval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    expect(await (await f.executor("s1", "full_access", "run_command", "read-only")).execute(f.request)).toMatchObject({ status: "error", error: { code: "SANDBOX_POLICY_DENIED" } });
    const forged: ExternalExecutionAuthority = { async freeze() {}, async authorize() { return { lifetime: "allow_workspace", sessionId: "s1", canonicalWorkspace: f.workspaceRoot }; } };
    expect(await (await f.executor("s1", "full_access", "run_command", "workspace-write", forged)).execute(f.request)).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    expect(f.prepared).toHaveLength(0);
    const direct = createRunCommandTool();
    await expect(direct.execute(direct.inputSchema.parse(f.request.input), { workspaceRoot: f.workspaceRoot, permissionMode: "full_access", toolCallId: "c1", sandboxPolicy: { port: f.port, policy: { mode: "workspace-write", workspaceRoot: f.workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [], externalWriteCapability: {} as ExternalWriteCapability } } })).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
  });

  it("同callId/目标/命令改timeout仍不能认领已签发能力，完整hash保留", async function bindsFullNormalizedInput() {
    const f = await fixture();
    const result = await (await f.executor()).execute(f.request);
    const approval = await f.record(result, f.request);
    if (result.status !== "approval_required") throw new Error("需要审批");
    const parsed = createRunCommandTool().inputSchema.parse(f.request.input);
    const authorization = await f.approvals.authorizeExecution({ workspaceRoot: f.workspaceRoot, sessionId: "s1", turnId: "t-s1", toolName: "run_command", callId: "c1", input: parsed, inputHash: result.approval.normalizedInputHash, constraint: result.approval.constraint!, approval });
    const frozen = await f.ports.approvalStore.getExecutionApproval!({ sessionId: "s1", turnId: "t-s1", approvalId: approval.approvalId });
    const capability = issueExternalWriteCapability({ target: frozen!.target, toolName: "run_command", callId: "c1", inputHash: result.approval.normalizedInputHash, authorization: authorization! });
    const context = { workspaceRoot: f.workspaceRoot, executionSessionId: "s1", permissionMode: "full_access" as const, toolCallId: "c1", sandboxPolicy: { port: {} as SandboxPort, policy: { mode: "workspace-write" as const, workspaceRoot: f.workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [], externalWriteCapability: capability } } };
    await expect(claimExternalWriteCapability("run_command", { ...parsed, timeoutMs: parsed.timeoutMs + 1 }, context)).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
    await expect(claimExternalWriteCapability("run_command", parsed, context)).resolves.toBeUndefined();
    await expect(claimExternalWriteCapability("run_command", parsed, context)).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
    expect(f.prepared).toHaveLength(0);
  });

  it("JobService直入不能跳过工具认领、Session归属或重复分派", async function guardsDirectJobService() {
    const f = await fixture();
    const request = { ...f.request, toolName: "start_background_job" };
    const first = await f.executor("s1", "full_access", "start_background_job");
    const approval = await f.record(await first.execute(request), request);
    const result = await first.execute({ ...request, approval });
    expect(result).toMatchObject({ status: "error", error: { code: "SANDBOX_UNAVAILABLE" } });
    const captured = f.prepared[0]!;
    const jobs = createJobService({ store: f.ports.jobStore, ownerProbe: f.ports.jobOwnerProbe, sessionStore: f.ports.sessionStore, projectStore: f.ports.projectStore });
    try {
      const input = { ...startBackgroundJobSchema.parse(request.input), workspaceRoot: f.workspaceRoot, workspaceId: f.workspaceRoot, sessionId: "s1", turnId: "t-s1", toolCallId: "c1", sandbox: { port: f.port, policy: captured.policy } };
      await expect(jobs.start({ ...input, sessionId: "s2" })).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
      await expect(jobs.start({ ...input, sandbox: { ...input.sandbox, policy: { ...captured.policy, externalWriteCapability: { ...captured.policy.externalWriteCapability! } } } })).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
      await expect(jobs.start(input)).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
      await expect(jobs.start(input)).rejects.toMatchObject({ toolError: { code: "APPROVAL_MISMATCH" } });
      expect(f.prepared[1]!.commandId).toBe(captured.policy.externalWriteCapability!.executionId);
    } finally { await jobs.shutdown(); }
  });
});
