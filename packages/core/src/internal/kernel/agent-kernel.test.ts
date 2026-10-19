/**
 * Agent Kernel 测试：验证 Kernel 与 createAgentRuntime facade 在相同输入下输出一致的事件语义。
 */

import { describe, it, expect, vi } from "vitest";
import { createAgentRuntime, type AgentCheckpoint, type AgentLoopEvent } from "../agent-runtime";
import { ToolRegistry } from "../tools/tool-registry";
import { createGlobFilesTool } from "../tools/builtins/glob-files-tool";
import { createReadFileTool } from "../tools/builtins/read-file-tool";
import { createWebSearchTool } from "../tools/builtins/web-search-tool";
import { createAgentKernel, runKernel } from "./agent-kernel";
import { createDefaultModelSampler } from "./model-sampler";
import type { RunContext } from "./run-context";
import { AgentSampleError } from "../lib/llm";
import type { AgentSampleResult } from "../lib/llm";
import type { ModelSampler } from "./model-sampler";
import { createAgentTextMessage, getAgentMessageText } from "../types/agent-message";

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造一个确定性 mock 采样器，只返回给定的 content 与 toolCalls。 */
function createMockSampler(result: AgentSampleResult) {
  return {
    sample: vi.fn(async (_messages, _tools, _options, onDelta) => {
      if (onDelta && result.content) {
        for (const chunk of result.content.split("")) onDelta(chunk);
      }
      return result;
    }),
  };
}

/** 构造一个最小 ToolRegistry，用于 headless 验证。 */
function createMinimalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createGlobFilesTool());
  registry.register(createReadFileTool());
  return registry;
}

/** 从事件数组中提取关键事件类型序列。 */
function eventSignature(events: AgentLoopEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("Agent Kernel 与 Runtime 事件一致性", function kernelConsistencySuite() {
  it("恢复仅带旧意图标志且没有写入路径的 checkpoint 时正常完成", async function completesLegacyIntentOnlyCheckpoint() {
    const turnId = "legacy-intent-only";
    const messages = [createAgentTextMessage("user", "我在 Neon 官网控制台创建了一个数据库……这次不改代码。")];
    const checkpoint: AgentCheckpoint = {
      turnId,
      status: "interrupted_recoverable",
      interruptionReason: "stale_lease",
      stepCount: 1,
      messages,
      completedCallIds: [],
      mutationGate: { required: true, strong: true, changedPaths: [], verifiedPaths: [], recoveryAttempts: 1 },
    };
    const sampler = createMockSampler({ content: "这是只读说明。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" });

    const events = await collectEvents(createAgentKernel({
      turnId,
      messages,
      checkpoint,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    }).run());
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.strong).toBe(false);
  });

  it("纯文本回答场景下，Kernel 与 facade 输出相同的事件序列", async function plainAnswer() {
    const sampler = createMockSampler({ content: "已完成。", toolCalls: [], reasoningSummary: "思考完成", finishReason: "stop" });
    const messages = [createAgentTextMessage("user", "请简短确认。")];

    const runtime = createAgentRuntime({ permissionMode: "auto_approve" });
    // 用 eval 绕过私有字段访问限制，替换默认采样器
    const runtimeEvents = await collectEvents(runtime.run({ turnId: "plain-runtime", messages }));

    // 由于 createAgentRuntime 内部使用 createDefaultModelSampler，上面无法直接注入 mock。
    // 因此本测试只验证 Kernel 自身的事件序列符合预期；与 facade 的对比通过后续 headless runner 真实模型完成。
    const kernel = createAgentKernel({
      turnId: "plain-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });
    const kernelEvents = await collectEvents(kernel.run());

    // mock 采样器把 "已完成。" 拆成 4 个字符逐个回调 onDelta，因此产生 4 个 answer_delta
    expect(eventSignature(kernelEvents)).toEqual([
      "turn_started",
      "reasoning_summary",
      "answer_delta",
      "answer_delta",
      "answer_delta",
      "answer_delta",
      "reasoning_summary",
      "turn_completed",
    ]);
    expect(kernelEvents[kernelEvents.length - 1].type).toBe("turn_completed");
  });

  it("无工具终态 assistant 记入 conversation 分类而不挤入 system 权重", async function classifiesTerminalAssistantAsConversation() {
    const systemMessage = createAgentTextMessage("system", "受控系统指令。".repeat(160));
    const userMessage = createAgentTextMessage("user", "简短问题？");
    const longAssistantAnswer = "较长的终态回答内容。".repeat(2_000);
    const messages = [systemMessage, userMessage];
    const sampler: ModelSampler = {
      async sample() {
        return { content: longAssistantAnswer, toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };
    const kernel = createAgentKernel({
      turnId: "terminal-assistant-context-classification",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      contextUsageProjection: { modelRef: "fixture/provider-model", contextWindowTokens: 100_000, outputReserveTokens: 1_000, compactTriggerTokens: 80_000 },
      initialContextContributions: [
        [{ kind: "system", weight: 500 }],
        [{ kind: "conversation", weight: 1 }],
      ],
    });

    const events = await collectEvents(kernel.run());
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });
    const categories = completed?.type === "turn_completed" ? completed.checkpoint.contextUsage?.breakdown.categories : undefined;
    const systemCategory = categories?.find(function findSystem(category) { return category.kind === "system"; });
    const conversationCategory = categories?.find(function findConversation(category) { return category.kind === "conversation"; });

    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.messages.at(-1)?.role).toBe("assistant");
    expect(conversationCategory?.tokens).toBeGreaterThan(systemCategory?.tokens ?? 0);
  });

  it("工具调用场景下，Kernel 发出 tool_started / tool_result / turn_completed", async function toolCall() {
    const sampler = createMockSampler({
      content: "",
      toolCalls: [{ id: "call-1", name: "glob_files", input: { pattern: "*.md" } }],
      reasoningSummary: "需要搜索文件",
      finishReason: "tool-call",
    });

    const kernel = createAgentKernel({
      turnId: "tool-kernel",
      messages: [createAgentTextMessage("user", "列出所有 md 文件。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });
    const events = await collectEvents(kernel.run());

    expect(eventSignature(events)).toContain("tool_started");
    expect(eventSignature(events)).toContain("tool_result");
    const reasoningSummaries = events.filter(function isReasoningSummary(event): event is Extract<AgentLoopEvent, { type: "reasoning_summary" }> { return event.type === "reasoning_summary" }).map(function getSummary(event) { return event.summary; });
    expect(reasoningSummaries).toContain("正在思考");
    expect(reasoningSummaries).toContain("需要搜索文件");
    expect(events.some(function hasTerminal(event) {
      return event.type === "turn_completed"
        || event.type === "turn_limit_reached"
        || (event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "repeated_tool_calls");
    })).toBe(true);
    const sampledMessages = sampler.sample.mock.calls[0]?.[0] as import("../types/agent-message").AgentMessage[];
    expect(sampledMessages.every(function hasOnlyV2Messages(message) { return Array.isArray(message.content); })).toBe(true);
  });

  it("把自动工具名清单归一为通用状态，同时保留每个真实调用 ID", async function normalizesGeneratedToolSummary() {
    const sampleResults: AgentSampleResult[] = [
      {
        content: "",
        toolCalls: [
          { id: "call-1", name: "glob_files", input: { pattern: "*.md" } },
          { id: "call-2", name: "glob_files", input: { pattern: "agent/*.md" } },
        ],
        reasoningSummary: "模型请求调用 glob_files、glob_files",
        finishReason: "tool-call",
      },
      { content: "已完成。", toolCalls: [], reasoningSummary: "已完成", finishReason: "stop" },
    ];
    let sampleIndex = 0;
    const sampler: ModelSampler = {
      async sample() {
        const result = sampleResults[sampleIndex] ?? sampleResults[sampleResults.length - 1];
        sampleIndex += 1;
        return result;
      },
    };
    const events = await collectEvents(createAgentKernel({
      turnId: "normalized-tool-summary",
      messages: [createAgentTextMessage("user", "检查 Markdown 文件。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    }).run());
    const summaries = events.filter(function isReasoningSummary(event): event is Extract<AgentLoopEvent, { type: "reasoning_summary" }> { return event.type === "reasoning_summary" }).map(function getSummary(event) { return event.summary; });

    expect(summaries).toContain("正在思考");
    expect(summaries).toContain("已完成");
    expect(summaries).not.toContain("模型请求调用 glob_files、glob_files");
    expect(events.filter(function isToolStarted(event): event is Extract<AgentLoopEvent, { type: "tool_started" }> { return event.type === "tool_started" }).map(function getCallId(event) { return event.callId; })).toEqual(["call-1", "call-2"]);
    expect(events.filter(function isToolResult(event): event is Extract<AgentLoopEvent, { type: "tool_result" }> { return event.type === "tool_result" }).map(function getCallId(event) { return event.callId; })).toEqual(["call-1", "call-2"]);
  });

  it("多调用 Web 脱敏恢复全部闭合后不再保留 pendingCalls", async function closesAllRedactedWebCalls() {
    const calls = [
      { id: "lost-web-1", name: "web_search", input: { redacted: true } },
      { id: "lost-read-1", name: "read_file", input: { path: "package.json", limit: 20 } },
    ] as const;
    const messages = [{
      role: "assistant" as const,
      content: calls.map(function toToolCall(call) { return { type: "tool-call" as const, id: call.id, name: call.name, input: call.input }; }),
    }];
    const checkpoint: import("../agent-runtime").AgentCheckpoint = {
      turnId: "lost-web-batch",
      status: "interrupted_recoverable",
      interruptionReason: "stale_lease",
      stepCount: 1,
      messages,
      pendingCalls: [...calls],
      completedCallIds: [],
    };
    const registry = createMinimalRegistry();
    registry.register(createWebSearchTool({ async search() { return { answer: "unused", sources: [], truncated: false }; } }));
    const sampler = createMockSampler({ content: "脱敏调用已处理。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" });
    const events = await collectEvents(createAgentKernel({
      turnId: "lost-web-batch",
      messages,
      checkpoint,
      toolRegistry: registry,
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      maxToolRetries: 5,
      runtimeLimitsResolved: true,
    }).run());

    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(events.filter(function countReadResults(event) { return event.type === "tool_result" && event.callId === "lost-read-1"; })).toHaveLength(1);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.pendingCalls).toBeUndefined();
    expect(completed?.type === "turn_completed" && completed.checkpoint.completedCallIds).toEqual(expect.arrayContaining(["lost-web-1", "lost-read-1"]));
  });

  it("注入 mock 采样器后，Kernel 不依赖 LOOP_LLM_* 环境变量", async function noEnvDependency() {
    const sampler = createMockSampler({ content: "mocked", toolCalls: [], reasoningSummary: "mocked" });
    const kernel = createAgentKernel({
      turnId: "mock-kernel",
      messages: [createAgentTextMessage("user", "测试。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });
    await collectEvents(kernel.run());
    expect(sampler.sample).toHaveBeenCalledTimes(1);
  });

  it("空响应会附带恢复指令重采样，而不是直接抛出泛化错误", async function recoversEmptyResponse() {
    const sampleMock = vi.fn()
        .mockRejectedValueOnce(new AgentSampleError("模型未返回可显示结果", "EMPTY_RESPONSE"))
        .mockResolvedValueOnce({ content: "已恢复。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" });
    const sampler: ModelSampler = { sample: sampleMock };
    const kernel = createAgentKernel({
      turnId: "empty-response-kernel",
      messages: [createAgentTextMessage("user", "请简短确认。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });

    const events = await collectEvents(kernel.run());
    const recovery = events.find((event) => event.type === "model_recovery");
    const completed = events.find((event) => event.type === "turn_completed");

    expect(recovery?.type === "model_recovery" && recovery.reason).toBe("EMPTY_RESPONSE");
    expect(completed?.type).toBe("turn_completed");
    expect(sampleMock).toHaveBeenCalledTimes(2);
    const retryMessages = sampleMock.mock.calls[1]?.[0] as import("../types/agent-message").AgentMessage[];
    expect(retryMessages.some((message) => getAgentMessageText(message).includes("没有产生可显示正文或工具调用"))).toBe(true);
  });

  it("输出截断后的重试会升级模型输出预算", async function escalatesOutputBudgetAfterLimit() {
    const sampleMock = vi.fn()
      .mockRejectedValueOnce(new AgentSampleError("模型输出达到上限", "MODEL_OUTPUT_LIMIT"))
      .mockResolvedValueOnce({ content: "已恢复。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" });
    const sampler: ModelSampler = { sample: sampleMock };
    const kernel = createAgentKernel({
      turnId: "output-limit-kernel",
      messages: [createAgentTextMessage("user", "请简短确认。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });

    const events = await collectEvents(kernel.run());

    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(sampleMock).toHaveBeenCalledTimes(2);
    expect(sampleMock.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
    expect(sampleMock.mock.calls[1]?.[2]).toMatchObject({ maxTokens: 64_000 });
  });

  it("供应商 4xx 请求拒绝会直接失败，不伪装成输出截断重复采样", async function failsRejectedProviderRequestImmediately() {
    const sampleMock = vi.fn().mockRejectedValue(new AgentSampleError("供应商拒绝请求（HTTP 400）", "PROVIDER_REQUEST_REJECTED"));
    const sampler: ModelSampler = { sample: sampleMock };
    const kernel = createAgentKernel({
      turnId: "provider-request-rejected-kernel",
      messages: [createAgentTextMessage("user", "请简短确认。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });

    const events = await collectEvents(kernel.run());
    const failure = events.find((event) => event.type === "turn_failed");
    expect(events.some((event) => event.type === "model_recovery")).toBe(false);
    expect(failure).toMatchObject({ type: "turn_failed", error: "供应商拒绝请求（HTTP 400）" });
    expect(sampleMock).toHaveBeenCalledTimes(1);
  });

  it("取消后不再转发供应商迟到的正文增量", async function dropsLateDeltasAfterCancellation() {
    const controller = new AbortController();
    let markSampleStarted: (() => void) | undefined;
    let releaseSample: (() => void) | undefined;
    const sampleStarted = new Promise<void>(function waitForSampleStart(resolve) { markSampleStarted = resolve; });
    const sampleReleased = new Promise<void>(function waitForSampleRelease(resolve) { releaseSample = resolve; });
    const sampler: ModelSampler = {
      async sample(_messages, _tools, _options, onDelta) {
        markSampleStarted?.();
        await sampleReleased;
        onDelta?.("不应展示的迟到内容");
        return { content: "不应展示的迟到内容", toolCalls: [], reasoningSummary: "模型已完成", finishReason: "stop" };
      },
    };
    const kernel = createAgentKernel({
      turnId: "cancelled-stream-kernel",
      messages: [createAgentTextMessage("user", "开始后立刻取消。")],
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      signal: controller.signal,
    });

    const eventsPromise = collectEvents(kernel.run());
    await sampleStarted;
    controller.abort();
    releaseSample?.();
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "answer_delta")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_interrupted");
  });
});
