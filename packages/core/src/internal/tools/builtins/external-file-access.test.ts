/**
 * 外部文件访问执行链测试（Talk-Plan1013 Stage 1）：在 ToolExecutor 端到端验证
 * G1 读取免新增路径审批、G2 未授权零修改、G9 全模式外部修改 gate、G4 单次授权范围、
 * 以及 allow_once 授权不可经链接切换转移。真实工作区冒烟使用老大指定的
 * AGENT_WORKSPACE_ROOT / AGENT_WORKSPACE_ROOT_OUTSIDE，全部合成临时文件并用后清理。
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "./read-file-tool";
import { createEditFileTool } from "./edit-file-tool";
import { createWriteFileTool } from "./write-file-tool";
import { ToolExecutor } from "../tool-executor";
import { ToolRegistry } from "../tool-registry";
import { TOOL_ERROR_CODES } from "../tool-error";
import type { ToolExecutionContext } from "../types";
import { createMemoryPorts } from "../../../runtime/adapters/memory";
import { createApprovalService } from "../../../runtime/application/approval-service";
import { createTurnRuntimeConfigResolver } from "../../../runtime/application/turn/turn-runtime-config-resolver";
import type { FrozenRunConfig } from "../../../runtime/domain";
import type { RunConfig } from "../../../runtime/protocol";

const temporaryRoots: string[] = [];

/** 创建独立临时工作区与其外部的目标根，两者互不嵌套。 */
async function createWorkspaceWithOutside(): Promise<{ workspaceRoot: string; outsideRoot: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "talk-plan1013-exec-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const outsideRoot = path.join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { workspaceRoot, outsideRoot };
}

/** 清理本文件创建的全部临时目录。 */
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 构造带文件工具的执行器；可选注入持久授权判定与当前外部限制判定，模拟 Runtime 已校验的外部精确 grant 与 deny/ask 规则。 */
function createExecutor(workspaceRoot: string, permissionMode: ToolExecutionContext["permissionMode"], options: { workspaceTrusted?: boolean; externalGrantMatched?: boolean; restriction?: "allow" | "ask" | "deny" | (() => "allow" | "ask" | "deny"); validateApproval?: ToolExecutionContext["validateApproval"]; fileMutations?: ToolExecutionContext["fileMutations"] } = {}): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  registry.register(createEditFileTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode,
    workspaceTrusted: options.workspaceTrusted ?? false,
    fileReadStates: new Map(),
    ...(options.externalGrantMatched ? {
      resolvePersistentGrant: async (request) => typeof request.constraint === "string" && request.constraint.startsWith("ext-file:"),
    } : {}),
    ...(options.restriction ? {
      resolveExternalRestriction: async () => typeof options.restriction === "function" ? options.restriction() : options.restriction!,
    } : {}),
    ...(options.validateApproval ? { validateApproval: options.validateApproval } : {}),
    ...(options.fileMutations ? { fileMutations: options.fileMutations } : {}),
  });
}

describe("外部文件访问执行链（Talk-Plan1013 Stage 1）", () => {
  it("G1：full_access 下合法外部读取直接成功且免审批，返回 canonical 绝对路径", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(outsideRoot, "readable.txt"), "external-content", "utf8");
    const result = await createExecutor(workspaceRoot, "full_access")
      .execute({ callId: "ext-read", toolName: "read_file", input: { path: path.join(outsideRoot, "readable.txt") } });
    expect(result.status).toBe("success");
    expect(result.status === "success" && (result.output as { path: string; content: string }).content).toBe("external-content");
    expect(result.status === "success" && (result.output as { path: string }).path.toLowerCase()).toBe(path.join(outsideRoot, "readable.txt").toLowerCase());
  });

  it("G1：外部搜索起点同样免新增路径审批，ripgrep 返回可复用的绝对路径", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const nested = path.join(outsideRoot, "sub");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "hit.txt"), "needle-here\n", "utf8");
    const { createGlobFilesTool } = await import("./glob-files-tool");
    const globRegistry = new ToolRegistry();
    globRegistry.register(createGlobFilesTool());
    const globExecutor = new ToolExecutor(globRegistry, {
      workspaceRoot,
      permissionMode: "full_access",
      fileReadStates: new Map(),
    });
    const glob = await globExecutor.execute({ callId: "ext-glob", toolName: "glob_files", input: { pattern: "**/*.txt", path: outsideRoot } });
    expect(glob.status).toBe("success");
    expect(glob.status === "success" && (glob.output as { files: string[] }).files.some((filePath) => filePath.toLowerCase().endsWith("hit.txt"))).toBe(true);
  });

  it("G9：full_access 下外部新建仍返回 approval_required，且审批前不创建父目录、不写目标（G2 零修改）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "fresh-dir", "fresh.txt");
    const pending = await createExecutor(workspaceRoot, "full_access")
      .execute({ callId: "ext-create", toolName: "write_file", input: { path: targetFile, content: "hello" } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    expect(pending.approval.constraint).toMatch(/^ext-file:/);
    expect(pending.approval.display?.effect).toBe("external");
    await expect(stat(path.join(outsideRoot, "fresh-dir"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("G4：批准 allow_once 后原位写入外部目标；目标内容与哈希一致", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "approved.txt");
    const executor = createExecutor(workspaceRoot, "full_access");
    const pending = await executor.execute({ callId: "ext-approved", toolName: "write_file", input: { path: targetFile, content: "approved-by-user" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const done = await executor.execute({
      callId: "ext-approved",
      toolName: "write_file",
      input: { path: targetFile, content: "approved-by-user" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(done.status).toBe("success");
    expect(await readFile(targetFile, "utf8")).toBe("approved-by-user");
  });

  it("G9：auto_approve+Trust 也不能自动修改外部文件（模式不构成授权）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const pending = await createExecutor(workspaceRoot, "auto_approve", { workspaceTrusted: true })
      .execute({ callId: "ext-auto", toolName: "write_file", input: { path: path.join(outsideRoot, "auto.txt"), content: "auto" } });
    expect(pending.status).toBe("approval_required");
  });

  it("G4：命中精确外部 grant（ext-file 约束）的外部修改直接放行，无需再次审批", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "granted.txt");
    const result = await createExecutor(workspaceRoot, "ask", { externalGrantMatched: true })
      .execute({ callId: "ext-grant", toolName: "write_file", input: { path: targetFile, content: "granted" } });
    expect(result.status).toBe("success");
    expect(await readFile(targetFile, "utf8")).toBe("granted");
  });

  it("M2：外部编辑先读取建立快照，编辑经 approval_required 后 allow_once 原位生效", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "editable.txt");
    await writeFile(targetFile, "one\ntwo\nthree", "utf8");
    const executor = createExecutor(workspaceRoot, "full_access");
    const read = await executor.execute({ callId: "ext-edit-read", toolName: "read_file", input: { path: targetFile } });
    expect(read.status).toBe("success");
    const pending = await executor.execute({ callId: "ext-edit", toolName: "edit_file", input: { path: targetFile, oldString: "two", newString: "two-edited" } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const done = await executor.execute({
      callId: "ext-edit",
      toolName: "edit_file",
      input: { path: targetFile, oldString: "two", newString: "two-edited" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(done.status).toBe("success");
    expect(await readFile(targetFile, "utf8")).toBe("one\ntwo-edited\nthree");
  });

  it("G6：审批期间目标链接被替换时 allow_once 不转移，消费审批报 APPROVAL_MISMATCH 且新目标零修改", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const firstTarget = path.join(outsideRoot, "target-one");
    const secondTarget = path.join(outsideRoot, "target-two");
    await mkdir(firstTarget, { recursive: true });
    await mkdir(secondTarget, { recursive: true });
    const link = path.join(workspaceRoot, "jlink");
    await symlink(firstTarget, link, "junction");
    const executor = createExecutor(workspaceRoot, "full_access");
    const pending = await executor.execute({ callId: "swap-1", toolName: "write_file", input: { path: path.join(link, "swap.txt"), content: "swapped" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const firstConstraint = pending.approval.constraint;
    expect(firstConstraint).toMatch(/^ext-file:/);
    await rm(link);
    await symlink(secondTarget, link, "junction");
    const swapped = await executor.execute({
      callId: "swap-1",
      toolName: "write_file",
      input: { path: path.join(link, "swap.txt"), content: "swapped" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(swapped.status === "error" && swapped.error.code).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    await expect(stat(path.join(secondTarget, "swap.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(firstTarget, "swap.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Talk-Plan1013 Stage5 R5：外部读取 deny 在任何正文读取前硬拒绝，ask 逐次确认后放行（full_access 也不例外）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "restricted.txt");
    await writeFile(targetFile, "secret-body", "utf8");
    // deny：稳定错误码硬拒绝，正文不返回。
    const denied = await createExecutor(workspaceRoot, "full_access", { restriction: "deny" })
      .execute({ callId: "read-deny", toolName: "read_file", input: { path: targetFile } });
    expect(denied.status).toBe("denied");
    expect(denied.status === "denied" && denied.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
    expect(JSON.stringify(denied)).not.toContain("secret-body");
    // ask：该次调用 approval_required 且范围收窄，不写任何持久规则。
    const askExecutor = createExecutor(workspaceRoot, "full_access", { restriction: "ask" });
    const pending = await askExecutor.execute({ callId: "read-ask", toolName: "read_file", input: { path: targetFile } });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    expect(pending.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
    const approved = await askExecutor.execute({ callId: "read-ask", toolName: "read_file", input: { path: targetFile }, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(approved.status).toBe("success");
    expect(approved.status === "success" && (approved.output as { content: string }).content).toBe("secret-body");
    // allow 与工作区内目标维持读取免新增路径审批。
    const allowed = await createExecutor(workspaceRoot, "full_access", { restriction: "allow" })
      .execute({ callId: "read-allow", toolName: "read_file", input: { path: targetFile } });
    expect(allowed.status).toBe("success");
  });

  it("Talk-Plan1013 Stage5 R5：外部修改 deny/ask 优先于 grant，批准后新增 deny 使执行失败且目标零变化", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const deniedTarget = path.join(outsideRoot, "denied.txt");
    // deny 即便命中持久 grant 也硬拒绝，且不创建目标。
    const denied = await createExecutor(workspaceRoot, "full_access", { externalGrantMatched: true, restriction: "deny" })
      .execute({ callId: "write-deny", toolName: "write_file", input: { path: deniedTarget, content: "blocked" } });
    expect(denied.status).toBe("denied");
    expect(denied.status === "denied" && denied.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
    await expect(stat(deniedTarget)).rejects.toMatchObject({ code: "ENOENT" });

    // ask 即便命中持久 grant 也逐次询问，allowedDecisions 收窄。
    const asked = await createExecutor(workspaceRoot, "full_access", { externalGrantMatched: true, restriction: "ask" })
      .execute({ callId: "write-ask", toolName: "write_file", input: { path: deniedTarget, content: "blocked" } });
    expect(asked.status).toBe("approval_required");
    if (asked.status !== "approval_required") throw new Error("expected approval request");
    expect(asked.approval.allowedDecisions).toEqual(["allow_once", "deny"]);

    // 批准后、执行前限制收紧为 deny：facts 与 Policy 仍放行，消费后重查失败，目标零变化。
    const mutable = { calls: 0 };
    const executor = createExecutor(workspaceRoot, "full_access", { restriction: () => (mutable.calls++ === 2 ? "deny" : "allow") });
    const pending = await executor.execute({ callId: "write-flip", toolName: "write_file", input: { path: deniedTarget, content: "blocked" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const flipped = await executor.execute({
      callId: "write-flip",
      toolName: "write_file",
      input: { path: deniedTarget, content: "blocked" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    expect(flipped.status === "error" && flipped.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
    await expect(stat(deniedTarget)).rejects.toMatchObject({ code: "ENOENT" });

    // edit 的 Edit deny 在准备 diff（读正文）前硬拒绝：未 read_file 也直接 denied，而非 FILE_NOT_READ。
    const editDenied = await createExecutor(workspaceRoot, "full_access", { restriction: "deny" })
      .execute({ callId: "edit-deny", toolName: "edit_file", input: { path: deniedTarget, oldString: "x", newString: "y" } });
    expect(editDenied.status).toBe("denied");
    expect(editDenied.status === "denied" && editDenied.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
  });

  it("Talk-Plan1013 Stage5 R2：恢复路径经 Runtime 权威链核对 constraint/TTL 并持久一次消费", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const targetFile = path.join(outsideRoot, "recovered.txt");
    const sessionId = "s-recovery";
    const turnId = "t-recovery";
    const ports = createMemoryPorts(workspaceRoot);
    const approvals = createApprovalService({ ...ports });
    const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: { permissionMode: "full_access" }, approvalService: approvals });
    const agentOptions = resolver.buildAgentOptions({ workspaceRoot } as FrozenRunConfig, { permissionMode: "full_access" } as RunConfig, sessionId, turnId);
    if (!agentOptions.validateApproval) throw new Error("expected validateApproval bridge");

    // 第一次执行产生审批请求（内存 pending 路径）。
    const first = createExecutor(workspaceRoot, "full_access");
    const pending = await first.execute({ callId: "recover-1", toolName: "write_file", input: { path: targetFile, content: "recovered-body" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const frozenApproval = pending.approval;

    // 宿主经 ApprovalService.submit 落存决定与冻结身份（模拟人类审批）。
    await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
    await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot }, startedAt: 1 });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: frozenApproval.callId, name: frozenApproval.toolName, input: { path: targetFile, content: "recovered-body" } }] });
    await ports.transcriptStore.append(sessionId, {
      seq: 1,
      sessionId,
      turnId,
      timestamp: ports.clock.timestamp(),
      event: {
        type: "approval_required",
        turnId,
        stepId: "step-recovery",
        callId: frozenApproval.callId,
        toolName: frozenApproval.toolName,
        result: { status: "approval_required", callId: frozenApproval.callId, toolName: frozenApproval.toolName, approval: frozenApproval },
      },
    });
    await approvals.submit({ sessionId, turnId, approvalId: frozenApproval.approvalId, decision: "allow_once" });

    // 约束失配与过期决定在恢复校验中直接拒绝（不消费）。
    expect(await agentOptions.validateApproval({ approvalId: frozenApproval.approvalId, decision: "allow_once", callId: frozenApproval.callId, toolName: frozenApproval.toolName, inputHash: frozenApproval.normalizedInputHash, constraint: "ext-file:C:\\elsewhere\\b.txt" })).toBe(false);
    await ports.approvalStore.saveFileApproval?.({ recordType: "external_file_request", sessionId, turnId, approvalId: "a-expired", callId: "c-expired", toolName: "write_file", normalizedInputHash: "hash-expired", constraint: "ext-file:C:\\outside\\expired.txt", expiresAt: "2000-01-01T00:00:00Z" });
    await ports.approvalStore.saveDecision({ approvalId: "a-expired", turnId, sessionId, callId: "c-expired", toolName: "write_file", normalizedInputHash: "hash-expired", constraint: "ext-file:C:\\outside\\expired.txt", expiresAt: "2000-01-01T00:00:00Z", decision: "allow_once", createdAt: "2000-01-01T00:00:00Z" });
    expect(await agentOptions.validateApproval({ approvalId: "a-expired", decision: "allow_once", callId: "c-expired", toolName: "write_file", inputHash: "hash-expired", constraint: "ext-file:C:\\outside\\expired.txt" })).toBe(false);

    // 新建 Executor（pending 为空）走恢复路径：约束一致时放行并持久消费。
    const resumed = createExecutor(workspaceRoot, "full_access", { validateApproval: agentOptions.validateApproval });
    const done = await resumed.execute({
      callId: "recover-1",
      toolName: "write_file",
      input: { path: targetFile, content: "recovered-body" },
      approval: { approvalId: frozenApproval.approvalId, decision: "allow_once" },
    });
    expect(done.status).toBe("success");
    expect(await readFile(targetFile, "utf8")).toBe("recovered-body");

    // 同一 approval 再次恢复：持久一次消费阻止重放。
    const replayed = await createExecutor(workspaceRoot, "full_access", { validateApproval: agentOptions.validateApproval })
      .execute({
        callId: "recover-1",
        toolName: "write_file",
        input: { path: targetFile, content: "recovered-body" },
        approval: { approvalId: frozenApproval.approvalId, decision: "allow_once" },
      });
    expect(replayed.status === "error" && replayed.error.code).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
  });

  it("Talk-Plan1013 Stage5 R2：恢复路径下父链接切换不转移批准，新目标零变化", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const firstTarget = path.join(outsideRoot, "recovery-one");
    const secondTarget = path.join(outsideRoot, "recovery-two");
    await mkdir(firstTarget, { recursive: true });
    await mkdir(secondTarget, { recursive: true });
    const link = path.join(workspaceRoot, "recovery-link");
    await symlink(firstTarget, link, "junction");
    const first = createExecutor(workspaceRoot, "full_access");
    const pending = await first.execute({ callId: "recovery-swap", toolName: "write_file", input: { path: path.join(link, "swap.txt"), content: "swapped" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");

    // 宿主提交后、恢复前父链接改指 secondTarget；恢复路径按当前约束核对，失配即拒绝。
    const ports = createMemoryPorts(workspaceRoot);
    const approvals = createApprovalService({ ...ports });
    await ports.sessionStore.save({ id: "s-swap", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: "t-swap" });
    await ports.turnStore.save({ id: "t-swap", sessionId: "s-swap", status: "waiting_approval", frozenRunConfig: { workspaceRoot }, startedAt: 1 });
    await ports.checkpointStore.save("s-swap", { turnId: "t-swap", status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: pending.approval.callId, name: pending.approval.toolName, input: {} }] });
    await ports.transcriptStore.append("s-swap", {
      seq: 1,
      sessionId: "s-swap",
      turnId: "t-swap",
      timestamp: ports.clock.timestamp(),
      event: {
        type: "approval_required",
        turnId: "t-swap",
        stepId: "step-swap",
        callId: pending.approval.callId,
        toolName: pending.approval.toolName,
        result: { status: "approval_required", callId: pending.approval.callId, toolName: pending.approval.toolName, approval: pending.approval },
      },
    });
    await approvals.submit({ sessionId: "s-swap", turnId: "t-swap", approvalId: pending.approval.approvalId, decision: "allow_once" });

    await rm(link);
    await symlink(secondTarget, link, "junction");
    const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: { permissionMode: "full_access" }, approvalService: approvals });
    const agentOptions = resolver.buildAgentOptions({ workspaceRoot } as FrozenRunConfig, { permissionMode: "full_access" } as RunConfig, "s-swap", "t-swap");
    const resumed = await createExecutor(workspaceRoot, "full_access", { validateApproval: agentOptions.validateApproval })
      .execute({
        callId: "recovery-swap",
        toolName: "write_file",
        input: { path: path.join(link, "swap.txt"), content: "swapped" },
        approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
      });
    expect(resumed.status === "error" && resumed.error.code).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    await expect(stat(path.join(secondTarget, "swap.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(firstTarget, "swap.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Talk-Plan1013 Stage5 R3：批准后等待目标锁期间父链接被替换，锁内 canonical 失配拒绝且新目标零变化", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const dirA = path.join(outsideRoot, "dirA");
    const dirB = path.join(outsideRoot, "dirB");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const targetFile = path.join(dirA, "locked.txt");
    // 锁桩：进入 executeLocked 前把父目录 A 替换为指向 B 的 junction，模拟取得目标锁期间的链接切换。
    const lockingStore = {
      async withWorkspaceLock(_workspaceRoot: string, run: () => Promise<unknown>) {
        await rm(dirA, { recursive: true, force: true });
        await symlink(dirB, dirA, "junction");
        return run();
      },
    } as unknown as NonNullable<ToolExecutionContext["fileMutations"]>["store"];
    const executor = createExecutor(workspaceRoot, "full_access", {
      fileMutations: { store: lockingStore, sessionId: "s-r3-lock", turnId: "t-r3-lock" },
    });
    const pending = await executor.execute({ callId: "r3-lock", toolName: "write_file", input: { path: targetFile, content: "locked-body" } });
    if (pending.status !== "approval_required") throw new Error("expected approval request");
    const swapped = await executor.execute({
      callId: "r3-lock",
      toolName: "write_file",
      input: { path: targetFile, content: "locked-body" },
      approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
    });
    // 锁内当前 canonical 目标已是 B，与批准绑定 A 失配：稳定错误码拒绝，零磁盘变化。
    expect(swapped.status === "error" && swapped.error.code).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    await expect(stat(path.join(dirB, "locked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Talk-Plan1013 Stage5 R3：工作区内目标在 facts 后改指外部，锁内拒绝（内部→外部转移未授权）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const nested = path.join(workspaceRoot, "nested");
    await mkdir(nested, { recursive: true });
    // 锁桩：进入 executeLocked 前把工作区内子目录替换为指向外部根的 junction。
    const switchingStore = {
      async withWorkspaceLock(_workspaceRoot: string, run: () => Promise<unknown>) {
        await rm(nested, { recursive: true, force: true });
        await symlink(outsideRoot, nested, "junction");
        return run();
      },
    } as unknown as NonNullable<ToolExecutionContext["fileMutations"]>["store"];
    const executor = createExecutor(workspaceRoot, "full_access", {
      fileMutations: { store: switchingStore, sessionId: "s-r3-inner", turnId: "t-r3-inner" },
    });
    // facts 阶段为工作区内目标（无 externalMutation、无授权绑定）；锁内解析为外部必须拒绝。
    const result = await executor.execute({ callId: "r3-inner", toolName: "write_file", input: { path: "nested/inner.txt", content: "inner-body" } });
    expect(result.status === "error" && result.error.code).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    await expect(stat(path.join(outsideRoot, "inner.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("env 真实工作区冒烟：AGENT_WORKSPACE_ROOT 内部直接读；AGENT_WORKSPACE_ROOT_OUTSIDE 修改需批准后原位写入（env 缺失跳过）", async () => {
    const realWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT;
    const realOutsideRoot = process.env.AGENT_WORKSPACE_ROOT_OUTSIDE;
    if (!realWorkspaceRoot || !realOutsideRoot) return;
    const insideDir = path.join(realWorkspaceRoot, "talk-plan1013-stage1-exec");
    const outsideDir = path.join(realOutsideRoot, "talk-plan1013-stage1-exec");
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    try {
      await writeFile(path.join(insideDir, "inside.txt"), "inside-smoke", "utf8");
      const executor = createExecutor(realWorkspaceRoot, "full_access");
      const internalRead = await executor.execute({ callId: "env-inside-read", toolName: "read_file", input: { path: path.join("talk-plan1013-stage1-exec", "inside.txt") } });
      if (internalRead.status !== "success") throw new Error(`inside read failed: ${JSON.stringify(internalRead)}`);

      const outsideTarget = path.join(outsideDir, "outside-created.txt");
      const pending = await executor.execute({ callId: "env-outside-write", toolName: "write_file", input: { path: outsideTarget, content: "outside-smoke" } });
      expect(pending.status).toBe("approval_required");
      if (pending.status !== "approval_required") throw new Error("expected approval request");
      const done = await executor.execute({
        callId: "env-outside-write",
        toolName: "write_file",
        input: { path: outsideTarget, content: "outside-smoke" },
        approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
      });
      expect(done.status).toBe("success");
      expect(await readFile(outsideTarget, "utf8")).toBe("outside-smoke");
    } finally {
      await rm(insideDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
