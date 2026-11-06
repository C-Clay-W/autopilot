/** Plan1101 W5b/W5c：假时钟验证唯一 timeout 解析、真实 Kernel 审批恢复和中止首因。 */
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentKernel } from "../../src/internal/kernel/agent-kernel";
import { createToolScheduler } from "../../src/internal/tool-scheduler";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../src/internal/tools/types";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import { createAgentTextMessage } from "../../src/internal/types/agent-message";

/** 所有用例结束后恢复全局计时器与 spy。 */
afterEach(function restore() { vi.useRealTimers(); vi.restoreAllMocks(); });

/** 可控假工具只记录执行输入和 signal；完成/异常由测试主动触发，不在 abort 后自动结算。 */
function createFixture(requiresApproval = false) {
  let markStarted!: () => void;
  let resolveTool!: (value: Record<string, never>) => void;
  let rejectTool!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  let seenInput: unknown;
  const started = new Promise<void>(function waitStarted(resolve) { markStarted = resolve; });
  const gate = new Promise<Record<string, never>>(function waitCompletion(resolve, reject) { resolveTool = resolve; rejectTool = reject; });
  const execute = vi.fn(async function executeFixture(input: { timeoutMs?: number }, context: ToolExecutionContext) {
    signal = context.signal;
    seenInput = input;
    markStarted();
    return gate;
  });
  const registry = new ToolRegistry();
  registry.register({
    name: "deadline_fixture", description: "受控超时回归载体",
    inputSchema: z.object({ timeoutMs: z.number().int().positive().optional() }),
    metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false }, timeout: { defaultMs: 30_000, maxMs: 120_000 } },
    createActionFacts: function facts() { return { toolName: "deadline_fixture", effect: "none", destructive: false, operation: "read", requiresApproval, stableConstraint: "deadline-fixture" }; },
    execute,
    serializeOutput: function serialize(output) { return output; },
  });
  const executor = new ToolExecutor(registry, { permissionMode: "ask" });
  return {
    registry, executor, started, execute,
    signal: function currentSignal() { return signal; },
    input: function currentInput() { return seenInput; },
    finish: function finish(kind: "resolve" | "reject" = "resolve") {
      if (kind === "resolve") resolveTool({});
      else rejectTool(new Error("late ordinary failure"));
    },
  };
}

/** 收集真实 Kernel 事件，不连接 Provider。 */
async function collect(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** 先通过 Kernel 暂停，再让新 Kernel 从同一 checkpoint/批准调用真实恢复分支。 */
async function resumeApprovedKernel(f: ReturnType<typeof createFixture>, input: { timeoutMs?: number }): Promise<{ execution: Promise<ToolExecutionResult> }> {
  const initial = await collect(createAgentKernel({
    turnId: "deadline-approval", messages: [createAgentTextMessage("user", "只读执行受控检查。")],
    toolRegistry: f.registry, permissionContext: { mode: "ask" },
    modelSampler: { async sample() { return { content: "", toolCalls: [{ id: "approved-call", name: "deadline_fixture", input }], reasoningSummary: "" }; } },
  }).run());
  const paused = initial.find(function pause(event) { return event.type === "turn_paused"; });
  const approval = initial.find(function request(event) { return event.type === "approval_required"; });
  if (paused?.type !== "turn_paused" || approval?.type !== "approval_required" || approval.result.status !== "approval_required") throw new Error("expected real approval pause");
  expect(paused.checkpoint.pendingCalls?.[0].input).toEqual(input);
  expect(f.execute).not.toHaveBeenCalled();
  const validateApproval = vi.fn().mockResolvedValue(true);
  const execution = collect(createAgentKernel({
    turnId: paused.checkpoint.turnId, messages: paused.checkpoint.messages, checkpoint: paused.checkpoint,
    approval: { approvalId: approval.result.approval.approvalId, decision: "allow_once" },
    toolRegistry: f.registry, permissionContext: { mode: "ask", validateApproval },
    modelSampler: { async sample() { return { content: "检查结束。", toolCalls: [], reasoningSummary: "" }; } },
  }).run()).then(function findToolResult(events) {
    expect(validateApproval).toHaveBeenCalledOnce();
    const result = events.find(function toolResult(event) { return event.type === "tool_result" && event.callId === "approved-call"; });
    if (result?.type !== "tool_result") throw new Error("expected resumed tool result");
    return result.result;
  });
  return { execution };
}

/** 所有路径都由同一 Executor 计时，批准输入及内部剩余预算均不能被扩大。 */
it.each([
  { path: "scheduler", input: { timeoutMs: 90_000 }, expected: 90_000, budget: undefined },
  { path: "kernel-resume", input: { timeoutMs: 90_000 }, expected: 90_000, budget: undefined },
  { path: "scheduler", input: {}, expected: 30_000, budget: undefined },
  { path: "scheduler", input: { timeoutMs: 150_000 }, expected: 120_000, budget: undefined },
  { path: "internal-budget", input: { timeoutMs: 90_000 }, expected: 25_000, budget: 25_000 },
  { path: "internal-budget", input: { timeoutMs: 10_000 }, expected: 10_000, budget: 50_000 },
])("W5b $path input=$input budget=$budget deadline=$expected", async function resolvesSameTimeout({ path, input, expected, budget }) {
  vi.useFakeTimers();
  const f = createFixture(path === "kernel-resume");
  let execution: Promise<ToolExecutionResult>;
  if (path === "kernel-resume") execution = (await resumeApprovedKernel(f, input)).execution;
  else if (path === "scheduler") {
    const scheduler = createToolScheduler(f.registry, function execute(request, options) { return f.executor.execute(request, options); });
    execution = scheduler.executeCalls([{ id: "ordinary-call", name: "deadline_fixture", input }]).then(function first(results) { return results[0].result; });
  } else execution = f.executor.execute({ callId: "budget-call", toolName: "deadline_fixture", input }, { timeoutMs: budget });
  await f.started;
  expect(f.input()).toEqual(input);
  await vi.advanceTimersByTimeAsync(expected - 1);
  expect(f.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.signal()?.aborted).toBe(true);
  f.finish();
  expect(await execution).toMatchObject({ status: "timeout", interruption: { sideEffectState: "unknown", safeToRetry: false } });
  expect(vi.getTimerCount()).toBe(0);
});

/** 工具晚返回成功或普通异常，均按首个取消/超时报告，执行中的副作用仍为 unknown。 */
it.each([
  { first: "cancel", completion: "resolve" }, { first: "cancel", completion: "reject" },
  { first: "timeout", completion: "resolve" }, { first: "timeout", completion: "reject" },
] as const)("W5c $first 首因不被晚 $completion 或第二次中止覆盖", async function preservesFirstCause({ first, completion }) {
  vi.useFakeTimers();
  const f = createFixture();
  const controller = new AbortController();
  const execution = f.executor.execute({ callId: "race", toolName: "deadline_fixture", input: { timeoutMs: 1_000 } }, { signal: controller.signal });
  await f.started;
  if (first === "cancel") { controller.abort(); await vi.advanceTimersByTimeAsync(1_001); }
  else { await vi.advanceTimersByTimeAsync(1_001); controller.abort(); }
  f.finish(completion);
  expect(await execution).toMatchObject({ status: first === "cancel" ? "cancelled" : "timeout", interruption: { sideEffectState: "unknown", safeToRetry: false } });
  expect(vi.getTimerCount()).toBe(0);
});

/** 执行前已取消不会进入工具，也不遗留 deadline timer。 */
it("W5c 已 aborted 的调用不执行且清理 timer", async function rejectsAlreadyAborted() {
  vi.useFakeTimers();
  const f = createFixture();
  const controller = new AbortController();
  controller.abort();
  expect(await f.executor.execute({ callId: "already", toolName: "deadline_fixture", input: {} }, { signal: controller.signal })).toMatchObject({ status: "cancelled", interruption: { phase: "before_execution", sideEffectState: "not_started", safeToRetry: true } });
  expect(f.execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

/** 成功先完成时清理 timer 与父信号监听；稍后的取消不改变已交付结果。 */
it("W5c 成功先完成则 cleanup 解除 timer 和父信号监听", async function cleansCompletedDeadline() {
  vi.useFakeTimers();
  const f = createFixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const execution = f.executor.execute({ callId: "success", toolName: "deadline_fixture", input: { timeoutMs: 1_000 } }, { signal: controller.signal });
  await f.started;
  f.finish();
  expect((await execution).status).toBe("success");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(f.signal()?.aborted).toBe(false);
});
