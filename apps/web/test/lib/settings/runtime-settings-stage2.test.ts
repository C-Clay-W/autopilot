/**
 * Stage2 Web settings 映射：主连接同时成为 Chat、Work 与 RAG 图片理解的默认视觉连接。
 */
import { describe, expect, it } from "vitest";
import { createSettingsRunConfig } from "@/lib/settings/runtime-settings";

describe("Stage2 runtime settings", function stage2RuntimeSettingsSuite() {
  it("可选 maxTurns 进入新 Turn 的 maxSteps 默认值", function mapsMaxTurnsToSteps() {
    const settings = {
      maxTurns: 500,
      availableModels: [], modelCandidates: [], modelOverrides: {}, firstParty: {}, providerRoutes: {}, rag: {}, sandbox: { allowedDomains: [], deniedRead: [], deniedWrite: [] }, diagnostics: [],
    };
    expect(createSettingsRunConfig(settings).maxSteps).toBe(500);
    expect(createSettingsRunConfig({ ...settings, maxTurns: undefined }).maxSteps).toBeUndefined();
  });
  it("主模型、思考与压缩进入下一 Turn，且未声明旧视觉角色时继承主连接", function inheritsMainConnectionForVision() {
    const runtime = createSettingsRunConfig({
      modelRef: { provider: "firstParty", modelId: "deepseek-v4-pro" }, availableModels: [], modelCandidates: [], modelOverrides: {}, providerRoutes: {}, rag: {}, sandbox: { allowedDomains: [], deniedRead: [], deniedWrite: [] }, diagnostics: [],
      reasoningProfile: { effort: "max" },
      firstParty: { baseUrl: "https://api.deepseek.com/anthropic", credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" }, maxOutputTokens: 65536, compactWindow: 786432, timeoutMs: 120000, thinkingEnabled: true },
    });
    expect(runtime).toMatchObject({ modelRef: { provider: "firstParty", modelId: "deepseek-v4-pro" }, reasoningProfile: { effort: "max" } });
    expect(runtime.providerSettings?.primary).toMatchObject({ apiProtocol: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" });
    expect(runtime.providerSettings?.primary).toMatchObject({ maxOutputTokens: 65536, compactThresholdTokens: 786432, timeoutMs: 120000, thinkingEnabled: true });
    expect(runtime.providerSettings?.visionModelRef).toEqual({ provider: "firstParty", modelId: "deepseek-v4-pro" });
    expect(runtime.providerSettings?.vision).toEqual(runtime.providerSettings?.primary);
  });
});
