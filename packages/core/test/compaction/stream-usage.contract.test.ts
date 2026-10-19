/**
 * Step 1 流式 usage 合约测试。
 *
 * 使用受控 fetch/SSE fixture 验证 DeepSeek include_usage 请求与安全归一化，
 * 不连接真实 Provider、不读取真实凭据，也不产生运行态文件。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelToolDefinition } from "../../src/internal/lib/llm";
import { AgentSampleError } from "../../src/internal/lib/llm";
import { createOpenAiChatCompletionsSampler } from "../../src/runtime/provider/openai-chat-completions-adapter";

const fetchMock = vi.fn();
const emptyTools: AgentModelToolDefinition[] = [];

/** 构造完整或故意缺少终止标记的 OpenAI 兼容 SSE 响应。 */
function createSseResponse(payloads: unknown[], includeDone = true): Response {
  const body = payloads.map(function formatPayload(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }).join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 返回最小模型输入，避免测试内容影响 usage 合约。 */
function createMessages() {
  return [{ role: "user" as const, content: [{ type: "text" as const, text: "测试" }] }];
}

/** 通过唯一 Chat Completions Adapter 调用受控 Provider，避免依赖模块级环境变量。 */
function sampleWithFixture() {
  const sampler = createOpenAiChatCompletionsSampler({
    baseUrl: "http://agent-loop.test",
    apiKey: "fake-provider-key",
    sampleOptions: { model: "test-model" },
    protocolProfile: {
      apiProtocol: "openai-chat-completions",
      assistantToolCallContent: "empty-string",
      supportsReasoningContent: true,
      supportsUsageInStreaming: true,
    },
  });
  return sampler.sample(createMessages(), emptyTools, { maxTokens: 8_192 });
}

describe("Step 1 streaming usage contract", function streamingUsageContractSuite() {
  afterEach(function restoreFetchMock() {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("请求 include_usage 并归一化完整终态 usage chunk", async function requestsAndNormalizesUsage() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }], usage: null },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
    ])));

    await expect(sampleWithFixture()).resolves.toMatchObject({
      usage: { inputTokens: 80, outputTokens: 20, contextTokens: 100 },
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ stream_options: { include_usage: true } });
  });

  it("忽略普通增量的 usage: null", async function ignoresNullUsageOnNormalDelta() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }], usage: null },
    ])));

    await expect(sampleWithFixture()).resolves.not.toHaveProperty("usage");
  });

  it("缺失、损坏或重复 usage 时降级而不产生 context anchor", async function degradesUntrustedUsage() {
    const fixtures = [
      [],
      [{ choices: [], usage: { prompt_tokens: 80, completion_tokens: "20", total_tokens: 100 } }],
      [
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
      ],
    ];

    for (const usagePayloads of fixtures) {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockResolvedValueOnce(createSseResponse([
        { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] },
        ...usagePayloads,
      ]));
      await expect(sampleWithFixture()).resolves.not.toHaveProperty("usage");
    }
  });

  it("接受终态 usage 挂在最后一个 choices 非空 chunk 上的真实端点形状", async function acceptsUsageAttachedToFinalContentChunk() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "完成前" } }] },
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 86, completion_tokens: 16, total_tokens: 102 } },
    ])));

    // 同 chunk 的正文不得丢失；usage 数值通过归一化校验后成为可信锚点。
    await expect(sampleWithFixture()).resolves.toMatchObject({
      content: "完成前完成",
      usage: { inputTokens: 86, outputTokens: 16, contextTokens: 102 },
    });
  });

  it("断流时不返回结果，因此 usage 不会被提交", async function rejectsUsageFromIncompleteStream() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "半截" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
    ], false)));

    await expect(sampleWithFixture()).rejects.toMatchObject({
      name: "AgentSampleError",
      code: "STREAM_INCOMPLETE",
    } satisfies Partial<AgentSampleError>);
  });

  it("工具调用完成后保留同一完整响应的 usage", async function keepsUsageForCompletedToolCall() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ])));

    await expect(sampleWithFixture()).resolves.toMatchObject({
      toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }],
      usage: { inputTokens: 120, outputTokens: 30, contextTokens: 150 },
    });
  });

  it("reasoning-only 的完整响应仍失败，因此 usage 不会被提交", async function rejectsUsageFromReasoningOnlyResponse() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { reasoning_content: "隐藏推理" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
    ])));

    await expect(sampleWithFixture()).rejects.toMatchObject({
      name: "AgentSampleError",
      code: "EMPTY_RESPONSE",
    } satisfies Partial<AgentSampleError>);
  });
});
