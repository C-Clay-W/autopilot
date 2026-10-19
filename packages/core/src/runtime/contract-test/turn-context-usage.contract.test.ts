/**
 * runtime/contract-test/turn-context-usage.contract.test.ts
 *
 * Talk-Plan0828 Stage 2：turns.getContextUsage() 只读查询契约——
 * 只投影最新私有 checkpoint 的安全快照，非法 DTO fail closed 为 null，不暴露私有 anchor。
 */
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../public";
import { createMemoryPorts } from "../adapters/memory";
import { projectContextUsage } from "../../internal/kernel/context-budget";
import { createAgentTextMessage } from "../../internal/types/agent-message";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";

/** 将 Runtime 事件流收集为数组，保留真实 turn-service/execution-coordinator 装配。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造不依赖网络或真实 Provider 的终态采样器。 */
function createMockSampler(): ModelSampler {
  return {
    async sample() {
      return { content: "已完成。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
    },
  };
}

/** 构造一份通过运行时断言的安全投影。 */
function buildUsage() {
  return projectContextUsage({
    messages: [createAgentTextMessage("user", "请简短确认。")],
    tools: [],
    contextWindowTokens: 100_000,
    outputReserveTokens: 8_192,
    compactTriggerTokens: 80_000,
    modelRef: "openai/gpt-test",
  })!;
}

describe("turns.getContextUsage contract", () => {
  it("返回最新 checkpoint 的白名单投影并丢弃多余字段", async () => {
    const ports = createMemoryPorts();
    const usage = buildUsage();
    await ports.checkpointStore.save("s1", {
      turnId: "t1",
      status: "completed",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "请简短确认。")],
      completedCallIds: [],
      contextUsage: { ...usage, intruder: true } as typeof usage,
    });
    const runtime = createAgentRuntime({ ports });

    const result = await runtime.turns.getContextUsage({ sessionId: "s1" });

    expect(result).not.toBeNull();
    expect(result).toEqual(usage);
    expect("intruder" in result!).toBe(false);
  });

  it("无 checkpoint、turnId 不匹配或 DTO 被篡改时 fail closed 为 null", async () => {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    expect(await runtime.turns.getContextUsage({ sessionId: "empty" })).toBeNull();

    const usage = buildUsage();
    await ports.checkpointStore.save("s2", {
      turnId: "t2",
      status: "completed",
      stepCount: 1,
      messages: [],
      completedCallIds: [],
      contextUsage: { ...usage, currentContextTokens: usage.currentContextTokens + 3 } as typeof usage,
    });
    expect(await runtime.turns.getContextUsage({ sessionId: "s2", turnId: "other-turn" })).toBeNull();
    expect(await runtime.turns.getContextUsage({ sessionId: "s2", turnId: "t2" })).toBeNull();
  });

  it("生产装配将 firstParty/deepseek-flash 冻结为目录窗口并生成事件与查询投影", async function projectsUsageFromTrustedProviderFreeze() {
    const ports = createMemoryPorts();
    const sessionId = "context-usage-production-freeze";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "deepseek-flash" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: createMockSampler(),
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "查询上下文用量" }));
    const turn = await ports.turnStore.getLatest(sessionId);
    const usageEvent = events.find(function findContextUsage(event) { return event.type === "context_usage_updated"; });
    const usage = await runtime.turns.getContextUsage({ sessionId });

    expect(turn?.frozenProviderConfig?.contextWindowTokens).toBe(1_000_000);
    expect(usageEvent?.type === "context_usage_updated" && usageEvent.usage?.contextWindowTokens).toBe(1_000_000);
    expect(usage).toMatchObject({ modelRef: "firstParty/deepseek-flash", contextWindowTokens: 1_000_000 });
  });

  it("未知 firstParty ModelRef 不推测窗口，生产查询保持 unknown", async function doesNotGuessUnknownProviderWindow() {
    const ports = createMemoryPorts();
    const sessionId = "context-usage-unknown-provider-freeze";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "unlisted-model" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: createMockSampler(),
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "未知窗口" }));
    const turn = await ports.turnStore.getLatest(sessionId);

    expect(turn?.frozenProviderConfig?.contextWindowTokens).toBeUndefined();
    expect(await runtime.turns.getContextUsage({ sessionId })).toBeNull();
  });
});
