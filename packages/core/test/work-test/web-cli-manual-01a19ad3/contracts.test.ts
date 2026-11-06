/** 本任务 Core 回归：精确幂等恢复、强制确认、预览预校验与流程图边界，全部使用隔离内存。 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadService } from "../../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../src/runtime/application/thread-delivery-service";
import { createThreadsToolBinding } from "../../../src/runtime/application/thread-tool-binding";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createAgentTextMessage } from "../../../src/internal/types/agent-message";
import { createThreadTools } from "../../../src/internal/tools/builtins/thread-tools";
import { createOpenPreviewTool } from "../../../src/internal/tools/builtins/open-preview-tool";
import { createStartBackgroundJobTool } from "../../../src/internal/tools/builtins/start-background-job-tool";
import { ToolExecutor } from "../../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";
import { validateUiSpec } from "../../../src/ui/catalog";
import { createNodeThreadRunner } from "../../../../adapters/src/node/thread-runner";
import type { AgentToolDefinition } from "../../../src/internal/tools/types";

/** 创建一个真实授权组与精确 interrupted checkpoint，禁止真实宿主/Provider。 */
async function fixture() {
  const ports = createMemoryPorts();
  const root = await createSessionService(ports).create({ title: "root" });
  const context = { workspaceId: "w", stateRootId: "state", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: ["resume_thread"], modelCatalog: [] };
  const threads = createThreadService(ports, ports.threadStore, context);
  const { group } = await threads.enable({ rootThreadId: root.id, requestId: "enable" });
  const child = await threads.create({ groupId: group.groupId, parentThreadId: root.id, requestId: "child" });
  const session = (await ports.sessionStore.get(child.threadId))!;
  await ports.sessionStore.save({ ...session, status: "interrupted" });
  await ports.turnStore.save({ id: "paused-turn", sessionId: child.threadId, status: "interrupted", frozenRunConfig: { workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: 1, schemaVersion: 2 });
  await ports.checkpointStore.save(child.threadId, { messageSchemaVersion: 2, turnId: "paused-turn", status: "interrupted_recoverable", stepCount: 0, messages: [createAgentTextMessage("user", "继续原任务")], completedCallIds: [] });
  await ports.sessionStore.save({ ...root, status: "running", activeTurnId: "source" });
  await ports.turnStore.save({ id: "source", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: 1, schemaVersion: 2 });
  return { ports, root, child, groupId: group.groupId, context, threads, request: { groupId: group.groupId, threadId: child.threadId, expectedTurnId: "paused-turn", requestId: "resume-1" } };
}

/** 工具真实统一执行器，便于确认拒绝发生在审批/副作用之前。 */
function executor(tool: AgentToolDefinition<any, any>, permissionMode: "ask" | "auto_approve" | "full_access" = "ask") {
  const registry = new ToolRegistry({ productMode: "work" });
  registry.register(tool);
  return new ToolExecutor(registry, { permissionMode, workspaceTrusted: true, capabilityCeiling: { productMode: "work" } });
}

describe("Web CLI manual contracts", function contracts() {
  it("精确恢复按 checkpoint 幂等，不创建消息/新任务，拒绝组外目标和旧 Turn", async function idempotentResume() {
    const f = await fixture();
    const a = await f.threads.resume(f.request);
    expect(await f.threads.resume({ ...f.request, requestId: "another-call" })).toEqual(a);
    expect(await f.threads.resume(f.request)).toEqual(a);
    await expect(f.threads.resume({ ...f.request, requestId: "wrong-turn", expectedTurnId: "old-turn" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    await expect(f.threads.resume({ ...f.request, requestId: "outside", threadId: "outside" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    const state = (await f.ports.threadStore.readControl(f.groupId))!;
    expect(state.controls).toHaveLength(1);
    expect(state.messageIntents).toHaveLength(0);
    expect(state.deliveries).toHaveLength(0);
  });

  it("过期审批不再通过权威恢复视图交付可操作身份，新审批按精确 ID 恢复", async function expiredApproval() {
    const f = await fixture();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    const turn = (await f.ports.turnStore.get("paused-turn"))!;
    const checkpoint = (await f.ports.checkpointStore.getLatest(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval" });
    await f.ports.turnStore.save({ ...turn, status: "waiting_approval" });
    await f.ports.checkpointStore.save(f.child.threadId, { ...checkpoint, status: "awaiting_approval" });
    const runtime = createAgentRuntime({ ports: f.ports });
    /** 仅写隔离 transcript 审批事实，不提交真实批准。 */
    async function append(approvalId: string, expiresAt: number, seq: number) {
      await f.ports.transcriptStore.append(f.child.threadId, { sessionId: f.child.threadId, turnId: "paused-turn", seq, timestamp: new Date().toISOString(), event: { type: "approval_required", turnId: "paused-turn", stepId: "step", callId: "call", toolName: "write_file", result: { status: "approval_required", approval: { approvalId, toolName: "write_file", expiresAt: new Date(expiresAt).toISOString() } } } as any });
    }
    await append("expired", f.ports.clock.now() - 1000, 1);
    expect((await runtime.turns.getRecoverableState({ sessionId: f.child.threadId }))?.approval).toBeUndefined();
    await append("new-current", f.ports.clock.now() + 60000, 2);
    expect((await runtime.turns.getRecoverableState({ sessionId: f.child.threadId }))?.approval?.approvalId).toBe("new-current");
  });

  it("审批/问答等待不能被恢复控制越过，缺执行 lease 不误报宿主离线", async function waitingBoundary() {
    const f = await fixture();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    const turn = (await f.ports.turnStore.get("paused-turn"))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval" });
    await f.ports.turnStore.save({ ...turn, status: "waiting_approval" });
    const checkpoint = (await f.ports.checkpointStore.getLatest(f.child.threadId))!;
    await f.ports.checkpointStore.save(f.child.threadId, { ...checkpoint, status: "awaiting_approval" });
    await expect(f.threads.resume(f.request)).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
    expect(await f.threads.interrupt({ ...f.request, requestId: "interrupt" })).toMatchObject({ hostOffline: false });
    await f.ports.sessionStore.save({ ...session, status: "waiting_user_input" });
    await f.ports.turnStore.save({ ...turn, status: "waiting_user_input" });
    await expect(f.threads.resume({ ...f.request, requestId: "question" })).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  });

  it("所有权限模式均要求单次恢复确认，未确认零控制写入", async function explicitConfirmation() {
    const f = await fixture();
    const binding = createThreadsToolBinding(f.ports, f.context, { threadId: f.root.id, turnId: "source" });
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      const tool = createThreadTools(binding).resumeThread;
      const result = await executor(tool, mode).execute({ callId: `resume-${mode}`, toolName: tool.name, input: { threadId: f.child.threadId, expectedTurnId: "paused-turn" } });
      expect(result.status).toBe("approval_required");
      if (result.status === "approval_required") expect(result.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
    }
    expect((await f.ports.threadStore.readControl(f.groupId))!.controls).toHaveLength(0);
  });

  it("旧恢复批准不能跨到同一 Turn 后来的暂停 checkpoint", async function frozenResumeApproval() {
    const f = await fixture();
    const binding = createThreadsToolBinding(f.ports, f.context, { threadId: f.root.id, turnId: "source" });
    const tool = createThreadTools(binding).resumeThread;
    const run = executor(tool);
    const input = { threadId: f.child.threadId, expectedTurnId: "paused-turn" };
    const pending = await run.execute({ callId: "resume", toolName: tool.name, input });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required") throw new Error("expected approval");
    const checkpoint = (await f.ports.checkpointStore.getLatest(f.child.threadId))!;
    await f.ports.checkpointStore.save(f.child.threadId, { ...checkpoint, stepCount: 4 });
    const late = await run.execute({ callId: "resume", toolName: tool.name, input, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(late.status).toBe("error");
    expect((await f.ports.threadStore.readControl(f.groupId))!.controls).toHaveLength(0);
  });

  it("两个 Runner 竞争恢复只继续原冻结 Turn 一次，完成后没有额外 run", async function runnerContinuation() {
    const f = await fixture();
    let samples = 0;
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: { async sample() { samples++; return { content: "已恢复", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; } } } });
    await f.threads.resume(f.request);
    const errors: unknown[] = [];
    const runners = ["host-a", "host-b"].map(function runner(ownerId) { return createNodeThreadRunner({ delivery: createThreadDeliveryService(f.ports, f.ports.threadStore, { workspaceId: "w", stateRootId: "state", ownerId }), runtime, ports: f.ports, pollIntervalMs: 10, onError: function error(value) { errors.push(value); } }); });
    try {
      await Promise.all(runners.map(function start(runner) { return runner.start(); }));
      await vi.waitFor(async function completed() { expect((await f.ports.turnStore.get("paused-turn"))?.status).toBe("completed"); }, { timeout: 4000 });
      expect(samples).toBe(1);
      expect(await f.ports.turnStore.list(f.child.threadId)).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(await f.threads.resume(f.request)).toMatchObject({ accepted: true });
      expect((await f.ports.threadStore.readControl(f.groupId))!.deliveries).toHaveLength(0);
    } finally { await Promise.all(runners.map(function stop(runner) { return runner.stop(); })); }
  });

  it("恢复领取后崩溃窗口明确未确认，原 Continue 仍可使用且不创建新任务", async function resumeCrashWindow() {
    const f = await fixture();
    const accepted = await f.threads.resume(f.request);
    const delivery = createThreadDeliveryService(f.ports, f.ports.threadStore, { workspaceId: "w", stateRootId: "state", ownerId: "crashed" });
    expect(await delivery.claimResume({ groupId: f.groupId, controlId: accepted.controlId })).toBe(true);
    expect(await f.threads.resume(f.request)).toMatchObject({ accepted: true, recoveryAction: "open_target_continue" });
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: { async sample() { return { content: "直接继续成功", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; } } } });
    for await (const _event of runtime.turns.continue({ sessionId: f.child.threadId, turnId: "paused-turn" })) { /* 原生恢复入口，不自动重放领取 */ }
    expect((await f.ports.turnStore.get("paused-turn"))?.status).toBe("completed");
    expect(await f.ports.turnStore.list(f.child.threadId)).toHaveLength(1);
    expect((await f.ports.threadStore.readControl(f.groupId))!.deliveries).toHaveLength(0);
  });

  it("无效预览与 Job 服务路径在审批前拒绝，零网络/启动", async function previewPreflight() {
    const preparePreview = vi.fn();
    const capability = { preparePreview, validatePreviewTarget: vi.fn(function target(url: string) { if (url.includes(":3000")) throw Object.assign(new Error("invalid"), { code: "PREVIEW_INVALID_TARGET" }); }) };
    const tool = createOpenPreviewTool({ capability, workspaceId: "w", sessionId: "target", turnId: "target-turn" });
    for (const url of ["file:///demo.html", "http://127.0.0.1:3000/demo"]) {
      expect((await executor(tool).execute({ callId: "preview", toolName: tool.name, input: { url } })).status).toBe("error");
    }
    const good = await executor(tool).execute({ callId: "valid", toolName: tool.name, input: { url: "http://127.0.0.1:8123/demo.html" } });
    expect(good.status).toBe("approval_required");
    const start = vi.fn();
    const jobTool = createStartBackgroundJobTool({ jobs: { start } as any, workspaceId: "w", workspaceRoot: process.cwd(), sessionId: "target", turnId: "target-turn" });
    const invalid = await executor(jobTool).execute({ callId: "job", toolName: jobTool.name, input: { program: "node", serviceUrl: "http://127.0.0.1:8123/demo.html" } });
    expect(invalid.status).toBe("error");
    expect(start).not.toHaveBeenCalled();
    expect(preparePreview).not.toHaveBeenCalled();
  });

  it("预览归属绑定实际目标，模型不能用 sessionId 伪造主体", async function previewIdentity() {
    const preparePreview = vi.fn(async function prepare(request) { return { previewId: "preview", hostLabel: "localhost:8123", copyUrl: request.url, openWhen: request.openWhen, state: "prepared" as const }; });
    const tool = createOpenPreviewTool({ capability: { preparePreview }, workspaceId: "w", sessionId: "child", turnId: "child-turn" });
    expect(tool.inputSchema.safeParse({ url: "http://localhost:8123/demo", sessionId: "parent" }).success).toBe(false);
    await executor(tool, "full_access").execute({ callId: "target-preview", toolName: tool.name, input: { url: "http://localhost:8123/demo" } });
    expect(preparePreview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child", turnId: "child-turn", callId: "target-preview" }));
  });

  it("流程图限制数量、重复节点/边与悬空引用，允许基本分支及回路", function flowSchema() {
    const props = { direction: "TB", description: "检查后成功或返回重试", nodes: [{ id: "start", label: "开始" }, { id: "check", label: "检查", kind: "decision" }], edges: [{ id: "go", from: "start", to: "check" }, { id: "back", from: "check", to: "start", label: "否" }] };
    function spec(value: unknown) { return { root: "flow", elements: { flow: { type: "Flowchart", props: value } } }; }
    expect(validateUiSpec(spec(props)).elements.flow.type).toBe("Flowchart");
    for (const value of [{ ...props, nodes: [...props.nodes, props.nodes[0]] }, { ...props, edges: [...props.edges, props.edges[0]] }, { ...props, edges: [{ id: "bad", from: "start", to: "absent" }] }, { ...props, nodes: Array.from({ length: 25 }, function node(_, i) { return { id: `n${i}`, label: "node" }; }) }, { ...props, nodes: [{ id: "n", label: "x".repeat(41) }] }]) expect(function reject() { validateUiSpec(spec(value)); }).toThrow();
  });
});
