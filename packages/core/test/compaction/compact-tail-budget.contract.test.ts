/**
 * Compact 动态尾部保留策略测试：最多保留最近完整回合，并为摘要预留目标预算。
 */

import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessageTokens } from "../../src/internal/kernel/compact";
import { createAgentTextMessage } from "../../src/internal/types/agent-message";

/** 创建不调用外部 Provider 的确定性摘要采样器。 */
function createSampler() {
  return {
    async sample() {
      return { content: "摘要", toolCalls: [], reasoningSummary: "" };
    },
  };
}

/** 构造一组完整的 user/assistant 回合。 */
function createTurns(count: number, charactersPerUserMessage: number) {
  return Array.from({ length: count }, function createTurn(_value, index) {
    return [
      createAgentTextMessage("user", `第${index + 1}轮${"甲".repeat(charactersPerUserMessage)}`),
      createAgentTextMessage("assistant", `第${index + 1}轮确认`),
    ];
  }).flat();
}

describe("compactMessages 动态尾部预算", () => {
  it("在预算允许时最多保留最近四个完整回合", async () => {
    const messages = createTurns(5, 10);
    const result = await compactMessages({ messages, trigger: "manual", preserveRecentTurns: 4, targetTokens: 1_000, sampler: createSampler() });

    expect(result.preservedFromIndex).toBe(2);
    expect(result.messages.filter(function findUser(message) { return message.role === "user"; })).toHaveLength(4);
  });

  it("四个完整回合超过尾部预算时从最旧回合开始纳入摘要", async () => {
    const messages = createTurns(5, 1_800);
    const result = await compactMessages({ messages, trigger: "manual", preserveRecentTurns: 4, targetTokens: 3_000, sampler: createSampler() });

    expect(result.preservedFromIndex).toBe(8);
    expect(result.messages.filter(function findUser(message) { return message.role === "user"; })).toHaveLength(1);
    expect(result.postTokens).toBeLessThanOrEqual(3_000);
  });

  it("最后一个完整回合也超过尾部预算时将其纳入摘要而非生成超预算投影", async () => {
    const messages = createTurns(1, 900);
    const result = await compactMessages({ messages, trigger: "manual", preserveRecentTurns: 4, targetTokens: 500, sampler: createSampler() });

    expect(result.preservedFromIndex).toBe(messages.length);
    expect(result.messages.filter(function findUser(message) { return message.role === "user"; })).toHaveLength(0);
    expect(estimateMessageTokens(result.messages)).toBeLessThanOrEqual(500);
  });
});
