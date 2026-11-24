/** 模型数据化回归，覆盖精确目录、旧目录视图、覆盖硬约束与 profile 选择。 */
import { describe, expect, it } from "vitest";
import type { CompatibilityPreset, ProviderRouteProfile } from "../../src/runtime/provider/api-protocol";
import { resolveAutopilotSettings } from "../../src/runtime/config/autopilot-settings";
import { getModelCapability, getModelCapabilityForRef, listModelCapabilities, resolveRouteModelCapability, resolveRouteProtocolProfile } from "../../src/runtime/provider/model-capability-catalog";

/** 构造任意路由身份，确保目录命中只由显式预设和精确模型决定。 */
function route(modelId: string, compatibilityPreset?: CompatibilityPreset, apiProtocol: ProviderRouteProfile["apiProtocol"] = "openai-responses"): ProviderRouteProfile {
  return { id: "catalog-fixture", apiProtocol, compatibilityPreset, baseUrl: "https://offline.invalid/v1", credentialRef: { provider: "catalog-fixture", key: "offline" }, models: [{ id: modelId }] };
}

describe("declarative model catalog", function suite() {
  it.each([
    ["gpt-6-astra", false, false], ["gpt-6.1-sol", false, false], ["gpt-6.1-terra", true, false], ["gpt-6-sol", true, true], ["gpt-6-luna", true, true],
  ] as const)("%s 保留 Responses 与 Chat 的逐协议差异", function openai(modelId, supportsNone, chatTools) {
    const config = route(modelId, "openai");
    expect(resolveRouteModelCapability(config, modelId)).toEqual({
      inputModalities: ["text", "image"], supportsToolCalls: true,
      supportedReasoningEfforts: [...(supportsNone ? ["none"] : []), "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium", contextWindowTokens: 1_050_000, maxOutputTokens: 128_000,
    });
    const chat = { ...config, apiProtocol: "openai-chat-completions" as const };
    expect(resolveRouteModelCapability(chat, modelId)).toMatchObject({ supportsToolCalls: chatTools, supportedReasoningEfforts: chatTools ? ["none"] : [], defaultReasoningEffort: chatTools ? "none" : undefined });
    expect(resolveRouteModelCapability({ ...chat, models: [{ id: modelId, capabilities: { supportsToolCalls: true } }] }, modelId).supportsToolCalls).toBe(chatTools);
    expect(function rejectsOutput() { resolveRouteModelCapability({ ...config, models: [{ id: modelId, capabilities: { maxOutputTokens: 128_001 } }] }, modelId); }).toThrow();
    if (!supportsNone) expect(function rejectsNone() { resolveRouteModelCapability({ ...config, models: [{ id: modelId, capabilities: { supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" } }] }, modelId); }).toThrow();
  });

  it.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"])("%s 保留精确别名与四档协议能力", function deepseek(modelId) {
    for (const apiProtocol of ["openai-responses", "openai-chat-completions"] as const) {
      expect(resolveRouteModelCapability(route(modelId, "deepseek", apiProtocol), modelId)).toEqual({
        inputModalities: modelId === "deepseek-v4-pro" ? ["text"] : ["text", "image"], supportsToolCalls: true,
        supportedReasoningEfforts: ["none", "low", "high", "max"], defaultReasoningEffort: "high", contextWindowTokens: 1_000_000, maxOutputTokens: 384_000,
      });
    }
  });

  it("旧公开目录、别名和 Anthropic 视图保持原字段与差异", function legacy() {
    expect(listModelCapabilities()).toEqual([
      { provider: "deepseek", modelId: "deepseek-v4-flash", inputModalities: ["text", "image"], supportsToolCalls: true, supportedReasoningEfforts: ["none", "low", "high", "max"], contextWindowTokens: 1_000_000, maxOutputTokens: 384_000, promptCacheMode: "server-auto" },
      { provider: "deepseek", modelId: "deepseek-v4-pro", inputModalities: ["text"], supportsToolCalls: true, supportedReasoningEfforts: ["none", "high", "max"], contextWindowTokens: 1_000_000, maxOutputTokens: 384_000, promptCacheMode: "server-auto" },
      { provider: "ali", modelId: "qwen3-vl-flash", inputModalities: ["text", "image"], supportsToolCalls: true, supportedReasoningEfforts: [], contextWindowTokens: 128_000, maxOutputTokens: 8_192, promptCacheMode: "none" },
    ]);
    expect(getModelCapability("openai", "gpt-6-luna")).toBeUndefined();
    expect(getModelCapabilityForRef({ provider: "firstParty", modelId: "deepseek-flash" })).toBe(getModelCapability("deepseek", "deepseek-v4-flash"));
    const config = { ...route("deepseek-v4-pro", undefined, "anthropic-messages"), id: "deepseek" };
    expect(resolveRouteModelCapability(config, "deepseek-v4-pro").supportedReasoningEfforts).toEqual(["none", "low", "medium", "high", "max"]);
    expect(resolveRouteModelCapability({ ...config, apiProtocol: "openai-chat-completions" }, "deepseek-v4-pro").supportedReasoningEfforts).toEqual(["none", "high", "max"]);
  });

  it.each([["openai", "gpt-6-luna-future"], ["deepseek", "deepseek-v4-pro-future"], ["generic", "gpt-6-luna"]] as const)("%s/%s 不由名称推断能力", function unknown(preset, modelId) {
    expect(resolveRouteModelCapability(route(modelId, preset), modelId)).toEqual({ inputModalities: ["text"], supportsToolCalls: true });
  });

  it("已知模型覆盖保留硬约束和 generic 独立声明", function overrides() {
    const pro = route("deepseek-v4-pro", "deepseek");
    const images = { ...pro, models: [{ id: "deepseek-v4-pro", capabilities: { inputModalities: ["text", "image"] as const } }] };
    expect(function rejectsImage() { resolveRouteModelCapability(images, "deepseek-v4-pro"); }).toThrow();
    expect(resolveRouteModelCapability({ ...images, compatibilityPreset: "generic" }, "deepseek-v4-pro").inputModalities).toContain("image");
    const chat = { ...route("gpt-6-luna", "openai", "openai-chat-completions"), models: [{ id: "gpt-6-luna", capabilities: { supportedReasoningEfforts: ["high"] as const, defaultReasoningEffort: "high" as const } }] };
    expect(resolveRouteModelCapability(chat, "gpt-6-luna")).toMatchObject({ supportsToolCalls: true, supportedReasoningEfforts: [], defaultReasoningEffort: undefined });
    const custom = { ...route("future", "deepseek"), models: [{ id: "future", capabilities: { supportedReasoningEfforts: ["medium"] as const } }] };
    expect(function rejectsProtocolEffort() { resolveRouteModelCapability(custom, "future"); }).toThrow();
    expect(resolveRouteModelCapability({ ...custom, compatibilityPreset: "generic" }, "future").supportedReasoningEfforts).toEqual(["medium"]);
  });

  it("预设 profile 缺省与完整对象优先级保留", function profiles() {
    for (const [preset, reasoningReplay] of [["openai", "encrypted"], ["deepseek", "content"], ["generic", "none"], [undefined, "none"]] as const) {
      expect(resolveRouteProtocolProfile(route("custom", preset), "custom")).toEqual({ apiProtocol: "openai-responses", reasoningReplay });
    }
    const config: ProviderRouteProfile = { ...route("custom", "generic"), protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "encrypted" }, models: [{ id: "custom", protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "content" } }] };
    expect(resolveRouteProtocolProfile(config, "custom")).toEqual({ apiProtocol: "openai-responses", reasoningReplay: "content" });
    expect(resolveRouteProtocolProfile({ ...config, models: [{ id: "custom" }] }, "custom")).toEqual(config.protocolProfile);
    for (const preset of ["openai", "deepseek"] as const) expect(function rejectsReplay() { resolveRouteProtocolProfile({ ...config, compatibilityPreset: preset, models: [{ id: "custom" }], protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "none" } }, "custom"); }).toThrow();
    const chat = { ...route("custom", "generic", "openai-chat-completions"), protocolProfile: { apiProtocol: "openai-chat-completions" as const, assistantToolCallContent: "null" as const, supportsReasoningContent: true, supportsUsageInStreaming: false } };
    expect(resolveRouteProtocolProfile(chat, "custom")).toBe(chat.protocolProfile);
  });

  it.each(["future-vendor", "__proto__", "toString"])("配置只接受已实现预设 %s", function presetValidation(compatibilityPreset) {
    const config = { ...route("custom"), compatibilityPreset };
    expect(resolveAutopilotSettings([{ scope: "user", value: { providerRoutes: { [config.id]: config } } }]).diagnostics).toContainEqual(expect.objectContaining({ code: "SETTINGS_PROVIDER_ROUTE_INVALID" }));
  });
});
