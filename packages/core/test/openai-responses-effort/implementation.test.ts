/** 本任务执行者的最小离线自检，覆盖能力冻结、wire、SSE 和私有 replay/compact。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAutopilotSettings } from "../../src/runtime/config/autopilot-settings";
import { resolveRouteModelCapability, resolveRouteProtocolProfile } from "../../src/runtime/provider/model-capability-catalog";
import { resolveRouteModelSample, resolveModelSampleOptions } from "../../src/runtime/provider/model-sample-resolver";
import { createOpenAiChatCompletionsRequest } from "../../src/runtime/provider/openai-chat-completions-adapter";
import { createOpenAiResponsesRequest, createOpenAiResponsesSampler } from "../../src/runtime/provider/openai-responses-adapter";
import { createDefaultModelSamplerFactory } from "../../src/runtime/provider/default-model-sampler-factory";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import { compactMessages, estimateMessageTokens } from "../../src/internal/kernel/compact";
import { validateAgentMessages, type AgentMessage } from "../../src/internal/types/agent-message";
import type { ProviderRouteProfile, OpenAiResponsesProtocolProfile } from "../../src/runtime/provider/api-protocol";
import type { RuntimePorts } from "../../src/runtime/ports";

/** 构造任意 route ID 的受信配置，测试不触及用户 settings。 */
function route(preset: "openai" | "deepseek" | "generic" = "openai", model = "gpt-6-luna", protocol: ProviderRouteProfile["apiProtocol"] = "openai-responses"): ProviderRouteProfile {
  return { id: "arbitrary", apiProtocol: protocol, compatibilityPreset: preset, baseUrl: "https://fixture.test/v1", credentialRef: { provider: "arbitrary", key: "fixture" }, models: [{ id: model }] };
}
/** 创建纯本地 SSE，刻意切开每个字符以覆盖 CRLF 与 JSON 跨 chunk。 */
function sse(events: unknown[]): Response {
  const data = events.map(function event(value) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }).join("");
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const character of data) controller.enqueue(encoder.encode(character)); controller.close(); } }));
}
/** 创建完整文本输出项。 */
function message(text = "完成") { return { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }; }
/** 创建完整 function_call，item ID 与 call ID 特意不同。 */
function call(id = "call-1") { return { type: "function_call", id: `item-${id}`, call_id: id, name: "read_file", arguments: '{"path":"a"}', status: "completed" }; }
/** 包装唯一的 completed 协议终态。 */
function completed(output: unknown[], usage?: unknown) { return { type: "response.completed", response: { status: "completed", output, usage } }; }
/** 构造已冻结 sampler 输入。 */
function samplerInput(replay: OpenAiResponsesProtocolProfile["reasoningReplay"] = "encrypted") {
  return { routeId: "arbitrary", baseUrl: "https://fixture.test/v1/", apiKey: "fixture-key", sampleOptions: { model: "gpt-6-luna", reasoningEffort: "high" as const }, protocolProfile: { apiProtocol: "openai-responses" as const, reasoningReplay: replay } };
}
const user: AgentMessage = { role: "user", content: [{ type: "text", text: "执行" }] };

/** 从中立采样结果构造与 Kernel 相同的私有 checkpoint 消息。 */
function assistant(result: Awaited<ReturnType<ReturnType<typeof createOpenAiResponsesSampler>["sample"]>>): AgentMessage {
  return { role: "assistant", content: [...(result.content ? [{ type: "text" as const, text: result.content }] : []), ...result.toolCalls.map(function block(tool) { return { type: "tool-call" as const, id: tool.id, name: tool.name, input: tool.input as Record<string, unknown> }; })], adapterReplayState: result.adapterReplayState };
}
/** 构造已闭合工具结果。 */
function result(id = "call-1"): AgentMessage { return { role: "user", content: [{ type: "tool-result", toolCallId: id, content: [{ type: "text", text: "ok" }], isError: false }] }; }

describe("openai-responses-effort implementation", function suite() {
  afterEach(function cleanup() { vi.unstubAllGlobals(); });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"])("精确目录 %s 与 Chat 工具限制", function capability(model) {
    const responses = route("openai", model);
    const capability = resolveRouteModelCapability(responses, model);
    expect(capability.supportedReasoningEfforts).toContain("xhigh");
    expect(capability.supportedReasoningEfforts?.includes("none")).toBe(!["gpt-6-astra", "gpt-6.1-sol"].includes(model));
    expect(resolveRouteModelSample(responses, { provider: responses.id, modelId: model }).sampleOptions.reasoningEffort).toBe("medium");
    const chat = { ...responses, apiProtocol: "openai-chat-completions" as const };
    if (["gpt-6-sol", "gpt-6-luna"].includes(model)) {
      expect(resolveRouteModelSample(chat, { provider: chat.id, modelId: model }).sampleOptions.reasoningEffort).toBe("none");
      expect(function rejectsHigh() { resolveRouteModelSample(chat, { provider: chat.id, modelId: model }, { effort: "high" }); }).toThrow();
    } else expect(function requiresResponses() { resolveRouteModelSample(chat, { provider: chat.id, modelId: model }); }).toThrow(/Responses/);
  });

  it.each(["deepseek-flash", "deepseek-v4-pro"])("DeepSeek %s 四档与图片能力", function deepseek(model) {
    const config = route("deepseek", model);
    expect(resolveRouteModelCapability(config, model).supportedReasoningEfforts).toEqual(["none", "low", "high", "max"]);
    expect(resolveRouteModelCapability(config, model).inputModalities?.includes("image")).toBe(model === "deepseek-flash");
    expect(function rejectsAlias() { resolveRouteModelSample(config, { provider: config.id, modelId: model }, { effort: "medium" }); }).toThrow();
    const body = createOpenAiResponsesRequest({ ...samplerInput("content"), protocolProfile: resolveRouteProtocolProfile(config, model) as OpenAiResponsesProtocolProfile, messages: [user], tools: [] });
    expect(body).not.toHaveProperty("store"); expect(body).not.toHaveProperty("include");
  });

  it("配置六档、能力优先级、未知模型和 replay 矛盾", function settings() {
    const config = route("generic", "custom");
    const resolved = resolveAutopilotSettings([{ scope: "user", value: { model: "arbitrary/custom", effortLevel: "xhigh", providerRoutes: { arbitrary: { ...config, models: [{ id: "custom", capabilities: { supportedReasoningEfforts: ["none", "xhigh"], defaultReasoningEffort: "xhigh" } }] } } } }]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.reasoningProfile?.effort).toBe("xhigh");
    expect(resolveRouteModelCapability(config, "custom").supportedReasoningEfforts).toBeUndefined();
    expect(resolveRouteModelSample(config, { provider: config.id, modelId: "custom" }).sampleOptions).toEqual({ model: "custom" });
    expect(function unknownEffort() { resolveRouteModelSample(config, { provider: config.id, modelId: "custom" }, { effort: "none" }); }).toThrow();
    expect(function rejectsProfile() { resolveRouteProtocolProfile({ ...route(), protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "content" } }, "gpt-6-luna"); }).toThrow();
    const invalid = resolveAutopilotSettings([{ scope: "user", value: { providerRoutes: { arbitrary: { ...route("openai", "gpt-6-astra"), models: [{ id: "gpt-6-astra", capabilities: { supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" } }] } } } }]);
    expect(invalid.diagnostics[0]?.code).toBe("SETTINGS_PROVIDER_ROUTE_INVALID");
  });

  it("冻结同一能力、profile 与预算，factory 注册 Responses", async function freeze() {
    const config = route();
    const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
    const frozen = resolver.freezeProviderConfig({ modelRef: { provider: config.id, modelId: "gpt-6-luna" }, reasoningProfile: { effort: "xhigh", maxTokens: 777 } }, { providerSettings: { routes: { arbitrary: config } } });
    expect(frozen).toMatchObject({ apiProtocol: "openai-responses", compatibilityPreset: "openai", protocolProfile: { reasoningReplay: "encrypted" }, sampleOptions: { reasoningEffort: "xhigh", maxTokens: 777 }, supportsImageInput: true });
    vi.stubGlobal("fetch", vi.fn(async function respond() { return sse([completed([message()])]); }));
    const sampler = createDefaultModelSamplerFactory().create({ ref: { provider: "arbitrary", modelId: "gpt-6-luna" }, credential: { apiKey: "fixture-key" }, providerConfig: frozen });
    expect((await sampler.sample([user], [], { maxTokens: 200_000 })).content).toBe("完成");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).max_output_tokens).toBe(777);
  });

  it("旧冻结快照回退保留 none/low/medium/xhigh", function legacyOptions() {
    for (const effort of ["none", "low", "medium", "xhigh"] as const) {
      expect(resolveModelSampleOptions({ provider: "legacy", modelId: "fixture" }, { effort })).toMatchObject({ reasoningEffort: effort, thinking: effort === "none" ? "disabled" : "enabled" });
    }
  });

  it("Chat none 与强制工具保留 effort，官方 token 与采样字段合法", function chat() {
    const profile = { apiProtocol: "openai-chat-completions" as const, assistantToolCallContent: "empty-string" as const, supportsReasoningContent: false, supportsUsageInStreaming: false };
    const body = createOpenAiChatCompletionsRequest({ model: "gpt-6-luna", compatibilityPreset: "openai", messages: [user], tools: [], maxTokens: 321, protocolProfile: profile, sampleOptions: { toolChoice: { name: "submit" }, reasoningEffort: "none" } });
    expect(body).toMatchObject({ max_completion_tokens: 321, reasoning_effort: "none", tool_choice: { function: { name: "submit" } } });
    expect(body).not.toHaveProperty("max_tokens"); expect(body).not.toHaveProperty("thinking"); expect(body).not.toHaveProperty("temperature");
  });

  it("Responses 系统、图片、扁平工具与 strict:false", function request() {
    const image = { type: "image-ref" as const, id: "12345678-1234-1234-1234-123456789012", sha256: "a".repeat(64), width: 10, height: 10 };
    const body = createOpenAiResponsesRequest({ ...samplerInput(), messages: [{ role: "system", content: [{ type: "text", text: "规则" }] }, { role: "user", content: [{ type: "text", text: "看图" }, image] }], imageData: { [image.id]: { mimeType: "image/png", data: "fixture" } }, tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }] });
    expect(body).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], tools: [{ type: "function", name: "read_file", strict: false }] });
    expect((body.input as any[])[0].role).toBe("system");
    expect((body.input as any[])[1].content[1].type).toBe("input_image");
  });

  it.each(["encrypted", "content"] as const)("%s SSE 多工具、完整项去重、usage、JSON 恢复与跨绑定隔离", async function replay(strategy) {
    const reasoning = strategy === "encrypted" ? { type: "reasoning", id: "r1", encrypted_content: "opaque-private" } : { type: "reasoning", id: "r1", content: [{ type: "reasoning_text", text: "private-content" }] };
    const items = [reasoning, call(), call("call-2")];
    vi.stubGlobal("fetch", vi.fn(async function respond() { return sse([
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '"a"}' },
      ...items.map(function done(item, output_index) { return { type: "response.output_item.done", output_index, item }; }),
      completed(items, { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 4 } }),
    ]); }));
    const sampled = await createOpenAiResponsesSampler(samplerInput(strategy)).sample([user], [], {});
    expect(sampled.toolCalls.map(function id(tool) { return tool.id; })).toEqual(["call-1", "call-2"]);
    expect(sampled.usage).toEqual({ inputTokens: 12, outputTokens: 8, contextTokens: 20 });
    expect(sampled.reasoningContent).toBeUndefined();
    const messages = validateAgentMessages(JSON.parse(JSON.stringify([user, assistant(sampled), result(), result("call-2")])));
    const body = createOpenAiResponsesRequest({ ...samplerInput(strategy), messages, tools: [] });
    expect((body.input as any[]).filter(function item(value) { return value.type === "function_call"; })).toHaveLength(2);
    expect((body.input as any[])[1]).toEqual(reasoning);
    expect((body.input as any[])[4]).toMatchObject({ type: "function_call_output", call_id: "call-1" });
    for (const change of [{ routeId: "other" }, { baseUrl: "https://other.test/v1" }, { sampleOptions: { model: "other" } }]) {
      const switched = createOpenAiResponsesRequest({ ...samplerInput(strategy), ...change, messages, tools: [] });
      expect(JSON.stringify(switched)).not.toContain(strategy === "encrypted" ? "opaque-private" : "private-content");
    }
    expect(estimateMessageTokens(messages)).toBeGreaterThan(estimateMessageTokens(messages.map(function publicOnly(value) { return { role: value.role, content: value.content }; })));
    const compacted = await compactMessages({ messages: [{ role: "user", content: [{ type: "text", text: "旧历史".repeat(1000) }] }, ...messages], targetTokens: 4000, preserveRecentTurns: 1, trigger: "manual", sampler: { async sample() { return { content: "摘要", toolCalls: [], reasoningSummary: "摘要" }; } } });
    expect(compacted.messages.find(function replayMessage(value) { return value.adapterReplayState; })?.adapterReplayState).toEqual(sampled.adapterReplayState);
  });

  it("文本 delta 与终态不重复展示，无 usage 不伪造", async function textStream() {
    vi.stubGlobal("fetch", vi.fn(async function respond() { return sse([{ type: "response.output_text.delta", output_index: 0, delta: "完成" }, completed([message()])]); }));
    const deltas: string[] = [];
    const sampled = await createOpenAiResponsesSampler(samplerInput()).sample([user], [], {}, function delta(text) { deltas.push(text); });
    expect(deltas).toEqual(["完成"]); expect(sampled.usage).toBeUndefined();
  });

  it.each([
    { events: [{ type: "response.output_text.delta", output_index: 0, delta: "部分" }], code: "STREAM_INCOMPLETE" },
    { events: [{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }], code: "MODEL_OUTPUT_LIMIT" },
    { events: [{ type: "response.failed", response: { status: "failed", error: { code: "bad" } } }], code: "PROVIDER_REQUEST_REJECTED" },
    { events: [completed([{ ...call(), arguments: "{" }])], code: "TOOL_CALL_INVALID_JSON" },
    { events: [{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{" }, completed([call()])], code: "TOOL_CALL_TRUNCATED" },
  ])("终态失败分类 $code", async function failure({ events, code }) {
    vi.stubGlobal("fetch", vi.fn(async function respond() { return sse(events); }));
    await expect(createOpenAiResponsesSampler(samplerInput()).sample([user], [], {})).rejects.toMatchObject({ code });
  });

  it("未知 replay 策略拒绝必要私有状态", async function unsupportedReplay() {
    vi.stubGlobal("fetch", vi.fn(async function respond() { return sse([completed([{ type: "reasoning", encrypted_content: "private" }, message()])]); }));
    await expect(createOpenAiResponsesSampler(samplerInput("none")).sample([user], [], {})).rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED" });
  });
});
