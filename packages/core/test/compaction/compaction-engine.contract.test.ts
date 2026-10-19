/** Step 3：统一压缩引擎的受控契约测试，不连接真实 Provider。 */

import { describe, expect, it } from "vitest";
import { compactMessages } from "../../src/internal/kernel/compact";
import type { ModelSampler } from "../../src/internal/kernel/model-sampler";
import { createAgentTextMessage, type AgentMessage } from "../../src/internal/types/agent-message";

/** 构造只允许无工具摘要的确定性 fake sampler。 */
function createSampler(content: string, toolCalls: unknown[] = []): ModelSampler {
  return {
    async sample(messages, tools) {
      expect(tools).toEqual([]);
      expect(messages[0]).toMatchObject({ role: "system", content: [expect.objectContaining({ text: expect.stringContaining("上下文压缩器") })] });
      return { content, toolCalls: toolCalls as never[], reasoningSummary: "test", finishReason: "stop" };
    },
  };
}

/** 创建包含完整 tool-call/result 的多回合上下文。 */
function createMessages(): AgentMessage[] {
  return [
    createAgentTextMessage("system", "system rules"),
    createAgentTextMessage("user", "old task"),
    { role: "assistant", content: [{ type: "text", text: "calling tool" }, { type: "tool-call", id: "call-1", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "tool result" }], isError: false }] },
    createAgentTextMessage("assistant", "old answer"),
    createAgentTextMessage("user", "recent task"),
    createAgentTextMessage("assistant", "recent answer"),
  ];
}

describe("Step 3 unified compaction engine", function compactionEngineSuite() {
  it("将完整 tool call/result 归入旧回合并保留完整最近尾部", async function preservesAtomicToolGroups() {
    const result = await compactMessages({
      messages: createMessages(),
      trigger: "manual",
      preserveRecentTurns: 1,
      targetTokens: 10_000,
      sampler: createSampler("summary of old task"),
    });

    expect(result.summary).toBe("summary of old task");
    expect(result.preservedFromIndex).toBe(5);
    expect(result.messages).toEqual([
      createAgentTextMessage("system", "system rules"),
      expect.objectContaining({ role: "system", content: [expect.objectContaining({ text: expect.stringContaining("summary of old task") })] }),
      createAgentTextMessage("user", "recent task"),
      createAgentTextMessage("assistant", "recent answer"),
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("tool result");
  });

  it("空摘要、工具调用和超过目标预算均失败且不返回伪成功", async function rejectsUnsafeSummaries() {
    const input = { messages: createMessages(), trigger: "manual" as const, preserveRecentTurns: 1, targetTokens: 10_000 };
    await expect(compactMessages({ ...input, sampler: createSampler(" ") })).rejects.toThrow("摘要为空");
    await expect(compactMessages({ ...input, sampler: createSampler("summary", [{ id: "unexpected", name: "read_file", input: {} }]) })).rejects.toThrow("不允许工具调用");
    await expect(compactMessages({ ...input, targetTokens: 1, sampler: createSampler("summary") })).rejects.toThrow("超过目标预算");
  });

  it("采样失败和取消直接抛出，调用方可保留旧投影", async function propagatesSamplerFailure() {
    const failingSampler: ModelSampler = { async sample() { throw new Error("provider failed"); } };
    await expect(compactMessages({
      messages: createMessages(),
      trigger: "reactive",
      preserveRecentTurns: 1,
      targetTokens: 10_000,
      sampler: failingSampler,
    })).rejects.toThrow("provider failed");
  });
});
