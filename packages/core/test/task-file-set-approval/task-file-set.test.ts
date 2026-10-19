/**
 * 任务文件集合一次性审批（2.4）定向测试：
 * todo_write fileTargets 声明与事实冻结、PolicyEngine 决定收窄、ApprovalService 集合 grant 生命周期。
 * 覆盖：声明格式门禁、集合审批事实、增量合并、Turn 绑定失效与操作绑定。
 */
import { describe, expect, it } from "vitest";
import { createTodoWriteTool } from "../../src/internal/tools/builtins/todo-write-tool";
import { PolicyEngine } from "../../src/internal/tools/policy-engine";
import { createApprovalService } from "../../src/runtime/application/approval-service";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { TASK_FILE_SET_CONSTRAINT } from "../../src/runtime/domain/approval";
import type { ToolApprovalDecision } from "../../src/internal/tools/types";

/** 单个待提交的任务文件集合审批事件描述。 */
interface TaskFileSetApprovalSpec {
  approvalId: string;
  taskFileSet: Array<{ path: string; operation: "create" | "edit" }>;
  /** 缺省时归属 fixture 的首个 Turn；指定时额外保存 Turn 记录（checkpoint 由用例自行切换）。 */
  turnId?: string;
}

/** 构造带任务文件集合审批事件的 memory Runtime；所有事件写入同一 transcript。 */
async function createTaskFileSetFixture(approvals: TaskFileSetApprovalSpec[]) {
  const ports = createMemoryPorts();
  const sessionId = "s-task-set";
  const turnId = "t-task-set";
  await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
  await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "C:\\ws" }, startedAt: 1 });
  await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c1", name: "todo_write", input: {} }] });
  for (const [index, approval] of approvals.entries()) {
    const eventTurnId = approval.turnId ?? turnId;
    if (eventTurnId !== turnId) {
      await ports.turnStore.save({ id: eventTurnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "C:\\ws" }, startedAt: 2 });
    }
    await ports.transcriptStore.append(sessionId, {
      seq: index + 1,
      sessionId,
      turnId: eventTurnId,
      timestamp: ports.clock.timestamp(),
      event: {
        type: "approval_required",
        turnId: eventTurnId,
        stepId: `step-${index + 1}`,
        callId: `c${index + 1}`,
        toolName: "todo_write",
        result: {
          status: "approval_required",
          callId: `c${index + 1}`,
          toolName: "todo_write",
          approval: {
            approvalId: approval.approvalId,
            callId: `c${index + 1}`,
            toolName: "todo_write",
            normalizedInputHash: `hash-${index + 1}`,
            constraint: TASK_FILE_SET_CONSTRAINT,
            reason: "本次任务声明了要修改的文件清单，需要一次批准",
            risk: "workspace_mutating",
            preview: { fileCount: approval.taskFileSet.length, files: approval.taskFileSet },
            expiresAt: "2099-01-01T00:00:00Z",
            allowedDecisions: ["allow_once", "deny"] as ToolApprovalDecision[],
            taskFileSet: approval.taskFileSet,
          },
        },
      },
    });
  }
  return { ports, sessionId, turnId };
}

describe("todo_write 任务文件集合声明", () => {
  const tool = createTodoWriteTool();

  it("无 fileTargets 时保持只读自动允许，facts 不携带审批语义", async () => {
    const facts = await tool.createActionFacts({ todos: [] });
    expect(facts).toEqual({ toolName: "todo_write", effect: "none", destructive: false, operation: "todo_write" });
  });

  it("有 fileTargets 时冻结集合审批事实：task-files:v1 约束、完整清单与预览", async () => {
    const fileTargets = [
      { path: "src/a.js", operation: "create" as const },
      { path: "src/b.js", operation: "edit" as const },
    ];
    const facts = await tool.createActionFacts({ todos: [], fileTargets });
    expect(facts.requiresApproval).toBe(true);
    expect(facts.stableConstraint).toBe(TASK_FILE_SET_CONSTRAINT);
    expect(facts.taskFileSet).toEqual(fileTargets);
    expect(facts.risk).toBe("workspace_mutating");
    expect(facts.approval?.preview).toEqual({ fileCount: 2, files: fileTargets });
  });

  it("声明路径门禁：拒绝 ..、反斜杠、绝对前缀与盘符路径", () => {
    for (const path of ["../escape.js", "a\\b.js", "/abs.js", "C:\\ws\\x.js", "src//a.js", "src/./a.js"]) {
      expect(tool.inputSchema.safeParse({ todos: [], fileTargets: [{ path, operation: "edit" }] }).success).toBe(false);
    }
  });

  it("拒绝重复的 path 与 operation 声明", () => {
    const duplicated = { todos: [], fileTargets: [{ path: "src/a.js", operation: "edit" as const }, { path: "src/a.js", operation: "edit" as const }] };
    expect(tool.inputSchema.safeParse(duplicated).success).toBe(false);
  });
});

describe("PolicyEngine 任务文件集合审批", () => {
  const engine = new PolicyEngine();
  const metadata = createTodoWriteTool().metadata;
  const context = { workspaceRoot: "C:\\ws", permissionMode: "ask" as const, workspaceTrusted: false };

  it("task-files:v1 约束的 allowedDecisions 收窄为 allow_once/deny", async () => {
    const facts = { ...(await createTodoWriteTool().createActionFacts({ todos: [], fileTargets: [{ path: "src/a.js", operation: "edit" }] })) };
    const policy = engine.evaluate({ context, metadata, facts, grantMatched: false });
    expect(policy.decision).toBe("approval_required");
    expect(policy.allowedApprovalDecisions).toEqual(["allow_once", "deny"]);
  });

  it("集合声明不能命中持久 grant：canUsePersistentGrant 恒为 false", async () => {
    const facts = { ...(await createTodoWriteTool().createActionFacts({ todos: [], fileTargets: [{ path: "src/a.js", operation: "edit" }] })) };
    expect(engine.canUsePersistentGrant(context, facts)).toBe(false);
  });
});

describe("ApprovalService 任务文件集合 grant", () => {
  it("allow_once 批准后保存 Turn 绑定集合；成员命中、操作不匹配与非成员不命中", async () => {
    const { ports, sessionId, turnId } = await createTaskFileSetFixture([{ approvalId: "a-set", taskFileSet: [{ path: "src/a.js", operation: "create" }, { path: "src/b.js", operation: "edit" }] }]);
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-set", decision: "allow_once" });
    const grant = await ports.approvalStore.getPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "todo_write", constraint: TASK_FILE_SET_CONSTRAINT });
    expect(grant).toMatchObject({ scope: "allow_session", turnId });
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/a.js", operation: "create" })).resolves.toBe(true);
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/b.js", operation: "edit" })).resolves.toBe(true);
    // 操作绑定：声明 create 的文件不接受 edit_file 命中。
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/a.js", operation: "edit" })).resolves.toBe(false);
    // 非成员：回到既有逐次审批。
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/c.js", operation: "edit" })).resolves.toBe(false);
  });

  it("同一 Turn 的增量声明与既有集合合并；跨 Turn 声明整体替换且旧 Turn 失效", async () => {
    const nextTurnId = "t-task-set-next";
    const { ports, sessionId, turnId } = await createTaskFileSetFixture([
      { approvalId: "a-set-1", taskFileSet: [{ path: "src/a.js", operation: "edit" }] },
      { approvalId: "a-set-2", taskFileSet: [{ path: "src/new.js", operation: "create" }] },
      { approvalId: "a-set-3", taskFileSet: [{ path: "src/only-next.js", operation: "edit" }], turnId: nextTurnId },
    ]);
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-set-1", decision: "allow_once" });
    await approvals.submit({ sessionId, turnId, approvalId: "a-set-2", decision: "allow_once" });
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/a.js", operation: "edit" })).resolves.toBe(true);
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/new.js", operation: "create" })).resolves.toBe(true);
    // 新 Turn 的声明替换旧集合：旧 Turn 的成员不再命中。
    await ports.checkpointStore.save(sessionId, { turnId: nextTurnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c3", name: "todo_write", input: {} }] });
    await approvals.submit({ sessionId, turnId: nextTurnId, approvalId: "a-set-3", decision: "allow_once" });
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/a.js", operation: "edit" })).resolves.toBe(false);
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId: nextTurnId, workspaceRoot: "C:\\ws", path: "src/only-next.js", operation: "edit" })).resolves.toBe(true);
  });

  it("集合审批事件缺少冻结清单时 fail-closed：提交报 APPROVAL_MISMATCH", async () => {
    const ports = createMemoryPorts();
    const sessionId = "s-task-set";
    const turnId = "t-task-set";
    await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
    await ports.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", frozenRunConfig: { workspaceRoot: "C:\\ws" }, startedAt: 1 });
    await ports.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c1", name: "todo_write", input: {} }] });
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
        toolName: "todo_write",
        result: {
          status: "approval_required",
          callId: "c1",
          toolName: "todo_write",
          approval: {
            approvalId: "a-broken",
            callId: "c1",
            toolName: "todo_write",
            normalizedInputHash: "hash-broken",
            constraint: TASK_FILE_SET_CONSTRAINT,
            reason: "本次任务声明了要修改的文件清单，需要一次批准",
            risk: "workspace_mutating",
            preview: {},
            expiresAt: "2099-01-01T00:00:00Z",
            allowedDecisions: ["allow_once", "deny"] as ToolApprovalDecision[],
          },
        },
      },
    });
    const approvals = createApprovalService({ ...ports });
    await expect(approvals.submit({ sessionId, turnId, approvalId: "a-broken", decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });
});
