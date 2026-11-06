/** 同一次安全用量查询只读一次checkpoint，保留旧查询投影和身份失败边界。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../../src/runtime/public";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { projectContextUsage } from "../../../src/internal/kernel/context-budget";

it("用量双投影读取同一checkpoint且白名单/错Turn安全", async function usageSnapshot() {
  const ports = createMemoryPorts();
  const usage = projectContextUsage({ messages: [], tools: [], contextWindowTokens: 100000, outputReserveTokens: 8192, compactTriggerTokens: 80000, modelRef: "test/model" });
  await ports.checkpointStore.save("s", { turnId: "t", status: "completed", stepCount: 0, messages: [], completedCallIds: [], contextUsage: usage ?? undefined });
  const runtime = createAgentRuntime({ ports });
  const expectedContext = await runtime.turns.getContextUsage({ sessionId: "s" });
  const expectedTurn = await runtime.turns.getTurnUsageSummary({ sessionId: "s" });
  const read = vi.spyOn(ports.checkpointStore, "getLatest");
  expect(await runtime.turns.getUsageSnapshot({ sessionId: "s" })).toEqual({ contextUsage: expectedContext, turnUsage: expectedTurn });
  expect(read).toHaveBeenCalledTimes(1);
  expect(await runtime.turns.getUsageSnapshot({ sessionId: "s", turnId: "other" })).toEqual({ contextUsage: null, turnUsage: null });
  expect(await runtime.turns.getUsageSnapshot({ sessionId: "empty" })).toEqual({ contextUsage: null, turnUsage: null });
});
