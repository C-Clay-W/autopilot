/**
 * Stage 11 工具元数据测试：验证注册校验、调度边界，以及新增工具不依赖 Kernel 名称名单。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentKernel } from "../kernel/agent-kernel";
import { createToolScheduler } from "../tool-scheduler";
import { ToolRegistry } from "./tool-registry";
import type { AgentToolDefinition, ToolExecutionResult, ToolMetadata } from "./types";
import { createAgentTextMessage } from "../types/agent-message";

const probeSchema = z.object({ group: z.string(), timeoutMs: z.number().int().positive().optional() }).strict();

/** 创建只供测试使用的无副作用工具定义，实际调度执行器由各用例注入。 */
function createProbeTool(metadata: ToolMetadata, execute?: AgentToolDefinition<z.infer<typeof probeSchema>, Record<string, unknown>>["execute"]): AgentToolDefinition<z.infer<typeof probeSchema>, Record<string, unknown>> {
  return {
    name: "metadata_probe",
    description: "metadata probe",
    inputSchema: probeSchema,
    metadata,
    createActionFacts: () => ({ toolName: "probe", effect: "none", destructive: false, operation: "test", risk: "read_only" }),
    async execute(input, context) {
      if (execute) return execute(input, context);
      return { group: input.group };
    },
    serializeOutput(output) { return output; },
  };
}

/** 构造最小成功终态，避免调度测试依赖真实文件或 Provider。 */
function success(callId: string, toolName: string): ToolExecutionResult {
  return { status: "success", callId, toolName, output: {}, meta: { durationMs: 0, inputHash: "test" } };
}

/** 等待受控短延迟，以便验证并发上限而不接触真实运行时资源。 */
function wait(milliseconds: number): Promise<void> {
  return new Promise(function waitForDelay(resolve) { setTimeout(resolve, milliseconds); });
}

describe("Stage 11 Tool Metadata", function toolMetadataSuite() {
  it("拒绝会放宽副作用或重试边界的 metadata 组合", function rejectsUnsafeMetadata() {
    const registry = new ToolRegistry();
    expect(() => registry.register(createProbeTool({
      effect: "external",
      destructive: false,
      concurrency: { max: 1 },
      retry: { safe: true },
    }))).toThrow("只有非破坏性的无副作用工具可以声明安全重试");
  });

  it("模型定义不暴露内部 metadata", function hidesMetadataFromModel() {
    const registry = new ToolRegistry();
    registry.register(createProbeTool({ effect: "none", destructive: false, concurrency: { max: 2 }, retry: { safe: true } }));
    expect(registry.getModelDefinitions()[0]).not.toHaveProperty("metadata");
  });

  it("新增测试工具只凭 metadata 获得资源并发、重试上限与超时范围", async function schedulesFromMetadata() {
    const registry = new ToolRegistry();
    registry.register(createProbeTool({
      effect: "none",
      destructive: false,
      concurrency: { max: 2, resourceKey: (input) => `probe:${(input as { group: string }).group}` },
      retry: { safe: true, maxRetries: 1 },
      timeout: { defaultMs: 25, maxMs: 50 },
    }));
    let active = 0;
    let peak = 0;
    const timeouts: number[] = [];
    const attempts = new Map<string, number>();
    const scheduler = createToolScheduler(registry, async function execute(request, options) {
      timeouts.push(options?.timeoutMs ?? 0);
      const attempt = (attempts.get(request.callId) ?? 0) + 1;
      attempts.set(request.callId, attempt);
      if (request.callId === "retry" && attempt === 1) {
        return { status: "error", callId: request.callId, toolName: request.toolName, error: { code: "TOOL_EXECUTION_FAILED", message: "transient" }, meta: { durationMs: 0, inputHash: "test" } };
      }
      active++;
      peak = Math.max(peak, active);
      await wait(15);
      active--;
      return success(request.callId, request.toolName);
    });

    const results = await scheduler.executeCalls([
      { id: "retry", name: "metadata_probe", input: { group: "shared", timeoutMs: 500 } },
      { id: "second", name: "metadata_probe", input: { group: "shared" } },
      { id: "third", name: "metadata_probe", input: { group: "shared" } },
    ], { maxRetries: 5 });

    expect(results.map((result) => result.call.id)).toEqual(["retry", "second", "third"]);
    expect(results[0].retryCount).toBe(1);
    expect(attempts.get("retry")).toBe(2);
    expect(peak).toBe(2);
    expect(timeouts).toContain(50);
    expect(timeouts).toContain(25);
  });

  it("Kernel 按新工具的 effect metadata 并发，不维护工具名称名单", async function groupsKernelCallsByMetadata() {
    let active = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    registry.register(createProbeTool(
      { effect: "none", destructive: false, concurrency: { max: 2, resourceKey: "kernel:probe" }, retry: { safe: false } },
      async function execute(input) {
        active++;
        peak = Math.max(peak, active);
        await wait(15);
        active--;
        return { group: input.group };
      },
    ));
    let sampleCount = 0;
    const kernel = createAgentKernel({
      turnId: "metadata-kernel",
      messages: [createAgentTextMessage("user", "test")],
      toolRegistry: registry,
      permissionContext: { mode: "auto_approve" },
      modelSampler: {
        async sample() {
          sampleCount++;
          if (sampleCount === 1) {
            return {
              content: "",
              toolCalls: [
                { id: "kernel-one", name: "metadata_probe", input: { group: "one" } },
                { id: "kernel-two", name: "metadata_probe", input: { group: "two" } },
              ],
              reasoningSummary: "",
              finishReason: "tool_calls" as const,
            };
          }
          return { content: "done", toolCalls: [], reasoningSummary: "", finishReason: "stop" as const };
        },
      },
    });

    for await (const _event of kernel.run()) {
      // 消费完整事件流以触发工具调度和下一次采样。
    }
    expect(peak).toBe(2);
  });
});
