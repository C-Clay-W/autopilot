/** Plan1101 W5a：用受控 child/停止底座验证前台命令等待真实 close 与资源释放边界。 */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import { createAgentKernel } from "../../src/internal/kernel/agent-kernel";
import { createAgentTextMessage } from "../../src/internal/types/agent-message";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import type { ToolExecutionContext } from "../../src/internal/tools/types";

const mocks = vi.hoisted(function createMocks() { return { spawn: vi.fn(), stop: vi.fn() }; });
vi.mock("node:child_process", function mockSpawn() { return { spawn: mocks.spawn }; });
vi.mock("../../src/internal/tools/process-utils", async function mockStop(importOriginal) {
  return { ...await importOriginal<typeof import("../../src/internal/tools/process-utils")>(), terminateManagedProcessTree: mocks.stop };
});

/** 恢复计时器和隔离 mock；用例不启动真实进程。 */
afterEach(function restore() { vi.useRealTimers(); mocks.spawn.mockReset(); mocks.stop.mockReset(); });

/** 保留真实命令 execute 与 Executor 终态，只替换权限事实及沙箱进程端口。 */
function createCommandFixture(requiresApproval = false) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  mocks.spawn.mockReturnValue(child);
  const release = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn().mockResolvedValue({ executionId: "owned-command", executable: process.execPath, args: [], env: {}, enforcement: "full" });
  const scope = { port: { prepare, release }, policy: { mode: "workspace-write" } } as unknown as NonNullable<ToolExecutionContext["sandboxPolicy"]>;
  const registry = new ToolRegistry();
  const tool = createRunCommandTool();
  registry.register({
    ...tool, name: "stop_fixture",
    createActionFacts: function facts() { return { toolName: "stop_fixture", effect: "none", destructive: false, operation: "read", requiresApproval }; },
    execute: function executeCommand(input: Parameters<typeof tool.execute>[0], context: ToolExecutionContext) { return tool.execute(input, { ...context, sandboxPolicy: scope }); },
  });
  return { child, release, registry };
}

/** 通过真实 Executor 启动 mock 命令，等目录守卫结束后交给用例触发中断。 */
async function setup() {
  const { child, release, registry } = createCommandFixture();
  const executor = new ToolExecutor(registry, {
    workspaceRoot: process.cwd(), permissionMode: "full_access",
  });
  const controller = new AbortController();
  const progress: string[] = [];
  let settled = false;
  const execution = executor.execute({ callId: "stop", toolName: "stop_fixture", input: { program: process.execPath, args: [], cwd: ".", timeoutMs: 1_000 } }, {
    signal: controller.signal, timeoutMs: 1_000,
    onProgress: function observe(_callId, chunk) { progress.push(chunk); },
  }).then(function finish(result) { settled = true; return result; });
  // 等待真实异步目录守卫及 prepare 完成；不依赖不稳定的固定微任务次数。
  await vi.waitFor(function spawned() { expect(mocks.spawn).toHaveBeenCalledOnce(); });
  return { child, release, controller, progress, execution, settled: function isSettled() { return settled; } };
}

/** 已确认停止和真实 close 都到达后才及时收尾，并只发起一次停止。 */
it("W5a 停止成功等真实 close 且并发取消只请求一次", async function stopsOnce() {
  let completeStop!: () => void;
  mocks.stop.mockImplementation(function stopOwned() { return new Promise<void>(function wait(resolve) { completeStop = resolve; }); });
  const f = await setup();
  f.controller.abort();
  f.child.emit("close", null);
  await Promise.resolve();
  expect(f.release).not.toHaveBeenCalled();
  completeStop();
  expect(await f.execution).toMatchObject({ status: "cancelled", interruption: { sideEffectState: "unknown", safeToRetry: false } });
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledWith(f.child);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.progress).toEqual([]);
});

/** taskkill 非零/超时经底座映射为固定失败，root 未 close 前保留执行归属。 */
it.each(["FAILED", "TIMEOUT"])("W5a 停止 %s 未确认不提前结算或释放", async function waitsAfterStopFailure(code) {
  mocks.stop.mockRejectedValue(Object.assign(new Error("private taskkill detail"), { code }));
  const f = await setup();
  f.controller.abort();
  await vi.waitFor(function reported() { expect(f.progress).toEqual(["停止未确认，仍等待执行结束"]); });
  await new Promise<void>(function beyondDeadline(resolve) { setTimeout(resolve, 1_100); });
  expect(f.settled()).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalledOnce();
  // 即便 error 先到也不能代替真实 close 或重新发起终止。
  f.child.emit("error", new Error("late child error"));
  expect(f.settled()).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  f.child.emit("close", null);
  expect(await f.execution).toMatchObject({ status: "cancelled", interruption: { sideEffectState: "unknown", safeToRetry: false } });
  expect(f.release).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledOnce();
});

/** 收集 Kernel 的真实审批暂停/恢复事件。 */
async function collect(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** 审批恢复中的停止未确认要即时可见，但不把进度当作执行终态。 */
it("W5a Kernel 审批恢复在真实 close 前转发停止未确认进度", async function forwardsResumeStopProgress() {
  mocks.stop.mockRejectedValue(Object.assign(new Error("private stop failure"), { code: "FAILED" }));
  const f = createCommandFixture(true);
  const input = { program: process.execPath, args: [], cwd: ".", timeoutMs: 5_000 };
  const initial = await collect(createAgentKernel({
    turnId: "resume-stop", messages: [createAgentTextMessage("user", "只读受控检查。")], workspaceRoot: process.cwd(),
    toolRegistry: f.registry, permissionContext: { mode: "ask" },
    modelSampler: { async sample() { return { content: "", toolCalls: [{ id: "resume-command", name: "stop_fixture", input }], reasoningSummary: "" }; } },
  }).run());
  const paused = initial.find(function pause(event) { return event.type === "turn_paused"; });
  const approval = initial.find(function request(event) { return event.type === "approval_required"; });
  if (paused?.type !== "turn_paused" || approval?.type !== "approval_required" || approval.result.status !== "approval_required") throw new Error("expected real approval pause");
  const controller = new AbortController();
  let reportProgress!: () => void;
  const progress = new Promise<void>(function waitForProgress(resolve) { reportProgress = resolve; });
  const events: AgentLoopEvent[] = [];
  let settled = false;
  const resumed = createAgentKernel({
    turnId: "resume-stop", messages: paused.checkpoint.messages, checkpoint: paused.checkpoint, workspaceRoot: process.cwd(),
    approval: { approvalId: approval.result.approval.approvalId, decision: "allow_once" }, signal: controller.signal,
    toolRegistry: f.registry, permissionContext: { mode: "ask", validateApproval: async function approved() { return true; } },
    modelSampler: { async sample() { return { content: "检查结束。", toolCalls: [], reasoningSummary: "" }; } },
  });
  const execution = (async function observeResume() {
    for await (const event of resumed.run()) {
      events.push(event);
      if (event.type === "tool_progress") reportProgress();
    }
    settled = true;
  })();
  await vi.waitFor(function spawned() { expect(mocks.spawn).toHaveBeenCalledOnce(); });
  controller.abort();
  await progress;
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_progress", turnId: "resume-stop", callId: "resume-command", tail: "停止未确认，仍等待执行结束" }));
  expect(settled).toBe(false);
  expect(events.some(function terminal(event) { return event.type === "tool_result" || event.type === "turn_interrupted" || event.type === "turn_completed" || event.type === "turn_failed"; })).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  f.child.emit("close", null);
  await execution;
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "resume-command", result: expect.objectContaining({ status: "cancelled", interruption: expect.objectContaining({ sideEffectState: "unknown", safeToRetry: false }) }) }));
  expect(f.release).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
