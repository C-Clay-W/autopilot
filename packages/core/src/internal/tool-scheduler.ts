/**
 * Agent 工具调度器：由 ToolDefinition metadata 声明并发、资源、重试与超时，并固定按模型原顺序回灌结果。
 */
import type { AgentToolCall } from "./types";
import type { ToolRegistry } from "./tools/tool-registry";
import type { ToolExecutionOptions, ToolExecutionRequest, ToolExecutionResult } from "./tools/types";
import { createSyntheticToolErrorResult } from "./tools/synthetic-tool-result";

export interface ScheduledToolResult {
  call: AgentToolCall;
  result: ToolExecutionResult;
  retryCount: number;
}

export interface ToolSchedulerOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  /** 工具执行期间的节流进度回调；由 Kernel 通过 race-drain 往外转发 tool_progress 事件。 */
  onProgress?: (callId: string, chunk: string) => void;
  /** 每条调用的最终结果完成时通知；重试中间态不通知，最终数组仍按原调用顺序。 */
  onResult?: (result: ScheduledToolResult) => void;
}

interface ScheduledCall {
  call: AgentToolCall;
  resourceKey: string;
  concurrency: number;
  maxRetries: number;
  timeoutMs?: number;
}

/** 解析 metadata 的资源键；未声明时每个工具独立共享自己的并发额度。 */
function resolveResourceKey(call: AgentToolCall, registry: ToolRegistry): string {
  const resourceKey = registry.get(call.name).metadata.concurrency.resourceKey;
  const resolved = typeof resourceKey === "function" ? resourceKey(call.input) : resourceKey;
  if (typeof resolved === "string" && resolved.trim()) return resolved;
  return `tool:${call.name}`;
}

/** 从工具输入中的 timeoutMs 读取请求值，并限制在 metadata 声明的可接受范围内。 */
function resolveTimeoutMs(input: unknown, timeout: { defaultMs?: number; maxMs?: number } | undefined): number | undefined {
  if (!timeout?.defaultMs) return undefined;
  const requested = input && typeof input === "object" && typeof (input as { timeoutMs?: unknown }).timeoutMs === "number"
    ? (input as { timeoutMs: number }).timeoutMs
    : timeout.defaultMs;
  return timeout.maxMs === undefined ? requested : Math.min(requested, timeout.maxMs);
}

/** 将调用转为已解析的调度约束；重试上限只在此处与 Stage 8 冻结限制取最小值。 */
function prepareCall(call: AgentToolCall, registry: ToolRegistry, globalMaxRetries: number): ScheduledCall {
  const metadata = registry.get(call.name).metadata;
  const maxRetries = metadata.retry.safe ? Math.min(globalMaxRetries, metadata.retry.maxRetries ?? globalMaxRetries) : 0;
  return {
    call,
    resourceKey: resolveResourceKey(call, registry),
    concurrency: metadata.concurrency.max,
    maxRetries,
    timeoutMs: resolveTimeoutMs(call.input, metadata.timeout),
  };
}

/** 判断失败是否符合工具显式声明的无副作用重试条件。 */
function isSafelyRetryable(result: ToolExecutionResult): boolean {
  return result.status === "error" && result.error.code === "TOOL_EXECUTION_FAILED";
}

/** 将工具终态转换为可直接回灌模型的紧凑观察文本。 */
export function serializeToolResultForModel(result: ToolExecutionResult): string {
  if (result.status === "success") return JSON.stringify({ status: result.status, output: result.output });
  if (result.status === "question_required") return JSON.stringify({ status: result.status, requestId: result.request.requestId, questionCount: result.request.questions.length });
  if (result.status === "approval_required") return JSON.stringify({ status: result.status, approvalId: result.approval.approvalId, reason: result.approval.reason });
  return JSON.stringify({ status: result.status, error: result.error });
}

/** 创建工具调度器；执行器由 Agent Runtime 提供，P3 不复制 P4 的权限和 Schema 校验。 */
export function createToolScheduler(
  registry: ToolRegistry,
  execute: (request: ToolExecutionRequest, options?: ToolExecutionOptions) => Promise<ToolExecutionResult>,
) {
  /** 单次执行并在安全情况下最多重试指定次数。 */
  async function executeWithRetry(scheduled: ScheduledCall, options: ToolSchedulerOptions): Promise<ScheduledToolResult> {
    let retryCount = 0;
    let result = await execute({ callId: scheduled.call.id, toolName: scheduled.call.name, input: scheduled.call.input }, { signal: options.signal, timeoutMs: scheduled.timeoutMs, ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
    while (retryCount < scheduled.maxRetries && isSafelyRetryable(result) && !options.signal?.aborted) {
      retryCount++;
      result = await execute({ callId: scheduled.call.id, toolName: scheduled.call.name, input: scheduled.call.input }, { signal: options.signal, timeoutMs: scheduled.timeoutMs, ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
    }
    return { call: scheduled.call, result, retryCount };
  }

  /** 按 metadata 的资源并发额度执行调用，最终数组永远保持模型提供的调用顺序。 */
  async function executeCalls(calls: AgentToolCall[], options: ToolSchedulerOptions = {}): Promise<ScheduledToolResult[]> {
    const scheduledCalls = calls.map((call) => prepareCall(call, registry, options.maxRetries ?? 0));
    const resourceLimits = new Map<string, number>();
    for (const scheduled of scheduledCalls) {
      const existing = resourceLimits.get(scheduled.resourceKey);
      resourceLimits.set(scheduled.resourceKey, existing === undefined ? scheduled.concurrency : Math.min(existing, scheduled.concurrency));
    }
    const activeByResource = new Map<string, number>();
    const results = new Array<ScheduledToolResult>(scheduledCalls.length);
    const pendingIndexes = scheduledCalls.map((_call, index) => index);
    const active = new Set<Promise<void>>();

    /** 启动一个已通过资源并发检查的调用，并在结束后释放其额度。 */
    function start(index: number): void {
      const scheduled = scheduledCalls[index];
      activeByResource.set(scheduled.resourceKey, (activeByResource.get(scheduled.resourceKey) ?? 0) + 1);
      const task = executeWithRetry(scheduled, options).then(function complete(result) {
        results[index] = result;
        options.onResult?.(result);
      }).finally(() => {
        activeByResource.set(scheduled.resourceKey, (activeByResource.get(scheduled.resourceKey) ?? 1) - 1);
        active.delete(task);
      });
      active.add(task);
    }

    while (pendingIndexes.length > 0 || active.size > 0) {
      if (options.signal?.aborted && pendingIndexes.length > 0) {
        for (const index of pendingIndexes.splice(0)) {
          const call = scheduledCalls[index]!.call;
          results[index] = { call, result: createSyntheticToolErrorResult(call, "TOOL_ABORTED_BEFORE_DISPATCH", "取消信号到达时工具尚未开始执行"), retryCount: 0 };
          options.onResult?.(results[index]);
        }
      }
      let started = false;
      for (let pendingIndex = 0; pendingIndex < pendingIndexes.length;) {
        const index = pendingIndexes[pendingIndex];
        const scheduled = scheduledCalls[index];
        const activeCount = activeByResource.get(scheduled.resourceKey) ?? 0;
        if (activeCount >= (resourceLimits.get(scheduled.resourceKey) ?? 1)) {
          pendingIndex++;
          continue;
        }
        pendingIndexes.splice(pendingIndex, 1);
        start(index);
        started = true;
      }
      if (!started && active.size > 0) await Promise.race(active);
    }
    return results;
  }

  return { executeCalls };
}
