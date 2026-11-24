/** 权限分流与恢复回归，命令执行使用替身，所有状态使用内存端口。 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { PolicyEngine } from "../../../src/internal/tools/policy-engine";
import { decideCommandPermission } from "../../../src/internal/tools/permissions/command-policy";
import { createRunCommandTool } from "../../../src/internal/tools/builtins/run-command-tool";
import { createStartBackgroundJobTool } from "../../../src/internal/tools/builtins/start-background-job-tool";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import type { ToolActionFacts, ToolExecutionContext, ToolMetadata, ToolPermissionMode } from "../../../src/internal/tools/types";

const executed = vi.hoisted(function captureExecutions() { return { commands: [] as unknown[] }; });
vi.mock("../../../src/internal/tools/builtins/run-command-tool", async function stubCommand(importOriginal) {
  const actual = await importOriginal<typeof import("../../../src/internal/tools/builtins/run-command-tool")>();
  return { ...actual, createRunCommandTool: function createStubCommand() {
    const tool = actual.createRunCommandTool();
    return { ...tool, execute: async function execute(input: unknown) { executed.commands.push(input); return { stdout: "fixture", stderr: "", exitCode: 0 }; } };
  } };
});

const metadata: ToolMetadata = { effect: "dynamic", destructive: false, concurrency: { max: 1 }, retry: { safe: false } };

/** 本地受信事实与上下文直接进入唯一策略入口，避免从模型参数导入风险。 */
function evaluate(mode: ToolPermissionMode, overrides: Partial<ToolActionFacts> = {}, grantMatched = false, hostExecution = true) {
  const context: ToolExecutionContext = { permissionMode: mode, workspaceTrusted: true, agentFlow: { async search() { return []; } } };
  const facts: ToolActionFacts = { toolName: "run_command", effect: "workspace", destructive: false, operation: "command", risk: "workspace_mutating", requiresApproval: true, stableConstraint: "cmd:v2:fixture", ...overrides };
  return new PolicyEngine().evaluate({ context, metadata, facts, grantMatched, hostExecution });
}

/** 隔离目录仅供 canonical cwd 检查，进程执行由上方替身截断。 */
async function fixture(mode: ToolPermissionMode = "auto_approve", program = "node", args = ["--version"]) {
  const artifacts = path.resolve("../../.agent-tests/work-test/cli-permissions-policy/runs/r001/fixtures");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "runtime-"));
  const ports = createMemoryPorts(root);
  const report = { platform: "windows" as const, backend: "host-execution", enforcement: "unavailable" as const };
  ports.sandboxPort = { execution: "host", async status() { return report; }, async setup() { return report; }, async prepare() { throw new Error("禁止真实进程"); }, async release() {}, async shutdown() {} };
  let samples = 0;
  const defaults = { workspaceRoot: root, workspaceTrusted: true, permissionMode: mode, modelRef: { provider: "firstParty", modelId: "fixture" }, modelSampler: { async sample() {
    samples++;
    return { content: "fixture", toolCalls: samples === 1 ? [{ id: "call", name: "run_command", input: { program, args, cwd: "." } }] : [], reasoningSummary: "mock" };
  } } };
  const runtime = createAgentRuntime({ ports, defaultRunConfig: defaults });
  const session = await runtime.sessions.create({ persistenceMode: "durable", defaultRunConfig: { permissionMode: mode } });
  return { ports, runtime, defaults, sessionId: session.id };
}

/** 消费真实 Runtime 异步事件流，让生命周期与持久边界实际执行。 */
async function collect(stream: AsyncIterable<unknown>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("权限模式与风险分流", function policySuite() {
  it("PowerShell 单文件删除准确识别危险，复杂脚本不冒充该受限格式，原hard deny保留", function literalDeletionRisk() {
    const command = "Remove-Item -LiteralPath 'r001-permissions-lollipop-auto.html' -ErrorAction Stop";
    const args = ["-NoProfile", "-NonInteractive", "-Command", command];
    for (const program of ["powershell.exe", "pwsh"]) {
      const risk = decideCommandPermission(program, args);
      expect(risk).toMatchObject({ decision: "approval_required", risk: "destructive" });
      expect(evaluate("full_access", { risk: risk.risk, destructive: true }, true)).toMatchObject({ decision: "approval_required", allowedApprovalDecisions: ["allow_once", "deny"] });
    }
    for (const script of [command + "; Write-Output extra", command.replace("auto.html", "*.html"), command.replace("auto.html", "../auto.html"), command.replace("'r001", "'C:\\r001")]) {
      expect(decideCommandPermission("powershell.exe", [...args.slice(0, 3), script]).risk).toBe("unknown");
    }
    expect(decideCommandPermission("powershell.exe", args, [{ pattern: ["powershell"], decision: "deny", risk: "destructive", reason: "explicit deny" }]).decision).toBe("deny");
    for (const program of ["rm", "del", "rmdir"]) expect(decideCommandPermission(program, ["file.html"]).decision).toBe("deny");
  });

  it.each(["auto_approve", "full_access"] as const)("%s 的明确PowerShell删除先停单次审批，批准后只执行原调用一次", async function approvesLiteralDeletion(mode) {
    const args = ["-NoProfile", "-NonInteractive", "-Command", "Remove-Item -LiteralPath 'r001-permissions-lollipop-auto.html' -ErrorAction Stop"];
    const f = await fixture(mode, "powershell.exe", args);
    const before = executed.commands.length;
    const first = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const pending = first.find(function approval(event) { return event.type === "approval_required"; });
    expect(pending.result.approval).toMatchObject({ risk: "destructive", allowedDecisions: ["allow_once", "deny"] });
    expect(executed.commands.length).toBe(before);
    await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId: pending.turnId, approvalId: pending.result.approval.approvalId, decision: "allow_once" });
    await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId: pending.turnId, approval: { approvalId: pending.result.approval.approvalId, decision: "allow" } }));
    expect(executed.commands.slice(before)).toMatchObject([{ program: "powershell.exe", args }]);
    await expect(collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId: pending.turnId, approval: { approvalId: pending.result.approval.approvalId, decision: "allow" } }))).rejects.toBeDefined();
    expect(executed.commands.length).toBe(before + 1);
  });

  it("前后台命令声明外部目标仍保留危险事实，精确外部 grant 不能代替危险单次确认", async function preservesDangerWithExternalTarget() {
    const f = await fixture();
    const root = f.defaults.workspaceRoot;
    const external = path.join(root, "..", `${path.basename(root)}-external.txt`);
    await writeFile(external, "fixture");
    const context: ToolExecutionContext = { workspaceRoot: root, permissionMode: "full_access", workspaceTrusted: true, agentFlow: { async search() { return []; } } };
    const tools = [createRunCommandTool(), createStartBackgroundJobTool({ jobs: {} as any, workspaceRoot: root, workspaceId: root, sessionId: f.sessionId, turnId: "fixture" })];
    for (const tool of tools) {
      const input = tool.inputSchema.parse({ program: "git", args: ["restore", "fixture.txt"], cwd: ".", externalWriteTarget: external });
      const facts = await tool.createActionFacts!(input, context);
      expect(facts).toMatchObject({ risk: "destructive", externalMutation: true });
      expect(evaluate("full_access", facts, true).decision).toBe("approval_required");
    }
  });

  it("宿主安全读写按模式分流，auto 未知与外部副作用询问，full 普通未知放行", function normalRiskMatrix() {
    expect(evaluate("ask").decision).toBe("approval_required");
    expect(evaluate("auto_approve").decision).toBe("allow");
    expect(evaluate("auto_approve", { risk: "read_only", effect: "none" }).decision).toBe("allow");
    expect(evaluate("auto_approve", { risk: "unknown" }).decision).toBe("approval_required");
    expect(evaluate("full_access", { risk: "unknown" }).decision).toBe("allow");
    expect(evaluate("full_access", { risk: "external_side_effect", effect: "external" }).decision).toBe("approval_required");
  });

  it.each(["ask", "auto_approve", "full_access"] as const)("%s 的危险、显式 ask 与外部修改不被普通 grant 或模式绕过", function hardBoundaries(mode) {
    expect(evaluate(mode, { risk: "destructive", destructive: true }, true)).toMatchObject({ decision: "approval_required", allowedApprovalDecisions: ["allow_once", "deny"] });
    expect(evaluate(mode, { externalRestriction: "ask" }, true).decision).toBe("approval_required");
    expect(evaluate(mode, { externalMutation: true, effect: "external" }).decision).toBe("approval_required");
    expect(evaluate(mode, { externalMutation: true, externalRestriction: "deny" }, true).decision).toBe("deny");
    expect(evaluate(mode, { hardDenyReason: "hard deny" }, true).decision).toBe("deny");
  });

  it("git blame 准确识别为只读，npm 脚本与任意未知命令保留未知风险", function structuredRiskFacts() {
    expect(decideCommandPermission("git", ["blame", "-L", "23,27", "--", "src/file.ts"]).risk).toBe("read_only");
    expect(decideCommandPermission("git", ["blame", "../outside"]).risk).toBe("unknown");
    expect(decideCommandPermission("git", ["blame", "--contents=../outside"]).risk).toBe("unknown");
    expect(decideCommandPermission("git", ["show", "--output=export.txt"]).risk).toBe("unknown");
    expect(decideCommandPermission("rg", ["--pre=node", "term"]).risk).toBe("unknown");
    expect(decideCommandPermission("npm", ["run", "build"]).risk).toBe("unknown");
    expect(decideCommandPermission("node", ["-e", "anything"]).risk).toBe("unknown");
    expect(decideCommandPermission("git", ["reset", "--hard"]).decision).toBe("deny");
    expect(decideCommandPermission("git", ["reset", "--quiet", "--hard"]).decision).toBe("deny");
    expect(decideCommandPermission("git", ["commit", "-m", "fixture", "--amend"]).risk).toBe("destructive");
    expect(decideCommandPermission("git", ["restore", "src/file.ts"])).toMatchObject({ decision: "approval_required", risk: "destructive" });
    expect(decideCommandPermission("git", ["restore", "../outside"])).toMatchObject({ decision: "approval_required", risk: "destructive" });
    expect(decideCommandPermission("curl", ["--output=/tmp/file", "https://example.invalid"])).toMatchObject({ decision: "approval_required", risk: "external_side_effect" });
    expect(decideCommandPermission("git", ["push", "--force"])).toMatchObject({ decision: "approval_required", risk: "external_side_effect" });
  });
});

describe("人类权限选择的恢复执行段", function continuationSuite() {
  it("新 Turn 已观察的选择不覆盖显式 Turn 权限，重复恢复仍保留该冻结偏好", async function observesInitialSelection() {
    const f = await fixture();
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access" });
    await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture", runConfig: { permissionMode: "ask" } }));
    const turnId = (await f.ports.turnStore.getLatest(f.sessionId))!.id;
    await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId }));
    expect((await f.runtime.turns.getFrozenRunConfig({ sessionId: f.sessionId, turnId }))?.executionPermissionMode).toBe("ask");
    expect((await f.ports.turnStore.get(turnId))?.permissionRevisions).toBeUndefined();
  });

  it("权限修订恢复持有原租约，第二个恢复不能并行执行", async function serializesResume() {
    const f = await fixture();
    await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const turnId = (await f.ports.turnStore.getLatest(f.sessionId))!.id;
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access" });
    const first = f.runtime.turns.continue({ sessionId: f.sessionId, turnId })[Symbol.asyncIterator]();
    const started = await first.next();
    expect(started.done).toBe(false);
    await expect(collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId }))).rejects.toMatchObject({ code: "TURN_ALREADY_RUNNING" });
    while (!(await first.next()).done) { /* 消费原执行流直至完成，释放本用例租约。 */ }
  });

  it("Esc 中断后选择 full，恢复采用新权限，原 frozen 与模型保持不变，重启仍可读取", async function interruptedResume() {
    const f = await fixture();
    await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const turn = (await f.ports.turnStore.getLatest(f.sessionId))!;
    await f.runtime.turns.cancel({ sessionId: f.sessionId, turnId: turn.id });
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access", modelRef: { provider: "other", modelId: "changed" } });
    const before = executed.commands.length;
    const events = await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId: turn.id, runConfig: { permissionMode: "ask", modelRef: { provider: "other", modelId: "injected" } } }));
    expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
    const saved = (await f.ports.turnStore.get(turn.id))!;
    expect(saved.frozenRunConfig.permissionMode).toBe("auto_approve");
    expect(saved.frozenRunConfig.modelRef?.modelId).toBe("fixture");
    expect(saved.permissionRevisions?.[0].permissionMode).toBe("full_access");
    expect((await f.runtime.turns.getState({ sessionId: f.sessionId, turnId: turn.id })).turn?.permissionRevisions).toBeUndefined();
    // 中断调用可能有未知结果，恢复不能直接重放它。
    expect(executed.commands.length).toBe(before);
    const restarted = createAgentRuntime({ ports: f.ports, defaultRunConfig: f.defaults });
    expect(await restarted.turns.getFrozenRunConfig({ sessionId: f.sessionId, turnId: turn.id })).toMatchObject({ permissionMode: "auto_approve", executionPermissionMode: "full_access" });
  });

  it("待审批切 full 重新评估普通命令，不消费旧批准，也不创建新 Turn", async function revalidatesPending() {
    const f = await fixture();
    const first = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const old = first.find(function approval(event) { return event.type === "approval_required"; });
    const turnId = old.turnId;
    await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId, approvalId: old.result.approval.approvalId, decision: "allow_once" });
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access" });
    const before = executed.commands.length;
    const events = await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId, approval: { approvalId: old.result.approval.approvalId, decision: "allow" } }));
    expect(events.some(function approved(event) { return event.type === "approval_required"; })).toBe(false);
    expect(executed.commands.length).toBe(before + 1);
    expect(await f.ports.turnStore.list(f.sessionId)).toHaveLength(1);
  });

  it("危险/外部副作用在切 full 后重新询问，旧批准不可重放，新的精确单次批准可执行", async function dangerousReapproval() {
    const f = await fixture("auto_approve", "git", ["restore", "fixture.txt"]);
    const first = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const old = first.find(function approval(event) { return event.type === "approval_required"; });
    const turnId = old.turnId;
    await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId, approvalId: old.result.approval.approvalId, decision: "allow_once" });
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access" });
    const before = executed.commands.length;
    const resumed = await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId, approval: { approvalId: old.result.approval.approvalId, decision: "allow" } }));
    const fresh = resumed.find(function approval(event) { return event.type === "approval_required"; });
    expect(fresh.result.approval.approvalId).not.toBe(old.result.approval.approvalId);
    expect(executed.commands.length).toBe(before);
    await expect(collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId, approval: { approvalId: old.result.approval.approvalId, decision: "allow" } }))).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId, approvalId: fresh.result.approval.approvalId, decision: "allow_once" });
    await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId, approval: { approvalId: fresh.result.approval.approvalId, decision: "allow" } }));
    expect(executed.commands.length).toBe(before + 1);
  });

  it("权限修订已持久化但启动失败，重试仍撤下旧批准并重新询问", async function failedStartKeepsApprovalInvalidated() {
    const f = await fixture("auto_approve", "curl");
    const first = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const old = first.find(function approval(event) { return event.type === "approval_required"; });
    const turnId = old.turnId;
    await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId, approvalId: old.result.approval.approvalId, decision: "allow_once" });
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "full_access" });
    const readSession = f.ports.sessionStore.get.bind(f.ports.sessionStore);
    let fail = true;
    vi.spyOn(f.ports.sessionStore, "get").mockImplementation(async function failAfterRevision(id) {
      if (fail && (await f.ports.turnStore.get(turnId))?.permissionRevisions?.length) { fail = false; throw new Error("fixture start failure"); }
      return readSession(id);
    });
    const input = { sessionId: f.sessionId, turnId, approval: { approvalId: old.result.approval.approvalId, decision: "allow" as const } };
    const before = executed.commands.length;
    await expect(collect(f.runtime.turns.continue(input))).rejects.toThrow("fixture start failure");
    const retried = await collect(f.runtime.turns.continue(input));
    const fresh = retried.find(function approval(event) { return event.type === "approval_required"; });
    expect(fresh.result.approval.approvalId).not.toBe(old.result.approval.approvalId);
    expect(executed.commands.length).toBe(before);
  });

  it("没有人类修订的旧 checkpoint 忽略 continue 提权，保存 ask 后恢复执行收紧", async function oldCheckpointAndTightening() {
    const f = await fixture();
    await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: "fixture" }));
    const turnId = (await f.ports.turnStore.getLatest(f.sessionId))!.id;
    const events = await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId, runConfig: { permissionMode: "full_access" } }));
    expect(events.some(function paused(event) { return event.type === "turn_paused" && event.checkpoint.status === "awaiting_approval"; })).toBe(true);
    expect((await f.runtime.turns.getFrozenRunConfig({ sessionId: f.sessionId, turnId }))?.executionPermissionMode).toBe("auto_approve");
    expect((await f.ports.turnStore.get(turnId))?.permissionRevisions).toBeUndefined();
    await f.runtime.sessions.setDefaultRunConfig(f.sessionId, { permissionMode: "ask" });
    const tightened = await collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId }));
    expect(tightened.some(function approval(event) { return event.type === "approval_required"; })).toBe(true);
    expect((await f.runtime.turns.getFrozenRunConfig({ sessionId: f.sessionId, turnId }))?.executionPermissionMode).toBe("ask");
  });
});
