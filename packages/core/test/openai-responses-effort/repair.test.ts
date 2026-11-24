/** F1–F4 修复的执行者定向回归，仅使用源码能力与离线 CLI 宿主。 */
import { describe, expect, it, vi } from "vitest";
import { resolveRouteModelCapability } from "../../src/runtime/provider/model-capability-catalog";
import { resolveRouteModelSample } from "../../src/runtime/provider/model-sample-resolver";
import { resolveAutopilotSettings } from "../../src/runtime/config/autopilot-settings";
import { createCliController } from "../../../../apps/cli/src/controller";
import { createPlainRenderer } from "../../../../apps/cli/src/renderer";
import { parseArgv } from "../../../../apps/cli/src/parser";
import type { ProviderRouteProfile } from "../../src/runtime/provider/api-protocol";
import type { CliRuntime, CliRuntimeStatusDefaults } from "../../../../apps/cli/src/types";

vi.mock("@autopilot-agent/core", async function sourceCore() { return import("../../src/index"); });

/** 构造无凭据内容的最小测试路由。 */
function route(modelId = "custom"): ProviderRouteProfile {
  return { id: "repair", apiProtocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", credentialRef: { provider: "repair", key: "offline" }, models: [{ id: modelId }] };
}

/** 用真实 Core 能力构造 Controller 输入，完整透传新增工具可用性字段。 */
function host(config: ProviderRouteProfile) {
  const modelId = config.models[0].id;
  const capability = resolveRouteModelCapability(config, modelId);
  let saved = false;
  const session = { id: "offline", defaultRunConfig: { modelRef: { provider: "repair", modelId } } };
  const runtime = { sessions: {
    /** 返回最小离线会话。 */
    async get() { return session; },
    /** 记录是否执行持久化。 */
    async setDefaultRunConfig() { saved = true; return session; },
  } } as unknown as CliRuntime;
  const modelCapability: NonNullable<CliRuntimeStatusDefaults["modelCapabilities"]>[number] = {
    provider: config.id, modelId,
    requestableEfforts: capability.supportedReasoningEfforts ?? [],
    defaultReasoningEffort: capability.defaultReasoningEffort,
    reasoningCapabilityUnknown: capability.supportedReasoningEfforts === undefined,
    supportsToolCalls: capability.supportsToolCalls,
  };
  const controller = createCliController({ runtime, sessionId: session.id, renderer: createPlainRenderer("text"),
    /** 模拟 composition-root 的完整能力结果。 */
    getRuntimeStatusDefaults() { return { modelRef: { provider: config.id, modelId }, modelCapabilities: [modelCapability] }; },
  });
  return { controller, wasSaved: function wasSaved() { return saved; } };
}

describe("r001 repair F1-F4", function suite() {
  it("F1 旧 Chat 五档兼容同源，Responses 与显式 generic Chat 仍能力未知", function legacyEfforts() {
    const legacy = route();
    expect(resolveRouteModelCapability(legacy, "custom").supportedReasoningEfforts).toEqual(["none", "low", "medium", "high", "max"]);
    expect(resolveRouteModelSample(legacy, { provider: legacy.id, modelId: "custom" }, { effort: "high" }).sampleOptions.reasoningEffort).toBe("high");
    for (const config of [{ ...legacy, apiProtocol: "openai-responses" as const }, { ...legacy, compatibilityPreset: "generic" as const }]) {
      expect(resolveRouteModelCapability(config, "custom").supportedReasoningEfforts).toBeUndefined();
      expect(function unknown() { resolveRouteModelSample(config, { provider: config.id, modelId: "custom" }, { effort: "high" }); }).toThrow();
    }
  });
  it("F1 CLI 旧 Chat high 可选且不依赖 reasoning_content", async function legacyMenu() {
    const config = { ...route(), protocolProfile: { apiProtocol: "openai-chat-completions" as const, assistantToolCallContent: "empty-string" as const, supportsReasoningContent: false, supportsUsageInStreaming: false } };
    const { controller } = host(config);
    const menu = await controller.dispatch({ type: "open_effort_picker" });
    expect(menu.effortOptions?.map(function effort(value) { return value.effort; })).toContain("high");
    expect((await controller.dispatch({ type: "set_effort", effort: "high" })).kind).toBe("ok");
  });
  it("F2 Pro 图片冲突拒绝，generic 图片声明保留", function imageConstraint() {
    const config = { ...route("deepseek-v4-pro"), apiProtocol: "openai-responses" as const, compatibilityPreset: "deepseek" as const, models: [{ id: "deepseek-v4-pro", capabilities: { inputModalities: ["text", "image"] as const } }] };
    const settings = resolveAutopilotSettings([{ scope: "user", value: { providerRoutes: { repair: config } } }]);
    expect(settings.diagnostics).toContainEqual(expect.objectContaining({ code: "SETTINGS_PROVIDER_ROUTE_INVALID" }));
    expect(resolveRouteModelCapability({ ...config, compatibilityPreset: "generic" }, "deepseek-v4-pro").inputModalities).toContain("image");
  });
  it("F3 官方上限可收紧或保持，generic 显式上限可独立配置", function outputConstraint() {
    for (const maxOutputTokens of [64_000, 128_000]) {
      const config = { ...route("gpt-6-luna"), compatibilityPreset: "openai" as const, models: [{ id: "gpt-6-luna", capabilities: { maxOutputTokens } }] };
      expect(resolveRouteModelCapability(config, "gpt-6-luna").maxOutputTokens).toBe(maxOutputTokens);
    }
    const config = { ...route("gpt-6-luna"), apiProtocol: "openai-responses" as const, compatibilityPreset: "openai" as const, models: [{ id: "gpt-6-luna", capabilities: { maxOutputTokens: 999_999 } }] };
    expect(resolveAutopilotSettings([{ scope: "user", value: { providerRoutes: { repair: config } } }]).diagnostics).toContainEqual(expect.objectContaining({ code: "SETTINGS_PROVIDER_ROUTE_INVALID" }));
    expect(resolveRouteModelCapability({ ...config, compatibilityPreset: "generic" }, "gpt-6-luna").maxOutputTokens).toBe(999_999);
  });
  it.each([false, true])("F4 CLI 工具可用性 %s 与空 effort 列表独立判断", async function toolAvailability(supportsTools) {
    const config: ProviderRouteProfile = supportsTools
      ? { ...route(), apiProtocol: "openai-responses", models: [{ id: "custom", capabilities: { supportedReasoningEfforts: [], supportsToolCalls: true } }] }
      : { ...route("gpt-6-astra"), compatibilityPreset: "openai" };
    const { controller, wasSaved } = host(config);
    expect((await controller.dispatch({ type: "set_model", provider: config.id, modelId: config.models[0].id })).kind).toBe(supportsTools ? "ok" : "error");
    expect(wasSaved()).toBe(supportsTools);
  });
  it("parser 非法 effort 提示含 xhigh", function parserHint() {
    const parsed = parseArgv(["thread", "create", "--group", "g", "--thread", "t", "--request-id", "r", "--effort", "ultra"]);
    expect(JSON.stringify(parsed)).toContain("none|low|medium|high|xhigh|max");
  });
});
