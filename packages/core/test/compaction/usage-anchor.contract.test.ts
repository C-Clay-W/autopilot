/**
 * Step 2 durable usage anchor 与预算器契约测试。
 * 使用 Memory Ports 和受控 sampler 验证恢复、降级与脱敏，不连接真实 Provider。
 */

import { describe, expect, it, vi } from "vitest";
import { calculateContextBudget, estimateContextBudget, getToolSignature } from "../../src/internal/kernel/context-budget";
import { estimateMessageTokens, serializeCanonicalMessagesForSignature } from "../../src/internal/kernel/compact";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import { createAgentTextMessage } from "../../src/internal/types/agent-message";

vi.mock("../../src/internal/lib/llm", async function mockLlm() {
  const actual = await vi.importActual<typeof import("../../src/internal/lib/llm")>("../../src/internal/lib/llm");
  return { ...actual, askLoopLLM: vi.fn().mockResolvedValue("固定摘要") };
});

/** 收集 Runtime 的完整事件流。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 创建 durable Session，确保 checkpoint 会被内存端口保存。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, sessionId: string): Promise<void> {
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
}

describe("Step 2 durable usage anchor", function usageAnchorContractSuite() {
  it("消息估算覆盖 canonical tool-call ID、工具名与对象输入", function estimatesCompleteCanonicalMessageShape() {
    const messages = [{
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, id: "call-required-in-request", name: "read_file", input: { path: "a.ts" } }],
    }];
    const serialized = serializeCanonicalMessagesForSignature(messages);
    expect(serialized).toContain('"id":"call-required-in-request"');
    expect(serialized).toContain('"type":"tool-call"');
    expect(serialized).toContain('"input":{"path":"a.ts"}');
    expect(estimateMessageTokens(messages)).toBeGreaterThan(estimateMessageTokens([createAgentTextMessage("assistant", "")]));
  });

  it("完整响应把 usage anchor 持久化，但公开事件与状态不暴露", async function persistsPrivateUsageAnchor() {
    const ports = createMemoryPorts();
    const sessionId = "usage-anchor-private";
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: {
          async sample() {
            return {
              content: "完成",
              toolCalls: [],
              reasoningSummary: "mock",
              usage: { inputTokens: 80, outputTokens: 20, contextTokens: 100 },
            };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "测试 usage anchor" }));
    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint?.usageAnchor).toMatchObject({ usage: { inputTokens: 80, outputTokens: 20, contextTokens: 100 } });
    expect(JSON.stringify(events)).not.toContain("usageAnchor");
    expect(JSON.stringify(await runtime.turns.getState({ sessionId }))).not.toContain("usageAnchor");
    expect(JSON.stringify(await ports.transcriptStore.getEvents(sessionId))).not.toContain("usageAnchor");
  });

  it("重启恢复后继续保留 usage anchor", async function retainsAnchorAcrossResume() {
    const ports = createMemoryPorts();
    const sessionId = "usage-anchor-resume";
    await seedSession(ports, sessionId);
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId: "usage-anchor-turn",
      status: "interrupted_recoverable",
      stepCount: 0,
      messages: [createAgentTextMessage("user", "继续")],
      completedCallIds: [],
      usageAnchor: {
        usage: { inputTokens: 200, outputTokens: 40, contextTokens: 240 },
        messageCount: 1,
        toolSignature: getToolSignature([]),
      },
    });
    await ports.turnStore.save({
      id: "usage-anchor-turn",
      sessionId,
      status: "interrupted",
      frozenRunConfig: { workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: Date.now(),
    });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: { async sample() { return { content: "恢复完成", toolCalls: [], reasoningSummary: "mock" }; } } } });

    await collectEvents(runtime.turns.continue({ sessionId, turnId: "usage-anchor-turn" }));
    expect((await ports.checkpointStore.getLatest(sessionId))?.usageAnchor).toMatchObject({ usage: { contextTokens: 240 } });
  });

  it("预算器只估算 anchor 后消息，不累计历史 usage", function estimatesOnlyMessagesAfterAnchor() {
    const messages = [
      createAgentTextMessage("system", "system"),
      createAgentTextMessage("user", "old"),
      createAgentTextMessage("assistant", "新增结果前的调用缺失夹具已移除"),
    ];
    const budget = calculateContextBudget({
      turnId: "t", status: "running", stepCount: 0, messages: messages.slice(0, 2), completedCallIds: [],
      usageAnchor: { usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 }, messageCount: 2, toolSignature: getToolSignature([]) },
    }, messages, [], 30);
    expect(budget.source).toBe("provider");
    expect(budget.inputTokens).toBe(120 + estimateMessageTokens(messages.slice(2)));
    expect(budget.totalTokens).toBe(budget.inputTokens + 30);
  });

  it("旧 checkpoint、消息回退或工具 schema 变化时估算完整请求", function fallsBackForInvalidAnchor() {
    const messages = [createAgentTextMessage("user", "完整估算")];
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } }];
    const expected = estimateContextBudget(messages, tools, 20);
    expect(calculateContextBudget(undefined, messages, tools, 20)).toEqual(expected);
    expect(calculateContextBudget({
      turnId: "t", status: "running", stepCount: 0, messages, completedCallIds: [],
      usageAnchor: { usage: { inputTokens: 1, outputTokens: 1, contextTokens: 2 }, messageCount: 9, toolSignature: getToolSignature(tools) },
    }, messages, tools, 20)).toEqual(expected);
    expect(calculateContextBudget({
      turnId: "t", status: "running", stepCount: 0, messages, completedCallIds: [],
      usageAnchor: { usage: { inputTokens: 1, outputTokens: 1, contextTokens: 2 }, messageCount: 1, toolSignature: getToolSignature([]) },
    }, messages, tools, 20)).toEqual(expected);
  });

  it("manual compact 后清除旧 usage anchor", async function clearsAnchorAfterManualCompact() {
    const ports = createMemoryPorts();
    const sessionId = "usage-anchor-manual-compact";
    await seedSession(ports, sessionId);
    await ports.checkpointStore.save(sessionId, {
      turnId: "usage-anchor-compact-turn", status: "completed", stepCount: 1,
      messages: [createAgentTextMessage("user", "旧内容")], completedCallIds: [],
      usageAnchor: { usage: { inputTokens: 50, outputTokens: 10, contextTokens: 60 }, messageCount: 1, toolSignature: getToolSignature([]) },
    });
    await ports.turnStore.save({ id: "usage-anchor-compact-turn", sessionId, status: "completed", frozenRunConfig: { workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now() });
    const runtime = createAgentRuntime({ ports });
    const result = await runtime.turns.compact({ sessionId, turnId: "usage-anchor-compact-turn", trigger: "manual" });
    expect(result.messages).toHaveLength(1);
    expect((await ports.checkpointStore.getLatest(sessionId))?.usageAnchor).toBeUndefined();
  });
});
