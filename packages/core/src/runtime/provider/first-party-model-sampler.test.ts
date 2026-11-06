/**
 * runtime/provider/first-party-model-sampler.test.ts — Anthropic Messages 主链契约测试。
 *
 * 使用受控 HTTP/SSE 响应验证请求形状、工具循环、usage、认证与错误边界，不连接真实 Provider。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSampleError } from "../../internal/lib/llm";
import { createAgentTextMessage, createAgentToolResultMessage } from "../../internal/types/agent-message";
import { migrateAgentMessages } from "../protocol/migrate-agent-messages";
import { createFirstPartyModelSampler } from "./first-party-model-sampler";
import { createAnthropicMessagesRequest } from "./anthropic-messages-adapter";
import { createDefaultModelSamplerFactory } from "./default-model-sampler-factory";
import {
  createAdjacentUserConversation,
  createParallelToolResultConversation,
  createSingleToolConversation,
  createToolResultThenSteerConversation,
} from "./provider-message-fixtures";

const fetchMock = vi.fn();

/** 将 Stage 0 保留的 V1 fixture 显式迁移为 Anthropic Adapter 所需的 V2 输入。 */
function migrateFixture(messages: unknown[]): import("../../internal/types/agent-message").AgentMessage[] {
  const migrated = migrateAgentMessages({ messages });
  if (!migrated.ok) throw new Error(migrated.message);
  return migrated.messages;
}

/** 将 Anthropic Messages SSE 事件编码为可由 SDK 读取的响应。 */
function createMessagesSseResponse(events: unknown[]): Response {
  const body = events.map(function encodeEvent(event) {
    const type = (event as { type?: unknown }).type;
    return `event: ${typeof type === "string" ? type : "message"}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 创建 Messages 的最小文本完成事件序列。 */
function createTextEvents(): unknown[] {
  return [
    { type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "已完成" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

/** 创建带一个 tool_use 的最小完成事件序列。 */
function createToolEvents(): unknown[] {
  return [
    { type: "message_start", message: { id: "msg-2", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

/** 创建带空 thinking 和 tool_use 的 Anthropic 响应，覆盖 Provider 结构块与 canonical 的差异。 */
function createEmptyThinkingToolEvents(): unknown[] {
  return [
    { type: "message_start", message: { id: "msg-empty-thinking", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-empty" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-empty-thinking", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

/** 创建固定 firstParty sampler，避免测试依赖本机环境变量。 */
function createSampler(authMode: "api_key" | "bearer" = "api_key", reasoningEffort: "high" | "max" = "high") {
  return createFirstPartyModelSampler({
    baseUrl: "https://stub.example/anthropic",
    apiKey: "fixture-secret",
    authMode,
    sampleOptions: { model: "fixture-model", reasoningEffort, thinking: "enabled" },
  });
}

describe("firstParty Anthropic Messages sampler", function firstPartySamplerSuite() {
  afterEach(function restoreFetchMock() {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  /** Messages 强制答案工具时关闭思考，正常采样仍原样发送冻结 effort。 */
  it("结构化收尾：Messages 强制工具选择透传且不污染冻结配置", async function forceAnswerTool() {
    fetchMock.mockImplementation(function respond() { return Promise.resolve(createMessagesSseResponse(createTextEvents())); });
    vi.stubGlobal("fetch", fetchMock);
    const sampler = createSampler("api_key", "max");
    const tools = [{ type: "function" as const, function: { name: "chat_submit_answer", description: "submit", parameters: { type: "object" } } }];
    await sampler.sample([createAgentTextMessage("user", "submit")], tools, { toolChoice: { name: "chat_submit_answer" } });
    const forced = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(forced).toMatchObject({ tool_choice: { type: "tool", name: "chat_submit_answer", disable_parallel_tool_use: true }, thinking: { type: "disabled" }, temperature: 0 });
    expect(forced).not.toHaveProperty("output_config");
    await sampler.sample([createAgentTextMessage("user", "next")], tools, {});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ tool_choice: { type: "auto" }, thinking: { type: "adaptive" }, output_config: { effort: "max" } });
  });

  it("发送 Messages 路径、system、工具定义与原样 max output_config.effort", async function sendsMessagesRequest() {
    fetchMock.mockResolvedValue(createMessagesSseResponse(createTextEvents()));
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const result = await createSampler("api_key", "max").sample(
      [createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")],
      [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      {},
      function collectDelta(delta) { deltas.push(delta); },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe("https://stub.example/anthropic/v1/messages");
    expect(body.system).toBe("system");
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.tools).toEqual([{ name: "read_file", description: "read", input_schema: { type: "object" } }]);
    expect(deltas).toEqual(["已完成"]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, contextTokens: 10 });
  });

  /** 构造带缓存桶的 Messages 完成事件；message_delta 只更新输出量。 */
  function createCacheUsageEvents(usage: Record<string, unknown>, outputTokens: number): unknown[] {
    return [
      { type: "message_start", message: { id: "msg-cache", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { output_tokens: 0, ...usage } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "命中" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } },
      { type: "message_stop" },
    ];
  }

  /** 去掉断点标记，只比较协议内容形状。 */
  function stripCacheControl<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, function omitCacheControl(key, item) { return key === "cache_control" ? undefined : item; })) as T;
  }

  it("显式缓存只在 system、末个工具与对话前缀末尾各打一个断点", function marksStablePrefixForExplicitMode() {
    const tools = [
      { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "grep_files", description: "grep", parameters: { type: "object" } } },
    ];
    const request = createAnthropicMessagesRequest(
      "fixture-model",
      [createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")],
      tools,
      {},
      100,
      false,
      "explicit",
    );
    expect(request.system).toEqual([{ type: "text", text: "system", cache_control: { type: "ephemeral" } }]);
    expect(request.tools).toEqual([
      { name: "read_file", description: "read", input_schema: { type: "object" } },
      { name: "grep_files", description: "grep", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ]);
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "读取文件", cache_control: { type: "ephemeral" } }] }]);
    expect(JSON.stringify(request).match(/"cache_control":/gu)).toHaveLength(3);

    // 以 tool_result 结尾的步骤把断点打在末个 tool_result 上，不新增第四条消息级标记。
    const toolRequest = createAnthropicMessagesRequest("fixture-model", [
      createAgentTextMessage("user", "读取文件"),
      { role: "assistant" as const, content: [{ type: "tool-call" as const, id: "call-1", name: "read_file", input: { path: "README.md" } }] },
      createAgentToolResultMessage({ toolCallId: "call-1", text: "{\"ok\":true}", isError: false }),
    ], tools, {}, 100, false, "explicit");
    expect(toolRequest.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "{\"ok\":true}" }], is_error: false, cache_control: { type: "ephemeral" } }],
    });
  });

  it("自动缓存、未知能力与默认调用都不发缓存标记", function neverMarksWithoutExplicitDeclaration() {
    const messages = [createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")];
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } }];
    for (const mode of ["server-auto", "none"] as const) {
      const request = createAnthropicMessagesRequest("fixture-model", messages, tools, {}, 100, false, mode);
      expect(request.system).toBe("system");
      expect(request.messages.at(-1)).toEqual({ role: "user", content: "读取文件" });
      expect(JSON.stringify(request)).not.toContain("cache_control");
    }
    expect(JSON.stringify(createAnthropicMessagesRequest("fixture-model", messages, tools, {}, 100))).not.toContain("cache_control");
  });

  it("显式缓存下一步复用同一前缀形状，逐步只挪动断点位置", function keepsPrefixShapeStableAcrossSteps() {
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } }];
    const firstStep = createAnthropicMessagesRequest("fixture-model", [createAgentTextMessage("system", "system"), createAgentTextMessage("user", "第一步")], tools, {}, 100, false, "explicit");
    const secondStep = createAnthropicMessagesRequest("fixture-model", [
      createAgentTextMessage("system", "system"),
      createAgentTextMessage("user", "第一步"),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "第一答复" }] },
      createAgentTextMessage("user", "第二步"),
    ], tools, {}, 100, false, "explicit");
    // 历史消息在两步骤中形状与内容一致（只是不再携带上一步的断点标记）。
    expect(secondStep.messages[0]).toEqual(stripCacheControl(firstStep.messages[0]));
    expect(Array.isArray(secondStep.messages[0].content)).toBe(true);
    expect(secondStep.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "第二步", cache_control: { type: "ephemeral" } }] });
  });

  it("采样器按冻结缓存策略发送断点，能力缺省时保持原请求", async function sendsMarkersOnlyForExplicitSampler() {
    // 每次调用都返回新的 SSE 响应，避免复用已消费的 body。
    fetchMock.mockImplementation(function respond() { return Promise.resolve(createMessagesSseResponse(createTextEvents())); });
    vi.stubGlobal("fetch", fetchMock);
    const tool = { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } };
    await createFirstPartyModelSampler({
      baseUrl: "https://stub.example/anthropic",
      apiKey: "fixture-secret",
      sampleOptions: { model: "fixture-model" },
      promptCacheMode: "explicit",
    }).sample([createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")], [tool], {});
    const marked = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { system: Array<{ cache_control?: unknown }>; tools: Array<{ cache_control?: unknown }>; messages: Array<{ content: unknown }> };
    expect(marked.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(marked.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(marked.messages[0].content).toEqual([{ type: "text", text: "读取文件", cache_control: { type: "ephemeral" } }]);

    await createSampler().sample([createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")], [tool], {});
    expect(String(fetchMock.mock.calls[1][1].body)).not.toContain("cache_control");
  });

  it("工厂按受信能力目录解析缓存策略，未声明 explicit 的模型不发标记", async function resolvesCacheModeFromCatalog() {
    fetchMock.mockImplementation(function respond() { return Promise.resolve(createMessagesSseResponse(createTextEvents())); });
    vi.stubGlobal("fetch", fetchMock);
    const tool = { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } };
    // deepseek-flash 经目录别名解析为 server-auto；未登记模型按 none 处理，两者都不发标记。
    for (const modelId of ["deepseek-flash", "unregistered-model"]) {
      const sampler = createDefaultModelSamplerFactory().create({
        ref: { provider: "firstParty", modelId },
        credential: { apiKey: "fixture-secret" },
        providerConfig: { provider: "firstParty", apiProtocol: "anthropic-messages", baseUrl: "https://stub.example/anthropic", sampleOptions: { model: modelId } },
      });
      await sampler.sample([createAgentTextMessage("system", "system"), createAgentTextMessage("user", "读取文件")], [tool], {});
    }
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const call of fetchMock.mock.calls) expect(String((call as [string, RequestInit])[1].body)).not.toContain("cache_control");
  });

  it("Anthropic usage 按协议合并缓存桶，每个 token 只计一次", async function normalizesCacheBuckets() {
    const cases: Array<[Record<string, unknown>, number, Record<string, number>]> = [
      [{ input_tokens: 276, cache_read_input_tokens: 5200, cache_creation_input_tokens: 0 }, 20, { inputTokens: 5476, outputTokens: 20, contextTokens: 5496 }],
      [{ input_tokens: 5476, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 20, { inputTokens: 5476, outputTokens: 20, contextTokens: 5496 }],
      [{ input_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: 100 }, 5, { inputTokens: 110, outputTokens: 5, contextTokens: 115 }],
    ];
    vi.stubGlobal("fetch", fetchMock);
    for (const [usage, outputTokens, expected] of cases) {
      fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createCacheUsageEvents(usage, outputTokens)));
      const result = await createSampler().sample([createAgentTextMessage("user", "测试")], [], {});
      expect(result.usage).toEqual(expected);
    }
  });

  it("非法缓存桶与不完整流都不产生可信 usage", async function rejectsUntrustedCacheUsage() {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createCacheUsageEvents({ input_tokens: 10, cache_read_input_tokens: -1 }, 5)));
    const invalidBuckets = await createSampler().sample([createAgentTextMessage("user", "测试")], [], {});
    expect(invalidBuckets).not.toHaveProperty("usage");

    // 只有 message_start 的不完整流：绝不返回可作锚点的部分用量。
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(createMessagesSseResponse([
      { type: "message_start", message: { id: "msg-cut", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 0 } } },
    ])));
    const truncated = createSampler().sample([createAgentTextMessage("user", "测试")], [], {});
    await expect(truncated).rejects.toBeInstanceOf(AgentSampleError);
  });

  it("Anthropic 官方 DeepSeek 端点传递有限状态 profile，兼容网关不套用", async function scopesDeepSeekHttpFailure() {
    const response = function createHttpErrorResponse(): Response {
      return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic provider body" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", fetchMock);
    const officialSampler = createFirstPartyModelSampler({
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "fixture-secret",
      sampleOptions: { model: "fixture-model" },
    });
    fetchMock.mockResolvedValueOnce(response());
    await expect(officialSampler.sample([createAgentTextMessage("user", "合成请求")], [], {})).rejects.toMatchObject({
      code: "PROVIDER_REQUEST_REJECTED",
      providerHttpStatus: 402,
      providerFailureReason: "billing_insufficient",
    });

    const gatewaySampler = createFirstPartyModelSampler({
      baseUrl: "https://gateway.example/anthropic",
      apiKey: "fixture-secret",
      sampleOptions: { model: "fixture-model" },
    });
    fetchMock.mockResolvedValueOnce(response());
    const gatewayFailure = await gatewaySampler.sample([createAgentTextMessage("user", "合成请求")], [], {}).catch(function captureGatewayFailure(value: unknown) { return value; });
    expect(gatewayFailure).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", providerHttpStatus: 402 });
    expect((gatewayFailure as AgentSampleError).providerFailureReason).toBeUndefined();
  });

  it("Anthropic 协议读取结构化余额事实并区分限流与未知网关", async function normalizesMessagesBusinessFacts() {
    vi.stubGlobal("fetch", fetchMock);
    for (const [baseUrl, businessCode, code, reason] of [
      ["https://api.z.ai/api/anthropic", "1113", "PROVIDER_REQUEST_REJECTED", "billing_insufficient"],
      ["https://api.z.ai/api/anthropic", "1302", "PROVIDER_RATE_LIMIT", "rate_limited"],
      ["https://gateway.example/anthropic", "1113", "PROVIDER_REQUEST_REJECTED", undefined],
    ] as const) {
      const sampler = createFirstPartyModelSampler({ baseUrl, apiKey: "fixture", sampleOptions: { model: "fixture" } });
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: businessCode, message: "sk-secret /private/path" } }), { status: 429, headers: { "Content-Type": "application/json" } }));
      const failure = await sampler.sample([createAgentTextMessage("user", "synthetic")], [], {}).catch(function capture(value: AgentSampleError) { return value; }) as AgentSampleError;
      expect(failure).toMatchObject({ code, providerHttpStatus: 429 });
      expect(failure.providerFailureReason).toBe(reason);
      expect(failure.message).not.toContain("sk-secret");
      expect(failure.message).not.toContain("/private/path");
    }
  });

  it("Anthropic 未知网关保留协议标识且不猜测 429", async function exposesGenericMessagesIdentifier() {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "error", error: { type: "capacity_exhausted", message: "sk-secret /private/path" } }), { status: 429, headers: { "Content-Type": "application/json" } })));
    const sampler = createFirstPartyModelSampler({ baseUrl: "https://gateway.example/anthropic", apiKey: "fixture", sampleOptions: { model: "fixture" } });
    const error = await sampler.sample([createAgentTextMessage("user", "synthetic")], [], {}).catch(function capture(value: AgentSampleError) { return value; });
    expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", providerHttpStatus: 429, providerFailureDetail: "type:capacity_exhausted" });
    expect(JSON.stringify(error)).not.toContain("sk-secret");
  });

  it("将 tool_use 与下一轮 tool_result 映射为 Messages 内容块", async function mapsToolUseAndResult() {
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createToolEvents())).mockResolvedValueOnce(createMessagesSseResponse(createTextEvents()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await createSampler().sample([createAgentTextMessage("user", "读取文件")], [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }], {});
    await createSampler().sample([
      { role: "assistant", content: first.toolCalls.map(function toToolCall(call) { return { type: "tool-call" as const, id: call.id, name: call.name, input: call.input as Record<string, unknown> }; }) },
      createAgentToolResultMessage({ toolCallId: "tool-1", text: "{\"ok\":true}", isError: false }),
    ], [], {});

    expect(first.toolCalls).toEqual([{ id: "tool-1", name: "read_file", input: { path: "README.md" } }]);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } }] });
    expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "{\"ok\":true}" }], is_error: false }] });
  });

  it("保留空 thinking 的 wire replay，同时允许 canonical 只含 tool-call", async function replaysEmptyThinkingWithToolCall() {
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createEmptyThinkingToolEvents())).mockResolvedValueOnce(createMessagesSseResponse(createTextEvents()));
    vi.stubGlobal("fetch", fetchMock);

    const tool = { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } };
    const first = await createSampler().sample([createAgentTextMessage("user", "读取文件")], [tool], {});
    if (!first.adapterReplayState) throw new Error("空 thinking 响应缺少 Anthropic replay state");

    await createSampler().sample([
      {
        role: "assistant",
        content: first.toolCalls.map(function toToolCall(call) { return { type: "tool-call" as const, id: call.id, name: call.name, input: call.input as Record<string, unknown> }; }),
        adapterReplayState: first.adapterReplayState,
      },
      createAgentToolResultMessage({ toolCallId: "tool-empty-thinking", text: "{\"ok\":true}", isError: false }),
    ], [], {});

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-empty" },
        { type: "tool_use", id: "tool-empty-thinking", name: "read_file", input: { path: "README.md" } },
      ],
    });
  });

  it("将同批多个 tool_result 聚合到一条 user message", async function groupsParallelToolResults() {
    fetchMock.mockResolvedValue(createMessagesSseResponse(createTextEvents()));
    vi.stubGlobal("fetch", fetchMock);

    await createSampler().sample(migrateFixture(createParallelToolResultConversation()), [], {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages).toEqual([
      { role: "user", content: "读取两个文件" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
          { type: "tool_use", id: "call-2", name: "read_file", input: { path: "package.json" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: '{"status":"success","path":"README.md"}' }], is_error: false },
          { type: "tool_result", tool_use_id: "call-2", content: [{ type: "text", text: '{"status":"error","code":"FS_NOT_FOUND"}' }], is_error: true },
        ],
      },
    ]);
  });

  it("只在有效私有 replay state 存在时精确重放 Anthropic thinking block", function replaysThinkingBlocks() {
    const messages = [
      createAgentTextMessage("user", "读取文件"),
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "先读取文件。" },
          { type: "reasoning" as const, text: "内部推理" },
          { type: "tool-call" as const, id: "call-thinking", name: "read_file", input: { path: "README.md" } },
        ],
        adapterReplayState: {
          apiProtocol: "anthropic-messages" as const,
          value: [
            { type: "thinking", thinking: "内部推理", signature: "sig-1" },
            { type: "text", text: "先读取文件。" },
            { type: "tool_use", id: "call-thinking", name: "read_file", input: { path: "README.md" } },
          ],
        },
      },
      createAgentToolResultMessage({ toolCallId: "call-thinking", text: "{\"status\":\"success\"}", isError: false }),
    ];
    const request = createAnthropicMessagesRequest("fixture-model", messages, [], {}, 100);
    expect(request.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内部推理", signature: "sig-1" },
        { type: "text", text: "先读取文件。" },
        { type: "tool_use", id: "call-thinking", name: "read_file", input: { path: "README.md" } },
      ],
    });
    expect(function safelyProjectsOldUnsignedReasoning() {
      createAnthropicMessagesRequest("fixture-model", [
        createAgentTextMessage("user", "读取文件"),
        { role: "assistant", content: [{ type: "reasoning", text: "没有 signature" }, { type: "tool-call", id: "call-invalid", name: "read_file", input: {} }] },
        createAgentToolResultMessage({ toolCallId: "call-invalid", text: "error", isError: true }),
      ], [], {}, 100);
    }).not.toThrow();
  });

  /** 创建 MiMo 式无签名 thinking + tool_use 的完成事件序列，覆盖兼容网关响应形状。 */
  function createUnsignedThinkingToolEvents(): unknown[] {
    return [
      { type: "message_start", message: { id: "msg-unsigned-thinking", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "兼容网关推理" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-unsigned", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
  }

  it("兼容网关容忍缺签名 thinking：原样入 replay state 并回传，官方地址维持严格", async function toleratesUnsignedThinkingOnCompatGateway() {
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createUnsignedThinkingToolEvents()));
    vi.stubGlobal("fetch", fetchMock);
    const tool = { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } };
    const first = await createSampler().sample([createAgentTextMessage("user", "读取文件")], [tool], {});
    expect(first.reasoningContent).toBe("兼容网关推理");
    expect(first.adapterReplayState?.value).toEqual([
      { type: "thinking", thinking: "兼容网关推理" },
      { type: "tool_use", id: "tool-unsigned", name: "read_file", input: { path: "README.md" } },
    ]);

    // 回放原样回传，不伪造 signature；canonical reasoning 与 thinking 语义一致。
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createTextEvents()));
    await createSampler().sample([
      {
        role: "assistant",
        content: [
          { type: "reasoning" as const, text: "兼容网关推理" },
          { type: "tool-call" as const, id: "tool-unsigned", name: "read_file", input: { path: "README.md" } },
        ],
        adapterReplayState: first.adapterReplayState,
      },
      createAgentToolResultMessage({ toolCallId: "tool-unsigned", text: "{\"ok\":true}", isError: false }),
    ], [], {});
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "兼容网关推理" },
        { type: "tool_use", id: "tool-unsigned", name: "read_file", input: { path: "README.md" } },
      ],
    });

    // 官方地址不启用容忍开关：同样的无签名 thinking 在提取阶段即拒绝。
    const officialSampler = createFirstPartyModelSampler({
      baseUrl: "https://api.anthropic.com",
      apiKey: "fixture-secret",
      sampleOptions: { model: "fixture-model", thinking: "enabled" },
    });
    fetchMock.mockResolvedValueOnce(createMessagesSseResponse(createUnsignedThinkingToolEvents()));
    await expect(officialSampler.sample([createAgentTextMessage("user", "读取文件")], [tool], {})).rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED" });
  });

  it("兼容网关回放丢弃 redacted_thinking（DS 兼容层不支持），官方回放原样保留", function dropsRedactedThinkingForCompatGateway() {
    const messages = [
      createAgentTextMessage("user", "读取文件"),
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "先读取文件。" },
          { type: "tool-call" as const, id: "call-redacted", name: "read_file", input: { path: "README.md" } },
        ],
        adapterReplayState: {
          apiProtocol: "anthropic-messages" as const,
          value: [
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "先读取文件。" },
            { type: "tool_use", id: "call-redacted", name: "read_file", input: { path: "README.md" } },
          ],
        },
      },
      createAgentToolResultMessage({ toolCallId: "call-redacted", text: "{\"status\":\"success\"}", isError: false }),
    ];
    const lenient = createAnthropicMessagesRequest("fixture-model", messages, [], {}, 100, true);
    expect(lenient.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "先读取文件。" },
        { type: "tool_use", id: "call-redacted", name: "read_file", input: { path: "README.md" } },
      ],
    });
    const official = createAnthropicMessagesRequest("fixture-model", messages, [], {}, 100);
    expect(official.messages[1]).toMatchObject({ content: expect.arrayContaining([{ type: "redacted_thinking", data: "opaque" }]) });
  });

  it("保留单工具、相邻用户消息与 tool result 后 steer 的消息顺序", async function keepsV1ConversationOrder() {
    fetchMock.mockImplementation(function createFreshMessagesResponse() {
      return Promise.resolve(createMessagesSseResponse(createTextEvents()));
    });
    vi.stubGlobal("fetch", fetchMock);

    const fixtures = [
      createSingleToolConversation(),
      createAdjacentUserConversation(),
      createToolResultThenSteerConversation(),
    ];
    const expectedRoles = [
      ["user", "assistant", "user"],
      ["user", "assistant", "user", "user"],
      ["user", "assistant", "user", "user"],
    ];

    for (const fixture of fixtures) await createSampler().sample(migrateFixture(fixture), [], {});

    const actualRoles = fetchMock.mock.calls.map(function readRoles(call) {
      const [, init] = call as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string }> };
      return body.messages.map(function getRole(message) { return message.role; });
    });
    expect(actualRoles).toEqual(expectedRoles);
  });

  it.todo("Stage 1 接入 canonical validator 后，本地拒绝缺失或重复 tool result ID");

  it("使用 auth token 时发送 Bearer 认证而不是 x-api-key", async function usesBearerAuthentication() {
    fetchMock.mockResolvedValue(createMessagesSseResponse(createTextEvents()));
    vi.stubGlobal("fetch", fetchMock);

    await createSampler("bearer").sample([createAgentTextMessage("user", "测试")], [], {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-secret");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("将 429 与调用方取消映射为稳定边界", async function keepsErrorAndAbortBoundaries() {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"private detail"}}', { status: 429, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSampler().sample([createAgentTextMessage("user", "测试")], [], {})).rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", providerHttpStatus: 429 } satisfies Partial<AgentSampleError>);

    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new Error("aborted"));
    await expect(createSampler().sample([createAgentTextMessage("user", "测试")], [], { signal: controller.signal })).rejects.toThrow("aborted");
  });
});
