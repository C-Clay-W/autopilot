/**
 * runtime/contract-test/turn-usage.contract.test.ts
 *
 * 审计缺口 2.3：turns.getTurnUsageSummary() 只读查询与 context_usage_updated 附带 turnUsage 的契约——
 * 累计输入/输出/总量与执行段耗时全部来自私有 runtimeBudget 同一累计点；
 * 分项不完整或旧 checkpoint 缺少分项时整对降级为总量；非法 DTO fail closed 为 null。
 */
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../public";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentTextMessage } from "../../internal/types/agent-message";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { buildTurnUsageSummary, projectPublicTurnUsageSummary } from "../../internal/kernel/turn-usage";

/** 将 Runtime 事件流收集为数组，保留真实 turn-service/execution-coordinator 装配。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造按次数返回不同 usage 的终态采样器：首采样发起只读工具调用以形成多步累计。 */
function createStepwiseSampler(): ModelSampler {
  let calls = 0;
  return {
    async sample() {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call-read", name: "read_file", input: { path: "package.json", limit: 5 } }],
          reasoningSummary: "读取文件",
          finishReason: "tool_calls",
          usage: { inputTokens: 100, outputTokens: 5, contextTokens: 105 },
        };
      }
      return {
        content: "已完成。",
        toolCalls: [],
        reasoningSummary: "完成",
        finishReason: "stop",
        usage: { inputTokens: 130, outputTokens: 8, contextTokens: 138 },
      };
    },
  };
}

describe("turns.getTurnUsageSummary contract", () => {
  it("累计输入/输出/总量跨多次采样求和，事件携带同一份 turnUsage 白名单投影", async function accumulatesAcrossSamples() {
    const ports = createMemoryPorts();
    const sessionId = "turn-usage-accumulate";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "deepseek-flash" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: createStepwiseSampler(),
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "统计本轮用量" }));
    const summary = await runtime.turns.getTurnUsageSummary({ sessionId });

    // 两次成功采样：100+130 输入、5+8 输出、105+138 总量。
    expect(summary).toMatchObject({ turnId: expect.any(String), inputTokens: 230, outputTokens: 13, totalTokens: 243 });
    expect(summary!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(summary!).sort()).toEqual(["elapsedMs", "inputTokens", "outputTokens", "totalTokens", "turnId"]);

    // 事件与查询消费同一份安全快照：终态事件流中最后一次 usage 事件必须带 turnUsage。
    const usageEvents = events.filter(function isUsageEvent(event): event is Extract<AgentLoopEvent, { type: "context_usage_updated" }> {
      return event.type === "context_usage_updated";
    });
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(usageEvents.at(-1)!.turnUsage).toMatchObject({ inputTokens: 230, outputTokens: 13, totalTokens: 243 });
    expect(await runtime.turns.getTurnUsageSummary({ sessionId, turnId: "other-turn" })).toBeNull();
  });

  it("旧 checkpoint 缺少分项或分项求和异常时整对降级为总量，不拼凑部分分项", async function degradesIncompleteSplit() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    await ports.checkpointStore.save("legacy", {
      turnId: "t-legacy",
      status: "completed",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "旧快照")],
      completedCallIds: [],
      runtimeBudget: { startedAt: 1_000, totalTokens: 500, executionSegmentVersion: 1 },
    });
    await ports.checkpointStore.save("torn", {
      turnId: "t-torn",
      status: "completed",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "分项不完整")],
      completedCallIds: [],
      runtimeBudget: { startedAt: 1_000, totalTokens: 500, inputTokens: 400, outputTokens: 90, executionSegmentVersion: 1 },
    });
    await ports.checkpointStore.save("timed", {
      turnId: "t-timed",
      status: "completed",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "带耗时")],
      completedCallIds: [],
      runtimeBudget: { startedAt: 1_000, totalTokens: 500, inputTokens: 300, outputTokens: 200, updatedAt: 6_500, executionSegmentVersion: 1 },
    });

    expect(await runtime.turns.getTurnUsageSummary({ sessionId: "legacy" })).toEqual({ turnId: "t-legacy", totalTokens: 500, elapsedMs: 0 });
    expect(await runtime.turns.getTurnUsageSummary({ sessionId: "torn" })).toEqual({ turnId: "t-torn", totalTokens: 500, elapsedMs: 0 });
    expect(await runtime.turns.getTurnUsageSummary({ sessionId: "timed" })).toEqual({ turnId: "t-timed", inputTokens: 300, outputTokens: 200, totalTokens: 500, elapsedMs: 5_500 });
    expect(await runtime.turns.getTurnUsageSummary({ sessionId: "missing" })).toBeNull();
  });

  it("被篡改的 runtimeBudget 与手工构造的非法投影 fail closed，不产生伪数值", function failsClosedOnTamperedBudget() {
    expect(buildTurnUsageSummary({ turnId: "t", runtimeBudget: { startedAt: 1, totalTokens: -1 } })).toBeNull();
    expect(buildTurnUsageSummary({ turnId: "t", runtimeBudget: { startedAt: 1, totalTokens: 10.5 } })).toBeNull();
    expect(buildTurnUsageSummary({ turnId: "t", runtimeBudget: undefined })).toBeNull();

    // 投影层丢弃多余字段，非法分项/缺失 turnId 时返回 null。
    expect(projectPublicTurnUsageSummary({ turnId: "t", totalTokens: 10, elapsedMs: 5, intruder: true } as never)).toEqual({ turnId: "t", totalTokens: 10, elapsedMs: 5 });
    expect(projectPublicTurnUsageSummary({ turnId: "t", inputTokens: 10, totalTokens: 10, elapsedMs: 5 })).toBeNull();
    expect(projectPublicTurnUsageSummary({ turnId: "", totalTokens: 10, elapsedMs: 5 })).toBeNull();
    expect(projectPublicTurnUsageSummary(null)).toBeNull();
  });
});