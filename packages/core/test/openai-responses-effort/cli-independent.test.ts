/** 通过既有 Core runner 加载 CLI Controller 与新 Core 源码，独立核对 effort 菜单。 */
import { describe, expect, it, vi } from "vitest";
import { resolveRouteModelCapability } from "../../src/runtime/provider/model-capability-catalog";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import { createCliController } from "../../../../apps/cli/src/controller";
import { createPlainRenderer } from "../../../../apps/cli/src/renderer";
import type { CliRuntime } from "../../../../apps/cli/src/types";
import type { ProviderRouteProfile } from "../../src/runtime/provider/api-protocol";
import type { RuntimePorts } from "../../src/runtime/ports";

vi.mock("@autopilot-agent/core", async function sourceCore() { return import("../../src/index"); });

/** 以真实能力解析结果构造离线 Controller 宿主。 */
function host(route: ProviderRouteProfile) {
  const modelId = route.models[0].id;
  const capability = resolveRouteModelCapability(route, modelId);
  const session: any = { id: "offline-session", defaultRunConfig: { modelRef: { provider: route.id, modelId } } };
  const runtime = { sessions: {
    /** 读取离线 Session。 */
    async get() { return session; },
    /** 保存后续 Turn 默认值。 */
    async setDefaultRunConfig(_id, config) { session.defaultRunConfig = config; return session; },
  } } as unknown as CliRuntime;
  const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: session.id,
    /** 使用 Core 源码能力生成 CLI 菜单输入。 */
    getRuntimeStatusDefaults() { return { modelRef: session.defaultRunConfig.modelRef, modelCapabilities: [{ provider: route.id, modelId, requestableEfforts: capability.supportedReasoningEfforts ?? [], defaultReasoningEffort: capability.defaultReasoningEffort, reasoningCapabilityUnknown: capability.supportedReasoningEfforts === undefined, supportsToolCalls: capability.supportsToolCalls }] }; },
  });
  return { controller, session, capability };
}

describe("CLI effort independent source", function suite() {
  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "deepseek-flash", "deepseek-v4-pro"])("%s 完整列表默认和设置冻结同源", async function model(modelId) {
    const route: ProviderRouteProfile = { id: "offline", apiProtocol: "openai-responses", compatibilityPreset: modelId.startsWith("gpt") ? "openai" : "deepseek", baseUrl: "https://fixture.invalid", credentialRef: { provider: "offline", key: "offline" }, models: [{ id: modelId }] };
    const { controller, session, capability } = host(route);
    const menu = await controller.dispatch({ type: "open_effort_picker" });
    expect(menu.effortOptions?.map(function value(item) { return item.effort; })).toEqual(capability.supportedReasoningEfforts);
    expect(menu.effortOptions?.find(function selected(item) { return item.selected; })?.effort).toBe(capability.defaultReasoningEffort);
    for (const effort of capability.supportedReasoningEfforts!) {
      expect((await controller.dispatch({ type: "set_effort", effort })).kind).toBe("ok");
      const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
      const frozen = resolver.freezeProviderConfig(session.defaultRunConfig, { providerSettings: { routes: { offline: route } } });
      expect(frozen?.sampleOptions?.reasoningEffort).toBe(effort);
    }
    expect((await controller.dispatch({ type: "set_effort", effort: "ultra" })).kind).toBe("error");
  });
  it.each([undefined, []])("未知或空能力 %s 显示与拒绝设置", async function unknown(efforts) {
    const route: ProviderRouteProfile = { id: "offline", apiProtocol: "openai-responses", baseUrl: "https://fixture.invalid", credentialRef: { provider: "offline", key: "offline" }, models: [{ id: "custom", capabilities: efforts ? { supportedReasoningEfforts: efforts } : undefined }] };
    const { controller } = host(route);
    const menu = await controller.dispatch({ type: "open_effort_picker" });
    expect(menu.effortOptions).toEqual([]);
    expect(menu.lines.join("\n")).toContain(efforts ? "不支持调整" : "能力未知");
    expect((await controller.dispatch({ type: "set_effort", effort: "none" })).kind).toBe("error");
  });
  it("Chat 不支持工具的模型不能通过模型菜单切换", async function chatToolConstraint() {
    const route: ProviderRouteProfile = { id: "offline", apiProtocol: "openai-chat-completions", compatibilityPreset: "openai", baseUrl: "https://fixture.invalid", credentialRef: { provider: "offline", key: "offline" }, models: [{ id: "gpt-6-astra" }] };
    const { controller } = host(route);
    expect((await controller.dispatch({ type: "set_model", modelId: "gpt-6-astra", provider: "offline" })).kind).toBe("error");
  });
});
