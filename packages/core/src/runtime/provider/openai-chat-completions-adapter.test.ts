/**
 * runtime/provider/openai-chat-completions-adapter.test.ts — Chat Completions V2 Adapter 的 wire 与流式边界测试。
 *
 * 全部用本地 fetch stub 验证，不连接真实 Provider，也不读取真实凭据。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelToolDefinition } from "../../internal/lib/llm";
import { AgentSampleError } from "../../internal/lib/llm";
import type { AgentMessage } from "../../internal/types/agent-message";
import { createOpenAiChatCompletionsMessages, createOpenAiChatCompletionsRequest, createOpenAiChatCompletionsSampler } from "./openai-chat-completions-adapter";

/** 构造开启 reasoning/usage 的受信 Chat profile。 */
function createProfile() {
  return {
    apiProtocol: "openai-chat-completions" as const,
    assistantToolCallContent: "empty-string" as const,
    supportsReasoningContent: true,
    supportsUsageInStreaming: true,
  };
}

/** 构造包含工具调用、成功和失败结果的完整 V2 canonical 历史。 */
function createMessages(): AgentMessage[] {
  return [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "user", content: [{ type: "text", text: "读取两个文件" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "internal reasoning" },
        { type: "tool-call", id: "call-1", name: "read_file", input: { path: "README.md" } },
        { type: "tool-call", id: "call-2", name: "read_file", input: { path: "missing.md" } },
      ],
    },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "{\"status\":\"success\"}" }], isError: false }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call-2", content: [{ type: "text", text: "{\"status\":\"error\"}" }], isError: true }] },
    { role: "user", content: [{ type: "text", text: "继续分析" }] },
  ];
}

/** 构造本地 Chat SSE 响应。 */
function createSseResponse(payloads: unknown[], includeDone = true): Response {
  const body = payloads.map(function serializePayload(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }).join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const fetchMock = vi.fn();
const emptyTools: AgentModelToolDefinition[] = [];

describe("OpenAI Chat Completions V2 Adapter", function adapterSuite() {
  afterEach(function restoreFetchMock() {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("精确展开 V2 roles、tool_calls、独立 tool result 与安全失败文本", function createsExactWireBody() {
    const body = createOpenAiChatCompletionsRequest({
      model: "fixture-model",
      messages: createMessages(),
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      sampleOptions: { temperature: 0.2, reasoningEffort: "high" },
      maxTokens: 256,
      protocolProfile: createProfile(),
    });

    expect(body).toEqual({
      model: "fixture-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "读取两个文件" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } },
            { id: "call-2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"missing.md\"}" } },
          ],
          reasoning_content: "internal reasoning",
        },
        { role: "tool", tool_call_id: "call-1", content: "{\"status\":\"success\"}" },
        { role: "tool", tool_call_id: "call-2", content: "工具执行失败：\n{\"status\":\"error\"}" },
        { role: "user", content: "继续分析" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
    });
  });

  /** 收尾选择沿协议发送，仅该次请求关闭思考，下一次恢复冻结选项。 */
  it("结构化收尾：Chat Completions 强制工具选择透传且不污染冻结配置", async function forceAnswerTool() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test/v1", apiKey: "test-key", sampleOptions: { model: "fixture-model", thinking: "enabled", reasoningEffort: "high", temperature: 0.7 }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockImplementation(function respond() { return Promise.resolve(createSseResponse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }])); }));
    const tools: AgentModelToolDefinition[] = [{ type: "function", function: { name: "chat_submit_answer", description: "submit", parameters: { type: "object" } } }];
    await sampler.sample([{ role: "user", content: [{ type: "text", text: "submit" }] }], tools, { toolChoice: { name: "chat_submit_answer" } });
    const forced = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(forced).toMatchObject({ tool_choice: { type: "function", function: { name: "chat_submit_answer" } }, thinking: { type: "disabled" }, temperature: 0 });
    expect(forced).not.toHaveProperty("reasoning_effort");
    await sampler.sample([{ role: "user", content: [{ type: "text", text: "next" }] }], tools, {});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ tool_choice: "auto", thinking: { type: "enabled" }, reasoning_effort: "high", temperature: 0.7 });
  });

  it("不支持 reasoning/usage 的 profile 不发送或读取对应字段", async function gatesOptionalCompatibilityFields() {
    const profile = { ...createProfile(), assistantToolCallContent: "null" as const, supportsReasoningContent: false, supportsUsageInStreaming: false };
    const messages = createOpenAiChatCompletionsMessages(createMessages(), profile);
    expect(messages[2]).toMatchObject({ content: null });
    expect(messages[2]).not.toHaveProperty("reasoning_content");
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test/v1", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: profile });
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "完成", reasoning_content: "ignored" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ])));

    const result = await sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {});
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(request).not.toHaveProperty("stream_options");
    expect(result).not.toHaveProperty("reasoningContent");
    expect(result).not.toHaveProperty("usage");
  });

  it("按 index 合并工具参数分片并返回可信 usage", async function parsesToolCallChunksAndUsage() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_", arguments: "{\"path\":" } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
    ])));

    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "读取" }] }], emptyTools, {})).resolves.toMatchObject({
      toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }],
      usage: { inputTokens: 5, outputTokens: 7, contextTokens: 12 },
    });
  });

  it("对损坏、截断和 HTTP 错误使用稳定安全错误", async function normalizesStreamAndHttpFailures() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response("data: not-json\n\ndata: [DONE]\n\n", { status: 200 })));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {})).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" } satisfies Partial<AgentSampleError>);

    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response('{"error":{"message":"provider internal detail"}}', { status: 400 })));
    const error = await sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {}).catch(function getError(value: unknown) { return value; });
    expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", message: "供应商拒绝请求（HTTP 400）" } satisfies Partial<AgentSampleError>);
    expect((error as Error).message).not.toContain("provider internal detail");
  });

  it("对早停流和长度截断的 tool 参数分别拒绝", async function rejectsTruncatedStreamsAndArguments() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { content: "半截" }, finish_reason: null }] },
    ], false)));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {})).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" } satisfies Partial<AgentSampleError>);

    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{\"path\":" } }] }, finish_reason: "length" }] },
    ])));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {})).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" } satisfies Partial<AgentSampleError>);
  });

  it("映射限流和服务端错误，并拒绝未闭合的 canonical 工具调用", async function mapsStatusAndRejectsInvalidCanonical() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response("", { status: 429 })));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {})).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" } satisfies Partial<AgentSampleError>);

    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response("", { status: 503 })));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {})).rejects.toMatchObject({ code: "PROVIDER_SERVER_ERROR" } satisfies Partial<AgentSampleError>);

    await expect(sampler.sample([
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read_file", input: {} }] },
    ], emptyTools, {})).rejects.toMatchObject({ code: "CANONICAL_MESSAGE_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("内部超时归一为 PROVIDER_TIMEOUT", async function normalizesProviderTimeout() {
    vi.useFakeTimers();
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", timeoutMs: 10, sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    vi.stubGlobal("fetch", fetchMock.mockImplementation(function waitForAbort(_url: string, init?: RequestInit) {
      return new Promise<Response>(function rejectOnAbort(_resolve, reject) {
        init?.signal?.addEventListener("abort", function rejectAbort() { reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    }));
    const pending = sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, {});
    const expected = expect(pending).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<AgentSampleError>);
    await vi.advanceTimersByTimeAsync(11);
    await expected;
    vi.useRealTimers();
  });

  it("调用方 abort 保留 AbortError，不伪装为连接错误", async function preservesCallerAbort() {
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://provider.test", apiKey: "test-key", sampleOptions: { model: "fixture-model" }, protocolProfile: createProfile() });
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(sampler.sample([{ role: "user", content: [{ type: "text", text: "测试" }] }], emptyTools, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
