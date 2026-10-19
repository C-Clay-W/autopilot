/**
 * p1fix-r001 Tester 回归用例：R2 必测 #4 撤权恢复（Talk-Plan1013 Stage5 CR R2）。
 *
 * 合同要求（CR R2 verification + Plan §7.5/§16.5）：
 *   allow_workspace/session 审批或 grant 在恢复执行前被撤销（deletePersistentGrant/
 *   投影规则删除）→ 恢复必须失败；目标零变化。所有调用/恢复均复查撤销与最新收紧规则。
 *
 * 本文件只新增测试断言，不修改任何产品源码。fixture 全部合成临时目录，用后清理。
 * 恢复路径按真实链构造：ToolExecutor（pending 为空）+ 真实 ApprovalService +
 * 真实 TurnRuntimeConfigResolver.validateApproval；resume 时 approval 决定按
 * turn-service.ts:126 的宿主映射固定为 allow_once。
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWriteFileTool } from "../../src/internal/tools/builtins/write-file-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import { TOOL_ERROR_CODES } from "../../src/internal/tools/tool-error";
import type { ToolExecutionContext } from "../../src/internal/tools/types";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createApprovalService } from "../../src/runtime/application/approval-service";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import type { ExternalPermissionProjector } from "../../src/runtime/ports";
import type { FrozenRunConfig } from "../../src/runtime/domain";
import type { RunConfig } from "../../src/runtime/protocol";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建独立临时工作区与其外部的目标根，两者互不嵌套。 */
async function createWorkspaceWithOutside(): Promise<{ workspaceRoot: string; outsideRoot: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "p1fix-r001-revoke-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const outsideRoot = path.join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { workspaceRoot, outsideRoot };
}

/** 内存投影器替身：只跟踪本 fixture 的 allow 规则集合，deny/ask 为空。 */
function createFakeProjector(): ExternalPermissionProjector & { allow: string[] } {
  const allow: string[] = [];
  return {
    allow,
    async project({ rule, action }) {
      const index = allow.indexOf(rule);
      if (action === "add" && index < 0) allow.push(rule);
      if (action === "remove" && index >= 0) allow.splice(index, 1);
    },
    async read() {
      return { allow: [...allow], deny: [], ask: [] };
    },
  };
}

/** 构造带 write_file 的执行器；可选注入 Runtime 权威桥（恢复路径）。 */
function createExecutor(workspaceRoot: string, bridges: { validateApproval?: ToolExecutionContext["validateApproval"]; resolvePersistentGrant?: ToolExecutionContext["resolvePersistentGrant"]; resolveExternalRestriction?: ToolExecutionContext["resolveExternalRestriction"] }): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "full_access",
    workspaceTrusted: false,
    fileReadStates: new Map(),
    ...bridges,
  });
}

/**
 * 构造一次完整的“审批 → 撤销 → 恢复”fixture：
 * 1. 第一Executor 产生审批请求（内存 pending 路径）；
 * 2. 宿主经真实 ApprovalService.submit 落存决定（含冻结身份与 TTL）；
 * 3. 调用方执行撤销动作；
 * 4. 新建 Executor（pending 为空）带真实 Runtime 桥走恢复分支重放同一 call。
 */
async function runRevokedRecovery(options: {
  decision: "allow_once" | "allow_session" | "allow_workspace";
  revoke: "deleteGrant" | "deleteProjectionOnly" | "none";
}): Promise<{ status: string; errorCode?: string; targetExists: boolean }> {
  const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
  const targetFile = path.join(outsideRoot, "revoked.txt");
  const sessionId = "s-p1fix-r001";
  const turnId = "t-p1fix-r001";
  const ports = createMemoryPorts(workspaceRoot);
  const projector = createFakeProjector();
  const approvals = createApprovalService({ ...ports, externalRuleProjector: projector });
  const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: { permissionMode: "full_access" }, approvalService: approvals });
  const agentOptions = resolver.buildAgentOptions({ workspaceRoot } as FrozenRunConfig, { permissionMode: "full_access" } as RunConfig, sessionId, turnId);
  if (!agentOptions.validateApproval) throw new Error("expected validateApproval bridge");

  const pending = await createExecutor(workspaceRoot, {})
    .execute({ callId: "c-recover", toolName: "write_file", input: { path: targetFile, content: "revoked-body" } });
  if (pending.status !== "approval_required") throw new Error("expected approval request");

  await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
  await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot }, startedAt: 1 });
  await ports.checkpointStore.save(sessionId, {
    turnId,
    status: "awaiting_approval",
    stepCount: 1,
    messages: [],
    completedCallIds: [],
    pendingCalls: [{ id: pending.approval.callId, name: pending.approval.toolName, input: { path: targetFile, content: "revoked-body" } }],
  });
  await ports.transcriptStore.append(sessionId, {
    seq: 1,
    sessionId,
    turnId,
    timestamp: ports.clock.timestamp(),
    event: {
      type: "approval_required",
      turnId,
      stepId: "step-recover",
      callId: pending.approval.callId,
      toolName: pending.approval.toolName,
      result: { status: "approval_required", callId: pending.approval.callId, toolName: pending.approval.toolName, approval: pending.approval },
    },
  });
  const submitted = await approvals.submit({ sessionId, turnId, approvalId: pending.approval.approvalId, decision: options.decision });
  if (options.decision !== "allow_once" && !submitted.constraint) throw new Error("expected frozen constraint on submitted decision");

  // 撤销动作（恢复执行前）。
  if (options.revoke === "deleteGrant") {
    await approvals.revokePersistentGrant({ workspaceRoot, sessionId, toolName: "write_file", constraint: submitted.constraint! });
  } else if (options.revoke === "deleteProjectionOnly") {
    await projector.project({ workspaceRoot, rule: `Write(${targetFile})`, action: "remove" });
  }

  const resumed = createExecutor(workspaceRoot, {
    validateApproval: agentOptions.validateApproval,
    resolvePersistentGrant: async (request) => approvals.hasPersistentGrant({
      workspaceRoot,
      sessionId,
      toolName: request.toolName,
      constraint: request.constraint ?? request.inputHash,
    }),
    resolveExternalRestriction: async (request) => approvals.resolveExternalRestriction!({ workspaceRoot, ...request }),
  });
  const result = await resumed.execute({
    callId: "c-recover",
    toolName: "write_file",
    input: { path: targetFile, content: "revoked-body" },
    // turn-service.ts:126 宿主映射：allow → allow_once。
    approval: { approvalId: pending.approval.approvalId, decision: "allow_once" },
  });
  let targetExists = true;
  try {
    await stat(targetFile);
  } catch {
    targetExists = false;
  }
  return { status: result.status, ...(result.status === "error" ? { errorCode: result.error.code } : {}), targetExists };
}

describe("p1fix-r001 R2 撤权恢复（Talk-Plan1013 Stage5 CR R2 必测 #4）", () => {
  it("allow_workspace 审批后 grant 被撤销：恢复必须失败且目标零变化", async () => {
    const outcome = await runRevokedRecovery({ decision: "allow_workspace", revoke: "deleteGrant" });
    expect(outcome.status).toBe("error");
    expect(outcome.errorCode).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    expect(outcome.targetExists).toBe(false);
  });

  it("allow_session 审批后 grant 被撤销：恢复必须失败且目标零变化", async () => {
    const outcome = await runRevokedRecovery({ decision: "allow_session", revoke: "deleteGrant" });
    expect(outcome.status).toBe("error");
    expect(outcome.errorCode).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    expect(outcome.targetExists).toBe(false);
  });

  it("allow_workspace 审批后仅投影规则被删除（双边不一致）：恢复必须失败且目标零变化", async () => {
    const outcome = await runRevokedRecovery({ decision: "allow_workspace", revoke: "deleteProjectionOnly" });
    expect(outcome.status).toBe("error");
    expect(outcome.errorCode).toBe(TOOL_ERROR_CODES.APPROVAL_MISMATCH);
    expect(outcome.targetExists).toBe(false);
  });

  it("对照：allow_workspace 审批后 grant 未撤销，恢复路径正常放行（不回归）", async () => {
    const outcome = await runRevokedRecovery({ decision: "allow_workspace", revoke: "none" });
    expect(outcome.status).toBe("success");
    expect(outcome.targetExists).toBe(true);
  });
});
