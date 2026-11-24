/** 数据化预设的 wire 保持与新模型声明的配置、冻结、factory 离线贯通示例。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompatibilityPreset, ProviderRouteProfile, ProtocolProfile } from "../../src/runtime/provider/api-protocol";
import type { RuntimePorts } from "../../src/runtime/ports";
import type { AgentMessage } from "../../src/internal/types/agent-message";
import { resolveAutopilotSettings } from "../../src/runtime/config/autopilot-settings";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import { createDefaultModelSamplerFactory } from "../../src/runtime/provider/default-model-sampler-factory";
import { createOpenAiChatCompletionsRequest } from "../../src/runtime/provider/openai-chat-completions-adapter";
import { createOpenAiResponsesRequest } from "../../src/runtime/provider/openai-responses-adapter";

const user: AgentMessage = { role: "user", content: [{ type: "text", text: "执行" }] };
const chatProfile = { apiProtocol: "openai-chat-completions" as const, assistantToolCallContent: "empty-string" as const, supportsReasoningContent: false, supportsUsageInStreaming: false };

/** 生成协议终态，所有请求均由 fetch stub 截获。 */
function response(apiProtocol: ProviderRouteProfile["apiProtocol"]): Response {
  if (apiProtocol === "openai-chat-completions") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "完成" }] }] } })}\n\n`);
}

/** 以正常多模型数组示范现有用户级配置，两个模型各自拥有独立 id 和能力对象。 */
function customRoute(apiProtocol: "openai-responses" | "openai-chat-completions"): ProviderRouteProfile {
  const modelProfile: ProtocolProfile = apiProtocol === "openai-responses"
    ? { apiProtocol, reasoningReplay: "content" }
    : { ...chatProfile, assistantToolCallContent: "null", supportsReasoningContent: true, supportsUsageInStreaming: true };
  const routeProfile: ProtocolProfile = apiProtocol === "openai-responses" ? { apiProtocol, reasoningReplay: "none" } : chatProfile;
  return {
    id: "new-vendor", apiProtocol, compatibilityPreset: "generic", baseUrl: "https://offline.invalid/v1", credentialRef: { provider: "new-vendor", key: "offline" }, protocolProfile: routeProfile,
    models: [
      { id: "new-model-a", contextWindowTokens: 240_000, capabilities: { supportedReasoningEfforts: ["low", "xhigh"], defaultReasoningEffort: "xhigh", inputModalities: ["text", "image"], supportsToolCalls: true, maxOutputTokens: 40_000 }, protocolProfile: modelProfile },
      { id: "new-model-b", capabilities: { supportedReasoningEfforts: [], inputModalities: ["text"], supportsToolCalls: true, maxOutputTokens: 4_096 } },
    ],
  };
}

describe("preset policy and configured model wire", function suite() {
  afterEach(function cleanup() { vi.unstubAllGlobals(); });

  it.each([undefined, "openai", "deepseek", "generic"] as const)("Chat %s 的 token、采样和 thinking 策略保留", function chat(compatibilityPreset) {
    for (const reasoningEffort of ["none", "high"] as const) {
      for (const forced of [false, true]) {
        const body = createOpenAiChatCompletionsRequest({ model: "wire-fixture", compatibilityPreset, messages: [user], tools: [], maxTokens: 123, protocolProfile: chatProfile, sampleOptions: { reasoningEffort, thinking: "enabled", temperature: 0.7, topP: 0.8, ...(forced ? { toolChoice: { name: "finish" } } : {}) } });
        expect(body).toHaveProperty(compatibilityPreset === "openai" ? "max_completion_tokens" : "max_tokens", 123);
        expect(body).toHaveProperty("reasoning_effort", reasoningEffort);
        if (compatibilityPreset === "openai") {
          expect(body).not.toHaveProperty("thinking");
          if (reasoningEffort === "none") expect(body).toMatchObject({ temperature: 0.7, top_p: 0.8 });
          else { expect(body).not.toHaveProperty("temperature"); expect(body).not.toHaveProperty("top_p"); }
        } else {
          expect(body).toHaveProperty("thinking", { type: "enabled" });
          if (compatibilityPreset === "generic") expect(body).not.toHaveProperty("temperature");
          else expect(body).toHaveProperty("temperature", forced ? 0 : 0.7);
          expect(body).not.toHaveProperty("top_p");
        }
      }
    }
    const legacyTopP = createOpenAiChatCompletionsRequest({ model: "wire-fixture", compatibilityPreset, messages: [user], tools: [], maxTokens: 123, protocolProfile: chatProfile, sampleOptions: { topP: 0.8 } });
    if (compatibilityPreset === undefined) expect(legacyTopP).toHaveProperty("top_p", 0.8);
    else expect(legacyTopP).not.toHaveProperty("top_p");
  });

  it.each([undefined, "openai", "deepseek", "generic"] as const)("Responses %s 保留可选采样字段条件", function responses(compatibilityPreset?: CompatibilityPreset) {
    for (const reasoningEffort of ["none", "high"] as const) {
      const body = createOpenAiResponsesRequest({ routeId: "wire-fixture", compatibilityPreset, sampleOptions: { model: "custom", reasoningEffort, temperature: 0.7, topP: 0.8 }, messages: [user], tools: [] });
      if (compatibilityPreset === "openai" && reasoningEffort === "none") expect(body).toMatchObject({ temperature: 0.7, top_p: 0.8 });
      else { expect(body).not.toHaveProperty("temperature"); expect(body).not.toHaveProperty("top_p"); }
    }
  });

  it.each(["openai-responses", "openai-chat-completions"] as const)("%s 新厂商两模型通过既有配置、冻结和 factory 到达 wire", async function configured(apiProtocol) {
    const config = customRoute(apiProtocol);
    const settings = resolveAutopilotSettings([{ scope: "user", value: { model: "new-vendor/new-model-a", providerRoutes: { "new-vendor": config } } }]);
    expect(settings.diagnostics).toEqual([]);
    expect(settings.providerRoutes[config.id].models.map(function id(model) { return model.id; })).toEqual(["new-model-a", "new-model-b"]);
    const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
    const frozen = resolver.freezeProviderConfig({ modelRef: settings.modelRef }, { providerSettings: { routes: settings.providerRoutes } });
    expect(frozen).toMatchObject({ apiProtocol, compatibilityPreset: "generic", sampleOptions: { model: "new-model-a", reasoningEffort: "xhigh" }, contextWindowTokens: 240_000, maxOutputTokens: 40_000, supportsImageInput: true, protocolProfile: config.models[0].protocolProfile });
    const nextRoute: ProviderRouteProfile = { ...config, models: [{ id: "new-model-a", capabilities: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", maxOutputTokens: 1_000 } }, config.models[1]] };
    const next = resolver.freezeProviderConfig({ modelRef: settings.modelRef }, { providerSettings: { routes: { [config.id]: nextRoute } } });
    expect(next).toMatchObject({ sampleOptions: { reasoningEffort: "low" }, maxOutputTokens: 1_000, supportsImageInput: false, protocolProfile: config.protocolProfile });
    const fetchMock = vi.fn(async function localResponse() { return response(apiProtocol); });
    vi.stubGlobal("fetch", fetchMock);
    const sampler = createDefaultModelSamplerFactory().create({ ref: settings.modelRef!, credential: { apiKey: "offline-placeholder" }, providerConfig: frozen });
    const imageId = "12345678-1234-1234-1234-123456789012";
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image-ref", id: imageId, sha256: "a".repeat(64), width: 10, height: 10 }] }];
    const sampled = await sampler.sample(messages, [{ type: "function", function: { name: "inspect", description: "inspect", parameters: { type: "object" } } }], { maxTokens: 90_000, imageData: { [imageId]: { mimeType: "image/png", data: "offline-image" } } });
    expect(sampled.content).toBe("完成");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(request.model).toBe("new-model-a");
    if (apiProtocol === "openai-responses") {
      expect(request).toMatchObject({ reasoning: { effort: "xhigh" }, max_output_tokens: 40_000, tools: [{ type: "function", name: "inspect", strict: false }] });
      expect(request.input[0].content[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,offline-image" });
      expect(request).not.toHaveProperty("store"); expect(request).not.toHaveProperty("include");
    } else {
      expect(request).toMatchObject({ reasoning_effort: "xhigh", max_tokens: 40_000, stream_options: { include_usage: true } });
      expect(request.messages[0].content[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,offline-image" } });
      expect(request).not.toHaveProperty("thinking"); expect(request).not.toHaveProperty("temperature");
    }
    const second = resolver.freezeProviderConfig({ modelRef: { provider: config.id, modelId: "new-model-b" } }, { providerSettings: { routes: settings.providerRoutes } });
    expect(second).toMatchObject({ sampleOptions: { model: "new-model-b" }, maxOutputTokens: 4_096, supportsImageInput: false, protocolProfile: config.protocolProfile });
    expect(second?.sampleOptions).not.toHaveProperty("reasoningEffort");
  });
});
