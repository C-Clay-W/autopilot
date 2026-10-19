/**
 * runtime/contract-test/approval-store.contract.test.ts
 *
 * Phase 4：ApprovalStore Port 行为契约。
 */

import { describe, it, expect } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { AgentRuntimeError } from "../protocol";
import { createApprovalService } from "../application/approval-service";

describe("ApprovalStore contract", () => {
  it("保存并读取审批决策", async () => {
    const ports = createMemoryPorts();
    const decision = {
      approvalId: "a1",
      turnId: "t1",
      sessionId: "s1",
      callId: "c1",
      toolName: "run_command",
      normalizedInputHash: "hash-1",
      decision: "allow_once" as const,
      createdAt: "2026-08-02T00:00:00Z",
    };
    await ports.approvalStore.saveDecision(decision);
    const found = await ports.approvalStore.getDecision({ sessionId: "s1", turnId: "t1", approvalId: "a1" });
    expect(found).toEqual(decision);
  });

  it("未找到审批决策时返回 null", async () => {
    const ports = createMemoryPorts();
    const found = await ports.approvalStore.getDecision({ sessionId: "s1", turnId: "t1", approvalId: "none" });
    expect(found).toBeNull();
  });

  it("保存并命中持久授权", async () => {
    const ports = createMemoryPorts();
    const grant = {
      scope: "allow_workspace" as const,
      workspaceRoot: "/tmp/ws",
      toolName: "edit_file",
      constraint: "hash-2",
      createdAt: "2026-08-02T00:00:00Z",
    };
    await ports.approvalStore.savePersistentGrant(grant);
    const found = await ports.approvalStore.getPersistentGrant({
      workspaceRoot: "/tmp/ws",
      sessionId: "s1",
      toolName: "edit_file",
      constraint: "hash-2",
    });
    expect(found).toEqual(grant);
  });

  it("ApprovalService 从 Runtime 事件解析冻结凭证并分开保存稳定约束", async () => {
    const ports = createMemoryPorts();
    const sessionId = "s1";
    const turnId = "t1";
    await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
    await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "/tmp/ws" }, startedAt: 1 });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c1", name: "edit_file", input: {} }] });
    await ports.transcriptStore.append(sessionId, {
      seq: 1,
      sessionId,
      turnId,
      timestamp: ports.clock.timestamp(),
      event: {
        type: "approval_required",
        turnId,
        stepId: "step-1",
        callId: "c1",
        toolName: "edit_file",
        result: {
          status: "approval_required",
          callId: "c1",
          toolName: "edit_file",
          approval: {
            approvalId: "a1",
            callId: "c1",
            toolName: "edit_file",
            normalizedInputHash: "hash-for-this-edit",
            constraint: "path:note.txt",
            reason: "写入文件",
            risk: "write",
            preview: {},
            expiresAt: "2099-08-03T00:00:00Z",
            allowedDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"],
          },
        },
      },
    });
    const approvals = createApprovalService(ports);
    await approvals.submit({
      sessionId,
      turnId,
      approvalId: "a1",
      decision: "allow_workspace",
    });

    expect(await ports.approvalStore.getPersistentGrant({
      workspaceRoot: "/tmp/ws",
      sessionId: "s2",
      toolName: "edit_file",
      constraint: "path:note.txt",
    })).toMatchObject({ scope: "allow_workspace", constraint: "path:note.txt" });
    expect(await ports.approvalStore.getPersistentGrant({
      workspaceRoot: "/tmp/ws",
      sessionId: "s2",
      toolName: "edit_file",
      constraint: "hash-for-next-edit",
    })).toBeNull();
    await expect(approvals.submit({ sessionId, turnId, approvalId: "a1", decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_ALREADY_SUBMITTED" });
  });

  it("ApprovalService rejects an invalid decision at runtime", async function rejectsInvalidDecision() {
    const ports = createMemoryPorts();
    const approvals = createApprovalService(ports);
    await expect(approvals.submit({
      sessionId: "s1",
      turnId: "t1",
      approvalId: "a1",
      decision: "allow_forever" as any,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("ask 下 run_command 拒绝持久授权范围", async function rejectsPersistentCommandGrantInAskMode() {
    const ports = createMemoryPorts();
    const sessionId = "s-command-ask";
    const turnId = "t-command-ask";
    await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
    await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "/tmp/ws", permissionMode: "ask" }, startedAt: 1 });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c-command", name: "run_command", input: {} }] });
    await ports.transcriptStore.append(sessionId, {
      seq: 1,
      sessionId,
      turnId,
      timestamp: ports.clock.timestamp(),
      event: {
        type: "approval_required",
        turnId,
        stepId: "step-command",
        callId: "c-command",
        toolName: "run_command",
        result: {
          status: "approval_required",
          callId: "c-command",
          toolName: "run_command",
          approval: {
            approvalId: "a-command",
            callId: "c-command",
            toolName: "run_command",
            normalizedInputHash: "hash-command",
            constraint: "program:node",
            reason: "执行命令",
            risk: "command",
            preview: {},
            expiresAt: "2099-08-12T00:00:00Z",
            allowedDecisions: ["allow_once", "deny"],
          },
        },
      },
    });
    const approvals = createApprovalService(ports);

    await expect(approvals.submit({ sessionId, turnId, approvalId: "a-command", decision: "allow_workspace" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(ports.approvalStore.getPersistentGrant({ workspaceRoot: "/tmp/ws", sessionId, toolName: "run_command", constraint: "program:node" })).resolves.toBeNull();
  });

  it("Talk-Plan1013 Stage5 R2：文件审批冻结记录 save/get 与持久一次消费（约束/身份/TTL/重放）", async () => {
    const ports = createMemoryPorts();
    const key = { sessionId: "s-file", turnId: "t-file", approvalId: "a-file" };
    const request = {
      recordType: "external_file_request" as const,
      ...key,
      callId: "c-file",
      toolName: "write_file",
      normalizedInputHash: "hash-file",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    expect(await ports.approvalStore.saveFileApproval?.(request)).toBe(true);
    // 重复冻结同一审批键只允许第一个 owner 成功。
    expect(await ports.approvalStore.saveFileApproval?.(request)).toBe(false);
    expect(await ports.approvalStore.getFileApproval?.(key)).toMatchObject({ recordType: "external_file_request", constraint: "ext-file:C:\\outside\\a.txt" });
    expect(await ports.approvalStore.getFileApproval?.({ ...key, approvalId: "other" })).toBeNull();

    // 未提交决定时不可消费。
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2098-01-01T00:00:00Z" })).toBe(false);
    await ports.approvalStore.saveDecision({ ...key, callId: request.callId, toolName: request.toolName, normalizedInputHash: request.normalizedInputHash, constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: "2026-10-14T00:00:00Z" });

    // 约束/身份失配一律拒绝。
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: "ext-file:C:\\outside\\b.txt", callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" })).toBe(false);
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: request.constraint, callId: "other-call", normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" })).toBe(false);
    // 过期 TTL 拒绝。
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2099-06-01T00:00:00Z" })).toBe(false);
    // 合法消费成功，且第二次消费（重放）失败。
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" })).toBe(true);
    expect(await ports.approvalStore.consumeFileApproval?.({ ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" })).toBe(false);
  });

  it("拒绝未知 scope 的持久授权", async () => {
    const ports = createMemoryPorts();
    await expect(
      ports.approvalStore.savePersistentGrant({
        scope: "allow_forever" as any,
        toolName: "edit_file",
        constraint: "hash-3",
        createdAt: "2026-08-02T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
  });

  it("Talk-Plan1013 Stage 2：列出与投影状态更新（workspace 过滤、未命中返回 null）", async () => {
    const ports = createMemoryPorts();
    await ports.approvalStore.savePersistentGrant({
      scope: "allow_workspace",
      workspaceRoot: "C:\\ws-a",
      toolName: "write_file",
      constraint: "ext-file:C:\\outside\\a.txt",
      externalRule: "Write(C:\\outside\\a.txt)",
      projection: "pending",
      createdAt: "2026-10-13T00:00:00Z",
    });
    await ports.approvalStore.savePersistentGrant({
      scope: "allow_session",
      sessionId: "s-other",
      toolName: "edit_file",
      constraint: "path:note.txt",
      createdAt: "2026-10-13T00:00:00Z",
    });
    const workspaceGrants = await ports.approvalStore.listPersistentGrants({ workspaceRoot: "C:\\ws-a" });
    expect(workspaceGrants).toHaveLength(1);
    expect(workspaceGrants[0]).toMatchObject({ toolName: "write_file", projection: "pending" });
    const updated = await ports.approvalStore.setGrantProjection({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt", projection: "synced" });
    expect(updated).toMatchObject({ projection: "synced" });
    await expect(ports.approvalStore.setGrantProjection({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\missing.txt", projection: "synced" })).resolves.toBeNull();
    const sessionGrants = await ports.approvalStore.listPersistentGrants({ sessionId: "s-other" });
    expect(sessionGrants).toHaveLength(1);
    expect(sessionGrants[0]).toMatchObject({ scope: "allow_session" });
  });
});
