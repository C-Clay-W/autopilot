/** r001 定向回归：逐条工具结果更新 Context，并隔离过程正文与最终答复。 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLoopEvent } from "../agent-runtime";
import type { AgentSampleResult } from "../lib/llm";
import { ToolRegistry } from "../tools/tool-registry";
import { createAgentTextMessage, validateAgentMessages, type AgentMessage } from "../types/agent-message";
import { createAgentKernel } from "./agent-kernel";
import type { ModelSampler } from "./model-sampler";
import { createChatToolRuntime } from "../tools/chat-tool-runtime";
import { estimateMessageTokens } from "./compact";

/** 创建输出长度可控的只读工具，确保两条 canonical 结果产生不同投影。 */
function createContextProbeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "context_probe",
    description: "用于 Context 计量回归测试的确定性工具。",
    inputSchema: z.object({ text: z.string() }),
    metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
    createActionFacts: function createActionFacts() {
      return { toolName: "context_probe", effect: "none", destructive: false, operation: "test" };
    },
    async execute(input) {
      return { text: input.text };
    },
    serializeOutput: function serializeOutput(output) {
      return output;
    },
  });
  return registry;
}

describe("Core Context 工具结果回归", function contextToolResultSuite() {
  it.each([false, true])("快工具完成时不等待门控慢工具才发布结果与 Context（慢工具在前=%s）", async function publishesBeforeSlowToolCompletes(slowFirst) {
    let releaseSlow!: () => void;
    let notifyFast!: () => void;
    const slowGate = new Promise<void>(function gate(resolve) { releaseSlow = resolve; });
    const fastSerialized = new Promise<void>(function notify(resolve) { notifyFast = resolve; });
    const registry = new ToolRegistry();
    registry.register({
      name: "gated_probe", description: "确定性并发完成时序测试。",
      inputSchema: z.object({ slow: z.boolean() }),
      metadata: { effect: "none", destructive: false, concurrency: { max: 2 }, retry: { safe: false } },
      createActionFacts: function facts() { return { toolName: "gated_probe", effect: "none", destructive: false, operation: "test" }; },
      execute: async function execute(input) { if (input.slow) await slowGate; return { slow: input.slow, text: "结果".repeat(input.slow ? 120 : 60) }; },
      serializeOutput: function serialize(output) { if (!output.slow) notifyFast(); return output; },
    });
    let sampled = false;
    const callOrder = slowFirst ? ["slow", "fast"] : ["fast", "slow"];
    let continuationMessages: AgentMessage[] = [];
    const checkpoints: AgentMessage[][] = [];
    const kernel = createAgentKernel({
      turnId: "gated-context-r001", messages: [createAgentTextMessage("user", "并发查询。")],
      toolRegistry: registry, permissionContext: { mode: "auto_approve" },
      contextUsageProjection: { modelRef: "openai/context-test", contextWindowTokens: 200_000, outputReserveTokens: 8_192, compactTriggerTokens: 160_000 },
      ...(slowFirst ? { initialContextContributions: [[{ kind: "conversation" as const, weight: 20 }]] } : {}),
      onSafeToolBatch: function checkpoint(value) { checkpoints.push(value.messages); },
      modelSampler: { sample: async function sample(messages) {
        if (sampled) { continuationMessages = [...messages]; return { content: "完成", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" }; }
        sampled = true;
        return { content: "", toolCalls: callOrder.map(function createCall(id) { return { id, name: "gated_probe", input: { slow: id === "slow" } }; }), reasoningSummary: "查询", finishReason: "tool-call", usage: { inputTokens: 20, outputTokens: 5, contextTokens: 30 } };
      } },
    });
    const events: AgentLoopEvent[] = [];
    // 独立消费事件，序列化通知后跨一个队列屏障，确保快工具终态微任务已排空。
    const consuming = (async function consume() { for await (const event of kernel.run()) events.push(event); })();
    let beforeRelease: AgentLoopEvent[];
    try {
      await Promise.race([fastSerialized, consuming.then(function prematureEnd() { throw new Error(`工具执行前结束: ${JSON.stringify(events.map(function summarize(event) { return event.type === "tool_result" ? { type: event.type, result: event.result } : { type: event.type }; }))}`); })]);
      await new Promise<void>(function drain(resolve) { setImmediate(resolve); });
      beforeRelease = [...events];
      expect(checkpoints).toHaveLength(0);
    } finally {
      releaseSlow();
      await consuming;
    }
    expect(events.filter(function result(event) { return event.type === "tool_result"; }).map(function id(event) { return event.type === "tool_result" ? event.callId : ""; })).toEqual(["fast", "slow"]);
    expect(beforeRelease!.filter(function result(event) { return event.type === "tool_result"; })).toHaveLength(1);
    expect(beforeRelease!.filter(function usage(event) { return event.type === "context_usage_updated" && event.usage?.measurement === "projected"; })).toHaveLength(1);
    const canonicalIds = continuationMessages.flatMap(function resultIds(message) { return message.content.flatMap(function blockId(block) { return block.type === "tool-result" ? [block.toolCallId] : []; }); });
    expect(canonicalIds).toEqual(callOrder);
    expect(checkpoints).toHaveLength(1);
    expect(function validate() { validateAgentMessages(checkpoints[0]); }).not.toThrow();
    expect(checkpoints[0].flatMap(function resultIds(message) { return message.content.flatMap(function blockId(block) { return block.type === "tool-result" ? [block.toolCallId] : []; }); })).toEqual(callOrder);
    const finalResultIndex = events.findIndex(function slowResult(event) { return event.type === "tool_result" && event.callId === "slow"; });
    const usage = events.slice(0, finalResultIndex + 1).flatMap(function projected(event) { return event.type === "context_usage_updated" && event.usage?.measurement === "projected" ? [event.usage] : []; });
    expect(usage).toHaveLength(2);
    expect(usage[1].currentContextTokens).toBeGreaterThan(usage[0].currentContextTokens);
    expect(usage[1].providerMeasuredTokens).toBe(30);
    expect(usage[1].currentContextTokens).toBe(30 + estimateMessageTokens(continuationMessages.slice(2)));
  });

  it("Chat RAG 的未校验工具前正文不进入过程或最终展示", async function keepsUnverifiedRagTextPrivate() {
    let sampleIndex = 0;
    const sampler: ModelSampler = {
      async sample(_messages, _tools, _options, onDelta) {
        sampleIndex += 1;
        if (sampleIndex === 1) {
          onDelta?.("未验证正文");
          return { content: "未验证正文全文", toolCalls: [{ id: "rag-probe", name: "context_probe", input: { text: "只读" } }], reasoningSummary: "内部查找", finishReason: "tool-call" };
        }
        return { content: "无证据的模型原文", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };
    const kernel = createAgentKernel({
      turnId: "rag-process-isolation",
      messages: [createAgentTextMessage("user", "只依据知识证据回答。")],
      toolRegistry: createContextProbeRegistry(), permissionContext: { mode: "auto_approve" }, modelSampler: sampler,
      chat: createChatToolRuntime({ sessionId: "rag-session", turnId: "rag-process-isolation", retrievalMode: "rag" }, undefined, [], function now() { return 0; }),
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const displayed = events.flatMap(function visible(event) { return event.type === "answer_delta" || event.type === "reasoning_summary" ? [event.type === "answer_delta" ? event.delta : event.summary] : []; }).join(" ");
    expect(displayed).not.toContain("未验证正文");
    expect(displayed).not.toContain("无证据的模型原文");
    expect(events.filter(function reset(event) { return event.type === "answer_reset"; })).toHaveLength(0);
  });

  it.each([
    { name: "部分", deltas: ["工具前的"] },
    { name: "完整", deltas: ["工具前的", "公开进度。"] },
  ])("$name delta 回调只补未流出尾段，过程与最终答复各一次", async function deduplicatesStreamedProcess({ deltas }) {
    let sampleIndex = 0;
    const sampler: ModelSampler = {
      async sample(_messages, _tools, _options, onDelta) {
        sampleIndex += 1;
        if (sampleIndex === 1) {
          for (const delta of deltas) onDelta?.(delta);
          return {
            content: "工具前的公开进度。",
            toolCalls: [{ id: "streamed-tool", name: "context_probe", input: { text: "只读" } }],
            reasoningSummary: "查找中",
            reasoningContent: "内部推理不展示",
            finishReason: "tool-call",
          };
        }
        return { content: "最终答复。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };
    const kernel = createAgentKernel({
      turnId: `streamed-process-${deltas.length}`,
      messages: [createAgentTextMessage("user", "检查公开进度。")],
      toolRegistry: createContextProbeRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const deltasSeen = events.flatMap(function answerDelta(event) { return event.type === "answer_delta" ? [event.delta] : []; });
    expect(deltasSeen.join("")).toBe("工具前的公开进度。最终答复。");
    expect(deltasSeen.join("")).not.toContain("内部推理");
    expect(events.filter(function reset(event) { return event.type === "answer_reset"; })).toHaveLength(1);
    expect(events.findIndex(function reset(event) { return event.type === "answer_reset"; })).toBeLessThan(events.findIndex(function result(event) { return event.type === "tool_result"; }));
    const completed = events.find(function isCompleted(event) { return event.type === "turn_completed"; });
    expect(completed?.type === "turn_completed" ? completed.checkpoint.messages.at(-1) : undefined).toEqual(createAgentTextMessage("assistant", "最终答复。"));
  });

  it("逐条重算并去重 Context，归档工具前正文且保留最终答复", async function refreshesForEachCanonicalToolResult() {
    const samples: AgentSampleResult[] = [
      {
        content: "工具前的公开进度。",
        toolCalls: [
          { id: "result-short", name: "context_probe", input: { text: "短结果" } },
          { id: "result-long", name: "context_probe", input: { text: "长结果".repeat(160) } },
        ],
        reasoningSummary: "准备查询结果",
        reasoningContent: "只用于内部续接的推理。",
        finishReason: "tool-call",
        usage: { inputTokens: 20, outputTokens: 5, contextTokens: 30 },
      },
      {
        content: "最终答复。",
        toolCalls: [],
        reasoningSummary: "完成",
        finishReason: "stop",
        usage: { inputTokens: 35, outputTokens: 4, contextTokens: 40 },
      },
    ];
    let sampleIndex = 0;
    const sampler: ModelSampler = {
      async sample() {
        const sample = samples[sampleIndex];
        sampleIndex += 1;
        if (!sample) throw new Error("unexpected extra sample");
        return sample;
      },
    };
    const events: AgentLoopEvent[] = [];
    const kernel = createAgentKernel({
      turnId: "context-tool-results-r001",
      messages: [createAgentTextMessage("user", "检查两条工具结果。")],
      toolRegistry: createContextProbeRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      contextUsageProjection: { modelRef: "openai/context-test", contextWindowTokens: 200_000, outputReserveTokens: 8_192, compactTriggerTokens: 160_000 },
      initialContextContributions: [[{ kind: "conversation", weight: 41 }]],
    });

    for await (const event of kernel.run()) events.push(event);

    const usageEvents = events.filter(function isUsageEvent(event): event is Extract<AgentLoopEvent, { type: "context_usage_updated" }> {
      return event.type === "context_usage_updated";
    });
    const usageMeasurements = usageEvents.map(function getMeasurement(event) { return event.usage?.measurement ?? "null"; });
    expect(usageMeasurements).toEqual(["estimated", "measured", "projected", "projected", "measured"]);
    // 初始化与 before_sample 的同值 estimated 投影只发布一次；两次工具结果各产生一个新投影。
    expect(usageEvents.filter(function isEstimated(event) { return event.usage?.measurement === "estimated"; })).toHaveLength(1);

    const projected = usageEvents.flatMap(function getProjectedUsage(event) {
      return event.usage?.measurement === "projected" ? [event.usage] : [];
    });
    expect(projected).toHaveLength(2);
    expect(projected[0]?.providerMeasuredTokens).toBe(30);
    expect(projected[1]?.providerMeasuredTokens).toBe(30);
    expect(projected[1]!.currentContextTokens).toBeGreaterThan(projected[0]!.currentContextTokens);
    const measured = usageEvents.flatMap(function getMeasuredUsage(event) {
      return event.usage?.measurement === "measured" ? [event.usage] : [];
    });
    expect(measured.map(function measuredTokens(usage) { return usage.providerMeasuredTokens; })).toEqual([30, 40]);

    const resultEvents = events.filter(function isToolResult(event): event is Extract<AgentLoopEvent, { type: "tool_result" }> {
      return event.type === "tool_result";
    });
    expect(resultEvents.map(function getCallId(event) { return event.callId; })).toEqual(["result-short", "result-long"]);
    const accountingOrder = events.flatMap(function summarizeAccountingEvent(event) {
      if (event.type === "context_usage_updated") return [`context:${event.usage?.measurement ?? "null"}`];
      if (event.type === "tool_result") return [`tool:${event.callId}`];
      return [];
    });
    expect(accountingOrder).toEqual([
      "context:estimated",
      "context:measured",
      "context:projected",
      "tool:result-short",
      "context:projected",
      "tool:result-long",
      "context:measured",
    ]);

    const answerDeltas = events.filter(function isAnswerDelta(event): event is Extract<AgentLoopEvent, { type: "answer_delta" }> {
      return event.type === "answer_delta";
    });
    expect(answerDeltas.map(function getDelta(event) { return event.delta; })).toEqual(["工具前的公开进度。", "最终答复。"]);
    const processResetIndex = events.findIndex(function isAnswerReset(event) { return event.type === "answer_reset"; });
    const firstResultIndex = events.findIndex(function isFirstResult(event) { return event.type === "tool_result" && event.callId === "result-short"; });
    const finalAnswerIndex = events.findIndex(function isFinalAnswer(event) { return event.type === "answer_delta" && event.delta === "最终答复。"; });
    const lastResultIndex = events.findIndex(function isLastResult(event) { return event.type === "tool_result" && event.callId === "result-long"; });
    expect(processResetIndex).toBeGreaterThan(-1);
    expect(processResetIndex).toBeLessThan(firstResultIndex);
    expect(finalAnswerIndex).toBeGreaterThan(lastResultIndex);
    expect(events.filter(function isReset(event) { return event.type === "answer_reset"; })).toHaveLength(1);

    const completed = events.find(function isCompleted(event) {
      return event.type === "turn_completed";
    });
    expect(completed?.type === "turn_completed" ? completed.checkpoint.messages.at(-1) : undefined).toEqual(createAgentTextMessage("assistant", "最终答复。"));
  });
});
