/** Step 4：每次采样前自动压缩的受控契约测试，不连接真实 Provider。 */

import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";

/** 收集事件流，验证自动压缩不改变 Turn 生命周期。 */
async function collectEvents(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** 创建可控长度的文本，避免 fixture 依赖真实 Provider。 */
function createText(length: number): string {
  return "x".repeat(length);
}

/** 建立 durable Session。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, id: string): Promise<void> {
  await ports.sessionStore.save({ id, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
}

/** 读取 canonical 消息中的普通文本，供测试识别摘要采样。 */
function getMessageText(message: { content?: Array<{ type: string; text?: string }> } | undefined): string {
  return message?.content?.filter(function isTextBlock(block) { return block.type === "text"; }).map(function readTextBlock(block) { return block.text ?? ""; }).join("") ?? "";
}

describe("Step 4 auto compact", function autoCompactSuite() {
  it("低于、等于、超过阈值时只在达到阈值的 before_sample 自动压缩", async function compactsAtThreshold() {
    const ports = createMemoryPorts();
    const sessionId = "step4-threshold";
    await seedSession(ports, sessionId);
    const sampled: string[][] = [];
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        compactPolicy: { preserveRecentTurns: 1, targetTokens: 550_000 },
        modelSampler: {
          async sample(messages, tools) {
            const isSummary = tools.length === 0 && getMessageText(messages[0]).includes("上下文压缩器");
            if (isSummary) return { content: "摘要", toolCalls: [], reasoningSummary: "summary", finishReason: "stop" };
            sampled.push(messages.map(function collectText(message) { return getMessageText(message); }));
            return { content: "完成", toolCalls: [], reasoningSummary: "answer", finishReason: "stop" };
          },
        },
      },
    });

    const lower = await collectEvents(runtime.turns.start({
      sessionId,
      content: createText(3_100_000),
      runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, providerSettings: { primary: { apiProtocol: "anthropic-messages", compactThresholdTokens: 1_000_000 } } },
    }));
    expect(lower.map((event) => event.type)).not.toContain("context_compacted");

    const atThreshold = await collectEvents(runtime.turns.start({
      sessionId,
      content: createText(500_000),
      runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, providerSettings: { primary: { apiProtocol: "anthropic-messages", compactThresholdTokens: 1_000_000 } } },
    }));
    expect(atThreshold.map((event) => event.type)).toContain("context_compacted");
    expect(sampled.at(-1)?.some((content) => content.includes("已压缩历史摘要"))).toBe(true);
  }, 15_000);

  it("同一 Turn 的工具结果推高压力后，在下一次采样前压缩且不重放工具", async function compactsAfterToolBoundary() {
    const ports = createMemoryPorts();
    const sessionId = "step4-tool-loop";
    await seedSession(ports, sessionId);
    let samples = 0;
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        compactPolicy: { preserveRecentTurns: 1, targetTokens: 550_000 },
        modelSampler: {
          async sample(messages, tools) {
            const isSummary = tools.length === 0 && getMessageText(messages[0]).includes("上下文压缩器");
            if (isSummary) return { content: "工具摘要", toolCalls: [], reasoningSummary: "summary", finishReason: "stop" };
            samples += 1;
            if (samples === 1) return {
              content: "",
              toolCalls: [{ id: "call-1", name: "glob_files", input: { pattern: "*.md" } }],
              reasoningSummary: "tool",
              finishReason: "tool_calls",
              usage: { inputTokens: 799_990, outputTokens: 0, contextTokens: 799_990 },
            };
            return { content: "工具后完成", toolCalls: [], reasoningSummary: "answer", finishReason: "stop" };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({
      sessionId,
      messages: [
        { role: "user", content: [{ type: "text", text: createText(1_000_000) }] },
        { role: "assistant", content: [{ type: "text", text: "旧回合已完成" }] },
        { role: "user", content: [{ type: "text", text: "执行工具后继续" }] },
      ],
      runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, providerSettings: { primary: { apiProtocol: "anthropic-messages", compactThresholdTokens: 1_000_000 } } },
    }));
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_result");
    expect(types).toContain("context_compacted");
    expect(types.indexOf("tool_result")).toBeLessThan(types.indexOf("context_compacted"));
    expect(types).toContain("turn_completed");
    expect(samples).toBe(2);
  });

  it("reactive 只重试一次，第二次 overflow 打开熔断", async function opensCircuitAfterSecondOverflow() {
    const ports = createMemoryPorts();
    const sessionId = "step4-reactive-circuit";
    await seedSession(ports, sessionId);
    let samples = 0;
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        compactPolicy: { preserveRecentTurns: 0, targetTokens: 4_000 },
        modelSampler: {
          async sample(messages, tools) {
            const isSummary = tools.length === 0 && getMessageText(messages[0]).includes("上下文压缩器");
            if (isSummary) return { content: "摘要", toolCalls: [], reasoningSummary: "summary", finishReason: "stop" };
            samples += 1;
            const { AgentSampleError } = await import("../../src/internal/lib/llm");
            throw new AgentSampleError("overflow", "CONTEXT_OVERFLOW");
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "需要熔断", runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" } } }));
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "context_compact_started")).toHaveLength(1);
    expect(types).toContain("context_compact_circuit_open");
    expect(types).toContain("turn_failed");
    expect(samples).toBe(2);
  });
});
