/** 本轮模型预算、实际推理用量与受控预览的执行者回归。 */
import { afterEach, expect, it, vi } from "vitest";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import { createOpenAiResponsesSampler } from "../../src/runtime/provider/openai-responses-adapter";
import { buildTurnUsageSummary, projectPublicTurnUsageSummary } from "../../src/internal/kernel/turn-usage";
import type { RuntimePorts } from "../../src/runtime/ports";
afterEach(function restore() { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("freezes capacity default and explicit cap without effort budgets", function budgets() {
  const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
  const route = { id: "test", apiProtocol: "openai-responses" as const, compatibilityPreset: "openai" as const, models: [{ id: "gpt-6.1-sol" }] };
  for (const [requested, expected] of [[undefined, 128000], [1000, 1000], [200000, 128000]] as const) {
    const config = resolver.freezeProviderConfig({ modelRef: { provider: "test", modelId: "gpt-6.1-sol" }, reasoningProfile: { effort: "xhigh", ...(requested ? { maxTokens: requested } : {}) } }, { providerSettings: { routes: { test: route } } });
    expect(config?.sampleOptions?.maxTokens).toBe(expected);
    expect(config?.maxOutputTokens).toBe(128000);
  }
});

it("sends capability budget, preserves actual reasoning and explicit timeout", async function wire() {
  const response = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } } } };
  vi.stubGlobal("fetch", vi.fn(async function respond() { return new Response('data: ' + JSON.stringify(response) + '\n\n'); }));
  const input = { routeId: "test", apiKey: "fixture", baseUrl: "https://fixture.test/v1", maxOutputTokens: 128000, sampleOptions: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" as const } };
  const sampled = await createOpenAiResponsesSampler(input).sample([], [], {});
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).max_output_tokens).toBe(128000);
  expect(sampled.usage).toEqual({ inputTokens: 10, outputTokens: 20, contextTokens: 30, reasoningTokens: 12 });
  vi.stubGlobal("fetch", vi.fn(function pending(_url, options) { return new Promise(function wait(_resolve, reject) { options.signal.addEventListener("abort", function cancel() { reject(new DOMException("Aborted", "AbortError")); }); }); }));
  vi.useFakeTimers();
  const pending = createOpenAiResponsesSampler({ ...input, timeoutMs: 25 }).sample([], [], {});
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(25); await rejected;
});

it("projects reasoning only with full provider coverage and never adds it to total", function usage() {
  const runtimeBudget = { startedAt: 1, updatedAt: 2, totalTokens: 30, inputTokens: 10, outputTokens: 20, reasoningTokens: 12, reasoningReportedOutputTokens: 20 };
  const view = buildTurnUsageSummary({ turnId: "turn", runtimeBudget });
  expect(view).toMatchObject({ totalTokens: 30, reasoningTokens: 12 });
  expect(projectPublicTurnUsageSummary(view)).toEqual(view);
  expect(buildTurnUsageSummary({ turnId: "turn", runtimeBudget: { ...runtimeBudget, reasoningReportedOutputTokens: 19 } })).not.toHaveProperty("reasoningTokens");
  expect(projectPublicTurnUsageSummary({ ...view!, reasoningTokens: 21 })).toBeNull();
});

it("preserves Anthropic effort semantics and generic/DeepSeek capability defaults", async function protocolCompatibility() {
  const { createAnthropicMessagesRequest } = await import("../../src/runtime/provider/anthropic-messages-adapter");
  const { resolveContextBudgetBounds } = await import("../../src/runtime/application/turn/turn-compaction-coordinator");
  const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
  const routes = [
    { id: "anthropic", apiProtocol: "anthropic-messages" as const, models: [{ id: "custom" }], expected: 8192, effort: "max" as const },
    { id: "generic", apiProtocol: "openai-chat-completions" as const, compatibilityPreset: "generic" as const, models: [{ id: "custom", capabilities: { maxOutputTokens: 16000, supportedReasoningEfforts: ["none" as const] } }], expected: 16000, effort: "none" as const },
    { id: "deepseek", apiProtocol: "openai-responses" as const, compatibilityPreset: "deepseek" as const, models: [{ id: "deepseek-flash" }], expected: 384000, effort: "max" as const },
  ];
  for (const route of routes) {
    const modelId = route.models[0].id;
    const config = resolver.freezeProviderConfig({ modelRef: { provider: route.id, modelId }, reasoningProfile: { effort: route.effort } }, { providerSettings: { routes: { [route.id]: route } } });
    expect(config?.sampleOptions?.maxTokens).toBe(route.expected);
    expect(resolveContextBudgetBounds(config).outputReserveTokens).toBe(route.expected);
    expect(config?.sampleOptions?.reasoningEffort).toBe(route.effort);
    if (route.apiProtocol === "anthropic-messages") {
      const body = createAnthropicMessagesRequest(modelId, [], [], config!.sampleOptions!, route.expected, false);
      expect(body.max_tokens).toBe(8192); expect(body.output_config?.effort).toBe("max");
      expect(body.thinking).toEqual({ type: "adaptive" });
    }
  }
});

it("Chat compatible sampler preserves reported reasoning detail without fabricating unsupported detail", async function chatUsage() {
  const { createOpenAiChatCompletionsSampler } = await import("../../src/runtime/provider/openai-chat-completions-adapter");
  for (const reported of [5, 20]) {
    vi.stubGlobal("fetch", vi.fn(async function respond() {
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: reported } } }) + '\n\ndata: [DONE]\n\n');
    }));
    const sampler = createOpenAiChatCompletionsSampler({ baseUrl: "https://fixture.test/v1", apiKey: "fixture", maxOutputTokens: 16000, sampleOptions: { model: "custom" }, protocolProfile: { apiProtocol: "openai-chat-completions", assistantToolCallContent: "empty-string", supportsReasoningContent: false, supportsUsageInStreaming: true } });
    const sampled = await sampler.sample([], [], {});
    expect(sampled.usage?.reasoningTokens).toBe(reported === 5 ? 5 : undefined);
    expect(sampled.usage?.contextTokens).toBe(20);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).max_tokens).toBe(16000);
  }
});
