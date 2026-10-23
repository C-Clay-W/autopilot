/**
 * ApprovalService 外部授权生命周期测试（Talk-Plan1013 Stage 2）：
 * allow_workspace 外部授权的"先 grant 后投影"双边一致性、记住失败 pending fail-safe、
 * deny 并集收窄、submit 过期校验与最小撤销 facade。真实工作区冒烟仅做纯格式验证（不写文件）。
 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createApprovalService } from "./approval-service";
import { EXTERNAL_FILE_CONSTRAINT_PREFIX, formatExternalFileRule, externalRuleCoversRule } from "../domain/external-permissions";
import type { ExternalPermissionProjector } from "../ports";
import type { ToolApprovalDecision } from "../../internal/tools/types";

/** 构造一个带审批事件的 memory Runtime；返回 ports 与提交所需四字段。 */
async function createApprovalFixture(options: { constraint?: string; toolName?: string; expiresAt?: string; allowedDecisions?: ToolApprovalDecision[] } = {}) {
  const ports = createMemoryPorts();
  const sessionId = "s-ext";
  const turnId = "t-ext";
  const toolName = options.toolName ?? "write_file";
  await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
  await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "C:\\ws" }, startedAt: 1 });
  await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c1", name: toolName, input: {} }] });
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
      toolName,
      result: {
        status: "approval_required",
        callId: "c1",
        toolName,
        approval: {
          approvalId: "a-ext",
          callId: "c1",
          toolName,
          normalizedInputHash: "hash-ext",
          constraint: options.constraint,
          reason: "工作区外文件修改需要明确用户授权",
          risk: "external_side_effect",
          preview: { path: options.constraint?.slice("ext-file:".length) ?? "unknown" },
          expiresAt: options.expiresAt ?? "2099-01-01T00:00:00Z",
          allowedDecisions: options.allowedDecisions ?? ["allow_once", "allow_session", "allow_workspace", "deny"],
        },
      },
    },
  });
  return { ports, sessionId, turnId, toolName };
}

/** 可编程假投影器：记录 project 调用并按脚本回答 read。 */
function createFakeProjector(script: { allow?: string[]; deny?: string[]; ask?: string[]; restricted?: boolean; failProject?: boolean } = {}): ExternalPermissionProjector & { projects: Array<{ rule: string; action: string }> } {
  const projects: Array<{ rule: string; action: string }> = [];
  return {
    projects,
    async project(input) {
      projects.push({ rule: input.rule, action: input.action });
      if (script.failProject) throw new Error("SETTINGS_IO_FAILED");
    },
    async read() {
      return { allow: script.allow ?? [], deny: script.deny ?? [], ask: script.ask ?? [], ...(script.restricted ? { restricted: true } : {}) };
    },
  };
}

describe("ApprovalService 外部授权（Talk-Plan1013 Stage 2）", () => {
  it("allow_workspace 外部授权：先 grant(pending) 后投影，成功后 synced 且双边一致放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const projector = createFakeProjector({ allow: ["Write(C:\\outside\\a.txt)"] });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: projector });
    const decision = await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    expect(decision.projection).toBe("synced");
    expect(projector.projects).toEqual([{ rule: "Write(C:\\outside\\a.txt)", action: "add" }]);
    const grant = await ports.approvalStore.getPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" });
    expect(grant).toMatchObject({ projection: "synced", externalRule: "Write(C:\\outside\\a.txt)" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(true);
  });

  it("记住失败：submit 仍成功（批准与记住可区分），grant 保持 pending 且不放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const projector = createFakeProjector({ failProject: true });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: projector });
    const decision = await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    expect(decision.projection).toBe("pending");
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
  });

  it("缺投影器时 allow_workspace 外部授权保持 pending 不放行（fail-safe）", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const approvals = createApprovalService({ ...ports });
    const decision = await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    expect(decision.projection).toBe("pending");
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
  });

  it("双边不一致：grant synced 但 local 投影缺规则（orphan 方向）不放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector({ allow: [] }) });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
  });

  it("H3：快照无法解释 deny/ask 时持久放行不成立，限制判定按 deny", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector({ allow: ["Write(C:\\outside\\a.txt)"], restricted: true }) });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
    await expect(approvals.resolveExternalRestriction({ workspaceRoot: "C:\\ws", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe("deny");
  });

  it("deny 并集收窄：deny 目录递归规则覆盖 grant 目标时不放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const projector = createFakeProjector({ allow: ["Write(C:\\outside\\a.txt)"], deny: ["Write(C:\\outside\\**)"] });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: projector });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
  });

  it("Stage3：allow_session 不落投影但必须读取当前收窄，无投影器 fail-closed", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_session" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
    const withSnapshot = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector() });
    await expect(withSnapshot.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(true);
    const grants = await approvals.listPersistentGrants({ sessionId });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: "allow_session" });
    expect(grants[0]?.projection).toBeUndefined();
  });

  it("submit 校验审批有效期：过期审批返回 APPROVAL_NOT_FOUND（Plan 16.5）", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt", expiresAt: "2000-01-01T00:00:00Z" });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector() });
    await expect(approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
  });

  it("撤销：先删 grant 后移除投影规则，撤后不再放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const projector = createFakeProjector({ allow: ["Write(C:\\outside\\a.txt)"] });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: projector });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    const outcome = await approvals.revokePersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" });
    expect(outcome).toEqual({ deleted: true, ruleRemoved: true });
    expect(projector.projects[1]).toEqual({ rule: "Write(C:\\outside\\a.txt)", action: "remove" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(false);
  });

  it("非外部约束（path:）沿用既有语义：无投影器也放行", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "path:note.txt" });
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_workspace" });
    await expect(approvals.hasPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "path:note.txt" })).resolves.toBe(true);
  });

  it("Stage3：session/workspace grant 均被当前 deny/ask 收窄且撤除后恢复", async function narrowsEveryLifetime() {
    for (const scope of ["allow_session", "allow_workspace"] as const) {
      for (const restriction of ["deny", "ask"] as const) {
        const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
        const snapshot = { allow: ["Write(C:\\outside\\a.txt)"], deny: [] as string[], ask: [] as string[] };
        const approvals = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector(snapshot) });
        await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: scope });
        const query = { workspaceRoot: "C:\\ws", sessionId, toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" };
        await expect(approvals.hasPersistentGrant(query)).resolves.toBe(true);
        snapshot[restriction].push("Write(C:\\outside\\**)");
        await expect(approvals.hasPersistentGrant(query)).resolves.toBe(false);
        snapshot[restriction].pop();
        await expect(approvals.hasPersistentGrant(query)).resolves.toBe(true);
      }
    }
  });

  it("Stage5 R2：submit 对外部文件审批落存冻结身份与 TTL，decision 对称携带 constraint/expiresAt 且持久一次消费", async () => {
    const { ports, sessionId, turnId } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const approvals = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector() });
    const decision = await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_once" });
    expect(decision).toMatchObject({ constraint: "ext-file:C:\\outside\\a.txt", expiresAt: "2099-01-01T00:00:00Z" });
    expect(await ports.approvalStore.getFileApproval?.({ sessionId, turnId, approvalId: "a-ext" })).toMatchObject({
      recordType: "external_file_request",
      callId: "c1",
      toolName: "write_file",
      normalizedInputHash: "hash-ext",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const consume = { sessionId, turnId, approvalId: "a-ext", constraint: "ext-file:C:\\outside\\a.txt", callId: "c1", normalizedInputHash: "hash-ext", now: "2026-10-14T00:00:00Z" };
    expect(await approvals.consumeFileApproval(consume)).toBe(true);
    // 持久一次消费：重放与改变后的约束都不可再消费。
    expect(await approvals.consumeFileApproval(consume)).toBe(false);
    expect(await approvals.consumeFileApproval({ ...consume, constraint: "ext-file:C:\\outside\\b.txt" })).toBe(false);
  });

  it("Stage5 R5：resolveExternalRestriction 三态判定（deny 并集优先、ask 次之；非外部约束与缺投影器按 allow）", async () => {
    const { ports } = await createApprovalFixture({ constraint: "ext-file:C:\\outside\\a.txt" });
    const query = { workspaceRoot: "C:\\ws", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" };
    const noProjector = createApprovalService({ ...ports });
    expect(await noProjector.resolveExternalRestriction(query)).toBe("allow");
    expect(await noProjector.resolveExternalRestriction({ ...query, constraint: "path:note.txt" })).toBe("allow");
    const denied = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector({ deny: ["Write(C:\\outside\\**)"], ask: ["Write(C:\\outside\\**)"] }) });
    expect(await denied.resolveExternalRestriction(query)).toBe("deny");
    const asked = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector({ ask: ["Write(C:\\outside\\a.txt)"] }) });
    expect(await asked.resolveExternalRestriction(query)).toBe("ask");
    const allowed = createApprovalService({ ...ports, externalRuleProjector: createFakeProjector({ allow: ["Write(C:\\outside\\a.txt)"] }) });
    expect(await allowed.resolveExternalRestriction(query)).toBe("allow");
    // 读取工具经同一入口按 Read 规则判定，与 Write 规则互不冒充。
    expect(await denied.resolveExternalRestriction({ ...query, toolName: "read_file" })).toBe("allow");
  });

  it("env 真实工作区冒烟：外部目标约束/规则格式与 deny 覆盖判定（纯逻辑，不写文件；env 缺失跳过）", () => {
    const outsideRoot = process.env.AGENT_WORKSPACE_ROOT_OUTSIDE;
    if (!outsideRoot) return;
    const constraint = `${EXTERNAL_FILE_CONSTRAINT_PREFIX}${outsideRoot}\\stage2\\memo.txt`;
    expect(formatExternalFileRule("edit_file", constraint)).toBe(`Edit(${outsideRoot}\\stage2\\memo.txt)`);
    expect(formatExternalFileRule("write_file", constraint)).toBe(`Write(${outsideRoot}\\stage2\\memo.txt)`);
    expect(externalRuleCoversRule(`Write(${outsideRoot}\\**)`, `Write(${outsideRoot}\\stage2\\memo.txt)`)).toBe(true);
    expect(externalRuleCoversRule(`Edit(${outsideRoot}\\**)`, `Write(${outsideRoot}\\stage2\\memo.txt)`)).toBe(false);
  });
});
