/**
 * R7 外部文件集合一次审批（2.4 第 4 项）定向测试：
 * todo_write externalFileTargets 声明门禁与 canonical 冻结、独立审批卡、
 * ApprovalService 外部集合 grant 生命周期、resolver 消费链与收窄不绕过。
 */
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoWriteTool } from "../../src/internal/tools/builtins/todo-write-tool";
import { createWriteFileTool } from "../../src/internal/tools/builtins/write-file-tool";
import { PolicyEngine } from "../../src/internal/tools/policy-engine";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import { createApprovalService } from "../../src/runtime/application/approval-service";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { TASK_EXTERNAL_FILE_SET_CONSTRAINT, TASK_FILE_SET_CONSTRAINT } from "../../src/runtime/domain/approval";
import type { ToolApprovalDecision } from "../../src/internal/tools/types";

const temporaryRoots: string[] = [];

/** 创建独立临时目录并登记清理。 */
async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async function cleanupRoots() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("todo_write 外部文件集合声明", () => {
  const tool = createTodoWriteTool();

  it("声明格式门禁：拒绝相对路径、..、UNC、备用数据流与重复声明", () => {
    for (const bad of ["src/a.js", "../escape.txt", "\\\\server\\share\\a.txt", "C:\\ws\\x.txt:ads", "D:relative.txt", "/abs/../x.txt"]) {
      expect(tool.inputSchema.safeParse({ todos: [], externalFileTargets: [{ path: bad, operation: "edit" }] }).success).toBe(false);
    }
    // 合法绝对路径（盘符与 POSIX 根）通过声明门禁。
    for (const good of ["C:\\ext\\a.txt", "D:/ext/b.txt", "/var/log/app.log"]) {
      expect(tool.inputSchema.safeParse({ todos: [], externalFileTargets: [{ path: good, operation: "edit" }] }).success).toBe(true);
    }
    expect(tool.inputSchema.safeParse({
      todos: [],
      externalFileTargets: [
        { path: "C:\\ext\\a.txt", operation: "edit" },
        { path: "C:\\ext\\a.txt", operation: "edit" },
      ],
    }).success).toBe(false);
  });

  it("拒绝混合声明：工作区集合与外部集合分两次提交", async () => {
    const workspaceRoot = await createTemporaryRoot("r7-ws");
    await expect(tool.createActionFacts({
      todos: [],
      fileTargets: [{ path: "src/a.js", operation: "edit" }],
      externalFileTargets: [{ path: "C:\\ext\\a.txt", operation: "edit" }],
    }, { workspaceRoot } as never)).rejects.toMatchObject({ toolError: { code: "INVALID_INPUT" } });
  });

  it("facts 冻结 canonical 外部清单；声明解析进工作区时拒绝并提示改用 fileTargets", async () => {
    const workspaceRoot = await createTemporaryRoot("r7-ws");
    const externalRoot = await createTemporaryRoot("r7-ext");
    const externalFile = path.join(externalRoot, "report.txt");
    await mkdir(path.dirname(externalFile), { recursive: true });
    const facts = await tool.createActionFacts({
      todos: [],
      externalFileTargets: [{ path: externalFile, operation: "create" }],
    }, { workspaceRoot } as never);
    expect(facts.stableConstraint).toBe(TASK_EXTERNAL_FILE_SET_CONSTRAINT);
    expect(facts.risk).toBe("external_side_effect");
    expect(facts.taskFileSet).toEqual([{ path: externalFile, operation: "create" }]);
    expect(facts.approval?.preview).toMatchObject({ fileCount: 1, scope: "external" });

    const inside = path.join(workspaceRoot, "inside.txt");
    await expect(tool.createActionFacts({ todos: [], externalFileTargets: [{ path: inside, operation: "edit" }] }, { workspaceRoot } as never))
      .rejects.toMatchObject({ toolError: { code: "INVALID_INPUT" } });
  });

  it("symlink 指向外部时按 canonical 目标冻结，不按声明原文", async () => {
    const workspaceRoot = await createTemporaryRoot("r7-ws");
    const externalRoot = await createTemporaryRoot("r7-ext");
    await mkdir(externalRoot, { recursive: true });
    const realFile = path.join(externalRoot, "real.txt");
    const link = path.join(workspaceRoot, "link.txt");
    try {
      await symlink(realFile, link, "file");
    } catch {
      // Windows 无特权环境不允许创建文件 symlink；链接语义由文件工具既有 canonical 复核覆盖，此用例跳过。
      return;
    }
    const facts = await tool.createActionFacts({ todos: [], externalFileTargets: [{ path: link, operation: "edit" }] }, { workspaceRoot } as never);
    expect(facts.taskFileSet).toEqual([{ path: realFile, operation: "edit" }]);
  });
});

describe("PolicyEngine 外部文件集合审批", () => {
  const engine = new PolicyEngine();
  const metadata = createTodoWriteTool().metadata;

  it("task-ext-files:v1 约束的 allowedDecisions 收窄为 allow_once/deny，且不能命中持久 grant", async () => {
    const workspaceRoot = await createTemporaryRoot("r7-ws");
    const externalRoot = await createTemporaryRoot("r7-ext");
    const context = { workspaceRoot, permissionMode: "ask" as const, workspaceTrusted: false };
    const facts = {
      ...(await createTodoWriteTool().createActionFacts({ todos: [], externalFileTargets: [{ path: path.join(externalRoot, "a.txt"), operation: "edit" }] }, { workspaceRoot } as never)),
    };
    const policy = engine.evaluate({ context, metadata, facts, grantMatched: false });
    expect(policy.decision).toBe("approval_required");
    expect(policy.allowedApprovalDecisions).toEqual(["allow_once", "deny"]);
    expect(engine.canUsePersistentGrant(context, facts)).toBe(false);
  });
});

/** 单个待提交的外部文件集合审批事件描述。 */
interface ExternalFileSetApprovalSpec {
  approvalId: string;
  taskFileSet: Array<{ path: string; operation: "create" | "edit" }>;
  turnId?: string;
}

/** 构造带外部文件集合审批事件的 memory Runtime（与工作区集合 fixture 同一形态）。 */
async function createExternalFileSetFixture(approvals: ExternalFileSetApprovalSpec[]) {
  const ports = createMemoryPorts();
  const sessionId = "s-ext-set";
  const turnId = "t-ext-set";
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
            normalizedInputHash: `hash-ext-${index + 1}`,
            constraint: TASK_EXTERNAL_FILE_SET_CONSTRAINT,
            reason: "本次任务声明了要修改的工作区外文件清单，需要单独一次批准",
            risk: "external_side_effect",
            preview: { fileCount: approval.taskFileSet.length, files: approval.taskFileSet, scope: "external" },
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

describe("ApprovalService 外部文件集合 grant", () => {
  it("allow_once 批准后保存 Turn 绑定外部集合；canonical 成员、大小写归一命中与操作绑定", async () => {
    const { ports, sessionId, turnId } = await createExternalFileSetFixture([
      { approvalId: "a-ext", taskFileSet: [{ path: "D:\\Ext\\A.txt", operation: "create" }, { path: "D:\\Ext\\B.txt", operation: "edit" }] },
    ]);
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext", decision: "allow_once" });
    const grant = await ports.approvalStore.getPersistentGrant({ workspaceRoot: "C:\\ws", sessionId, toolName: "todo_write", constraint: TASK_EXTERNAL_FILE_SET_CONSTRAINT });
    expect(grant).toMatchObject({ scope: "allow_session", turnId });
    // canonical 成员精确命中。
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\A.txt", operation: "create" })).resolves.toBe(true);
    // Windows 大小写与分隔符归一后仍命中（canonical 身份比较规则）。
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "d:/ext/a.txt", operation: "create" })).resolves.toBe(true);
    // 操作绑定：声明 create 的文件不接受 edit_file 命中。
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\A.txt", operation: "edit" })).resolves.toBe(false);
    // 非成员与父目录语义不存在：目录前缀不等于成员。
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\C.txt", operation: "create" })).resolves.toBe(false);
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext", operation: "create" })).resolves.toBe(false);
  });

  it("同一 Turn 增量合并；跨 Turn 替换；与工作区集合 grant 互不干扰", async () => {
    const nextTurnId = "t-ext-set-next";
    const { ports, sessionId, turnId } = await createExternalFileSetFixture([
      { approvalId: "a-ext-1", taskFileSet: [{ path: "D:\\Ext\\A.txt", operation: "edit" }] },
      { approvalId: "a-ext-2", taskFileSet: [{ path: "D:\\Ext\\new.txt", operation: "create" }] },
      { approvalId: "a-ext-3", taskFileSet: [{ path: "D:\\Ext\\only-next.txt", operation: "edit" }], turnId: nextTurnId },
    ]);
    const approvals = createApprovalService({ ...ports });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext-1", decision: "allow_once" });
    await approvals.submit({ sessionId, turnId, approvalId: "a-ext-2", decision: "allow_once" });
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\A.txt", operation: "edit" })).resolves.toBe(true);
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\new.txt", operation: "create" })).resolves.toBe(true);
    await ports.checkpointStore.save(sessionId, { turnId: nextTurnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c3", name: "todo_write", input: {} }] });
    await approvals.submit({ sessionId, turnId: nextTurnId, approvalId: "a-ext-3", decision: "allow_once" });
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\A.txt", operation: "edit" })).resolves.toBe(false);
    await expect(approvals.hasExternalTaskFileSetGrant({ sessionId, turnId: nextTurnId, workspaceRoot: "C:\\ws", canonicalTarget: "D:\\Ext\\only-next.txt", operation: "edit" })).resolves.toBe(true);
    // 工作区集合通道未被外部声明触碰。
    await expect(approvals.hasTaskFileSetGrant({ sessionId, turnId, workspaceRoot: "C:\\ws", path: "src/a.js", operation: "edit" })).resolves.toBe(false);
  });

  it("缺少冻结清单时 fail-closed：提交报 APPROVAL_MISMATCH", async () => {
    const ports = createMemoryPorts();
    const sessionId = "s-ext-set";
    const turnId = "t-ext-set";
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
            approvalId: "a-ext-broken",
            callId: "c1",
            toolName: "todo_write",
            normalizedInputHash: "hash-ext-broken",
            constraint: TASK_EXTERNAL_FILE_SET_CONSTRAINT,
            reason: "本次任务声明了要修改的工作区外文件清单，需要单独一次批准",
            risk: "external_side_effect",
            preview: {},
            expiresAt: "2099-01-01T00:00:00Z",
            allowedDecisions: ["allow_once", "deny"] as ToolApprovalDecision[],
          },
        },
      },
    });
    const approvals = createApprovalService({ ...ports });
    await expect(approvals.submit({ sessionId, turnId, approvalId: "a-ext-broken", decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });
});

describe("外部集合消费链（tool-executor e2e）", () => {
  it("集合内外部目标命中 grant 自动放行；非成员仍审批；预览文案标注工作区外", async () => {
    const workspaceRoot = await createTemporaryRoot("r7-ws");
    const externalRoot = await createTemporaryRoot("r7-ext");
    const memberFile = path.join(externalRoot, "member.txt");
    // 批准清单来自声明期 canonical 冻结（与 facts 冻结同一 resolveFileTarget 语义）。
    const approvedSet = [{ path: memberFile, operation: "create" as const }];
    const remembered = new Map<string, boolean>();
    const registry = new ToolRegistry();
    registry.register(createTodoWriteTool());
    registry.register(createWriteFileTool());
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "ask",
      workspaceTrusted: false,
      resolvePersistentGrant: async function resolvePersistentGrant(request) {
        // 复刻 resolver 的外部集合成员分支：write_file→create 操作绑定 + canonical 精确成员。
        if (request.toolName === "write_file" && request.constraint?.startsWith("ext-file:")) {
          const canonicalTarget = request.constraint.slice("ext-file:".length);
          return approvedSet.some((entry) => entry.operation === "create" && entry.path === canonicalTarget) && remembered.get(`${request.toolName}:${request.constraint}`) !== false;
        }
        return false;
      },
    });

    const declaration = await executor.execute({
      callId: "r7-declare",
      toolName: "todo_write",
      input: { todos: [], externalFileTargets: [{ path: memberFile, operation: "create" }] },
    });
    expect(declaration.status).toBe("approval_required");
    if (declaration.status !== "approval_required") throw new Error("unreachable");
    expect(declaration.approval.constraint).toBe(TASK_EXTERNAL_FILE_SET_CONSTRAINT);
    expect(declaration.approval.display?.actionPreview).toContain("个工作区外文件");
    expect(declaration.approval.display?.allowedDecisions).toEqual(["allow_once", "deny"]);

    // 集合成员：ext-file 约束命中 → 直接放行，不再弹卡。
    const member = await executor.execute({ callId: "r7-member", toolName: "write_file", input: { path: memberFile, content: "hello" } });
    expect(member.status).toBe("success");

    // 非成员外部文件：仍走逐次审批。
    const outsider = await executor.execute({ callId: "r7-outsider", toolName: "write_file", input: { path: path.join(externalRoot, "outsider.txt"), content: "no" } });
    expect(outsider.status).toBe("approval_required");
  });
});
