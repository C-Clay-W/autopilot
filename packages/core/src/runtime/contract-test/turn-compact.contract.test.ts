/**
 * runtime/contract-test/turn-compact.contract.test.ts
 *
 * Phase 4：TurnService.compact() 行为契约。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { createAgentRuntime } from "../public";
import { createMemoryPorts } from "../adapters/memory";
import * as compactModule from "../../internal/kernel/compact";
import { projectContextUsage } from "../../internal/kernel/context-budget";
import type { AgentCompactInput, AgentCompactionResult } from "../../internal/agent-runtime";
import { createAgentTextMessage } from "../../internal/types/agent-message";

describe("TurnService.compact contract", () => {
  let compactSpy: MockInstance<(input: AgentCompactInput) => Promise<AgentCompactionResult>>;

  beforeEach(() => {
    compactSpy = vi.spyOn(compactModule, "compactMessages").mockResolvedValue({
      outcome: "changed",
      summary: "mock summary",
      messages: [createAgentTextMessage("system", "sys"), createAgentTextMessage("user", "u2")],
      preTokens: 120,
      postTokens: 30,
      preservedFromIndex: 3,
    });
  });

  afterEach(() => {
    compactSpy.mockRestore();
  });

  it("压缩消息列表并返回结构化结果", async () => {
    const ports = createMemoryPorts();
    // compact/steer 入口会 requireSession；夹具先建立 Session。
    await ports.sessionStore.save({ id: "s1", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({ ports });
    const messages = [
      createAgentTextMessage("system", "sys"),
      createAgentTextMessage("user", "u1"),
      createAgentTextMessage("assistant", "a1"),
      createAgentTextMessage("user", "u2"),
      createAgentTextMessage("assistant", "a2"),
    ];

    const result = await runtime.turns.compact({
      sessionId: "s1",
      turnId: "t1",
      messages,
      trigger: "manual",
      preserveRecentTurns: 1,
      targetTokens: 10_000,
    });

    expect(compactSpy).toHaveBeenCalledWith({
      messages,
      trigger: "manual",
      preserveRecentTurns: 1,
      targetTokens: 10_000,
      signal: undefined,
      sampler: expect.objectContaining({ sample: expect.any(Function) }),
    });
    expect(result.summary).toBe("mock summary");
    expect(result.messages).toHaveLength(2);
    expect(result.preTokens).toBe(120);
    expect(result.postTokens).toBe(30);
    expect(result.preservedFromIndex).toBe(3);
  });

  it("无旧消息时返回原列表", async () => {
    compactSpy.mockResolvedValue({
      outcome: "skipped",
      reason: "no_compactable_history",
      summary: "",
      messages: [
        createAgentTextMessage("system", "sys"),
        createAgentTextMessage("user", "u1"),
        createAgentTextMessage("assistant", "a1"),
      ],
      preTokens: 30,
      postTokens: 30,
      preservedFromIndex: 3,
    });

    const ports = createMemoryPorts();
    await ports.sessionStore.save({ id: "s1", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({ ports });
    const messages = [
      createAgentTextMessage("system", "sys"),
      createAgentTextMessage("user", "u1"),
      createAgentTextMessage("assistant", "a1"),
    ];

    const result = await runtime.turns.compact({
      sessionId: "s1",
      turnId: "t1",
      messages,
      trigger: "auto",
      preserveRecentTurns: 5,
      targetTokens: 10_000,
    });

    expect(result.summary).toBe("");
    expect(result.preservedFromIndex).toBe(messages.length);
  });

  it("省略预算时读取 Turn 已冻结的 compactPolicy", async () => {
    const ports = createMemoryPorts();
    // compact 入口会 requireSession；直接落盘的 Work Turn 夹具需带新边界签发字段。
    await ports.sessionStore.save({ id: "s-policy", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    await ports.turnStore.save({
      id: "t-policy",
      sessionId: "s-policy",
      status: "completed",
      frozenRunConfig: { compactPolicy: { preserveRecentTurns: 2, targetTokens: 7_000 }, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: Date.now(),
    });
    const runtime = createAgentRuntime({ ports });
    const messages = [createAgentTextMessage("system", "sys"), createAgentTextMessage("user", "u")];

    await runtime.turns.compact({ sessionId: "s-policy", turnId: "t-policy", messages, trigger: "manual" });

    expect(compactSpy).toHaveBeenCalledWith({
      messages,
      trigger: "manual",
      preserveRecentTurns: 2,
      targetTokens: 7_000,
      signal: undefined,
      sampler: expect.objectContaining({ sample: expect.any(Function) }),
    });
  });

  /** 构造带冻结 Provider 配置的已完成 Turn 与携带旧 anchor/投影的 checkpoint。 */
  async function saveCompactFixture(ports: ReturnType<typeof createMemoryPorts>) {
    await ports.sessionStore.save({ id: "s1", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    await ports.turnStore.save({
      id: "t1",
      sessionId: "s1",
      status: "completed",
      frozenRunConfig: { modelRef: { provider: "openai", modelId: "gpt-test" }, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      frozenProviderConfig: { provider: "openai", contextWindowTokens: 100_000, sampleOptions: { maxTokens: 8_192 } },
      startedAt: Date.now(),
      schemaVersion: 2,
    });
    const oldUsage = projectContextUsage({
      messages: [createAgentTextMessage("user", "旧历史")],
      tools: [],
      contextWindowTokens: 100_000,
      outputReserveTokens: 8_192,
      compactTriggerTokens: 80_000,
      modelRef: "openai/gpt-test",
    })!;
    const legacyMessages = [createAgentTextMessage("system", "sys"), createAgentTextMessage("user", "旧历史")];
    await ports.checkpointStore.save("s1", {
      turnId: "t1",
      status: "completed",
      stepCount: 2,
      messages: legacyMessages,
      completedCallIds: [],
      usageAnchor: { usage: { inputTokens: 10, outputTokens: 2, contextTokens: 50 }, messageCount: 2, toolSignature: "[]" },
      contextUsage: oldUsage,
    });
    return { oldUsage, legacyMessages };
  }

  it("manual changed 时以 estimated 投影替换 checkpoint 并发布 context_usage_updated", async () => {
    const ports = createMemoryPorts();
    const { legacyMessages } = await saveCompactFixture(ports);
    const compactedMessages = [createAgentTextMessage("system", "sys"), createAgentTextMessage("system", "已压缩历史摘要（manual）：任务继续")];
    compactSpy.mockResolvedValue({
      outcome: "changed",
      summary: "压缩摘要",
      messages: compactedMessages,
      preTokens: 500,
      postTokens: 120,
      preservedFromIndex: 1,
    });
    const runtime = createAgentRuntime({ ports });

    const result = await runtime.turns.compact({ sessionId: "s1", turnId: "t1", trigger: "manual", preserveRecentTurns: 1, targetTokens: 10_000 });

    expect(result.outcome).toBe("changed");
    expect(result.contextUsage).not.toBeNull();
    expect(result.contextUsage?.measurement).toBe("estimated");
    const saved = await ports.checkpointStore.getLatest("s1");
    expect(saved?.messages).toEqual(compactedMessages);
    expect(saved && "usageAnchor" in saved).toBe(false);
    expect(saved?.contextUsage?.measurement).toBe("estimated");
    const events = await ports.transcriptStore.getEvents("s1");
    expect(events.some((envelope) => envelope.event.type === "context_usage_updated")).toBe(true);
    expect(legacyMessages.length).toBe(2);
  });

  it("manual skipped 时 checkpoint、anchor 与投影均不变且不发布事件", async () => {
    const ports = createMemoryPorts();
    const { oldUsage, legacyMessages } = await saveCompactFixture(ports);
    compactSpy.mockResolvedValue({
      outcome: "skipped",
      reason: "no_compactable_history",
      summary: "",
      messages: legacyMessages,
      preTokens: 60,
      postTokens: 60,
      preservedFromIndex: 2,
    });
    const runtime = createAgentRuntime({ ports });

    const result = await runtime.turns.compact({ sessionId: "s1", turnId: "t1", trigger: "manual", preserveRecentTurns: 1, targetTokens: 10_000 });

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_compactable_history");
    expect(result.contextUsage).toEqual(oldUsage);
    const saved = await ports.checkpointStore.getLatest("s1");
    expect(saved?.messages).toEqual(legacyMessages);
    expect(saved?.usageAnchor).toEqual({ usage: { inputTokens: 10, outputTokens: 2, contextTokens: 50 }, messageCount: 2, toolSignature: "[]" });
    const events = await ports.transcriptStore.getEvents("s1");
    expect(events.some((envelope) => envelope.event.type === "context_usage_updated")).toBe(false);
  });
});
