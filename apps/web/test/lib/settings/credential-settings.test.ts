/** Web 设置回归：以源码 Adapter 和隔离 Home 验证表单边界与主分类往返，不调用 Provider。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("@autopilot-agent/adapters", async function sourceAdapter() { return await import("../../../../../packages/adapters/src/node/settings/node-user-settings-service"); });
import { createCredentialSettingsService, parseCredentialSettingsInput, parseMainModelCapabilitiesInput } from "@/lib/settings/credential-settings";

describe("credential settings DTO", function suite() {
  it.each(["openai-responses", "openai-chat-completions"])("Web 主分类往返 %s 时保存原协议和模型能力", async function savesRoutedWebDraft(apiProtocol) {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-web-settings-"));
    try {
      const settingsPath = path.join(homeDirectory, ".autopilot", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath));
      const route = { id: "custom", apiProtocol, compatibilityPreset: "generic", baseUrl: "https://main.fixture/v1", credentialRef: { provider: "custom", key: "USER_SETTINGS_MAIN" }, models: [{ id: "model", capabilities: { supportedReasoningEfforts: ["none", "xhigh"], defaultReasoningEffort: "none" } }, { id: "fast", capabilities: { supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" } }] };
      const other = { id: "other", apiProtocol, compatibilityPreset: "generic", baseUrl: "https://other.fixture/v1", credentialRef: { provider: "other", key: "USER_SETTINGS_OTHER" }, models: [{ id: "separate" }] };
      fs.writeFileSync(settingsPath, JSON.stringify({ model: "custom/model", providerRoutes: { custom: route, other }, env: { USER_SETTINGS_MAIN: "fixture-key" }, webSearch: false }));
      const service = createCredentialSettingsService({ homeDirectory, env: { NODE_ENV: "test" } });
      const status = service.getStatus();
      const { configured: mainConfigured, ...main } = status.main;
      const { configured: searchConfigured, ...search } = status.search;
      expect(mainConfigured).toBe(true);
      expect(searchConfigured).toBe(false);
      expect(main.availableModels).toEqual(["model", "fast"]);
      expect(service.getMainModelCapabilities({ apiProtocol, compatibilityPreset: "generic", baseUrl: main.baseUrl, model: main.model })).toEqual({ supportedReasoningEfforts: ["none", "xhigh"], supportsToolCalls: true });
      const result = await service.save({ category: "main", revision: status.revision, main: { ...main, effort: "xhigh" }, search });
      expect(result.main).toMatchObject({ apiProtocol, model: "model", effort: "xhigh", configured: true });
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).providerRoutes.custom).toEqual(route);
      expect(JSON.stringify(result)).not.toContain("fixture-key");
      expect(service.getMainModelCapabilities({ apiProtocol, compatibilityPreset: "generic", baseUrl: main.baseUrl, model: "fast" })).toEqual({ supportedReasoningEfforts: ["low", "high"], supportsToolCalls: true });
      const switched = await service.save({ category: "main", revision: result.revision, main: { ...main, model: "fast", effort: "high" }, search });
      expect(switched.main).toMatchObject({ model: "fast", effort: "high", availableModels: ["model", "fast"] });
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).providerRoutes).toEqual({ custom: route, other });
    } finally {
      fs.rmSync(homeDirectory, { recursive: true, force: true });
    }
  });
  it.each(["openai-responses", "openai-chat-completions"])("接受显式 %s 协议与 none/xhigh 强度", function parsesOpenAiProtocol(apiProtocol) {
    for (const effort of ["none", "xhigh"]) expect(parseCredentialSettingsInput({ category: "main", main: { provider: "custom", apiProtocol, compatibilityPreset: "openai", baseUrl: "https://main.fixture/v1", model: "gpt-6-luna", effort }, search: { enabled: false, useMainKey: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "search" } })).toMatchObject({ main: { apiProtocol, compatibilityPreset: "openai", effort } });
  });

  it("能力预览拒绝未知协议、预设及凭据或模型能力注入", function rejectsCapabilityInjection() {
    const connection = { apiProtocol: "openai-responses", baseUrl: "https://main.fixture/v1", model: "custom" };
    expect(parseMainModelCapabilitiesInput(connection)).toEqual(connection);
    for (const extra of [{ apiProtocol: "unknown" }, { compatibilityPreset: "unknown" }, { credentialRef: { key: "KEY" } }, { apiKey: "fixture-key" }, { capabilities: { supportsToolCalls: true } }]) {
      expect(function reject() { parseMainModelCapabilitiesInput({ ...connection, ...extra }); }).toThrow();
    }
    expect(function mismatchedPreset() { parseMainModelCapabilitiesInput({ ...connection, apiProtocol: "anthropic-messages", compatibilityPreset: "openai" }); }).toThrow();
  });
  it("接受主模型高级字段与完整非 DeepSeek Search 连接", function parsesMainCategory() {
    expect(parseCredentialSettingsInput({
      category: "main",
      main: { provider: "custom", baseUrl: "https://main.fixture/anthropic/", model: "model-pro[1m]", apiKey: "fixture-main", availableModels: ["model-pro[1m]", "model-fast"], effort: "max", maxOutputTokens: 65536, compactWindow: 786432, timeoutMs: 120000, alwaysThinkingEnabled: true },
      search: { enabled: true, useMainKey: false, provider: "openai-compatible", baseUrl: "https://search.fixture/v1/", model: "search-model", apiKey: "fixture-search" },
    })).toMatchObject({
      category: "main",
      main: { provider: "custom", baseUrl: "https://main.fixture/anthropic", model: "model-pro[1m]", effort: "max", maxOutputTokens: 65536, compactWindow: 786432 },
      search: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model" },
    });
  });

  it("接受小米 MiMo 搜索连接", function parsesXiaomiMiMoSearch() {
    expect(parseCredentialSettingsInput({
      category: "main",
      main: { provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "m" },
      search: { enabled: true, useMainKey: false, provider: "xiaomi-mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5", apiKey: "fixture-mimo" },
    })).toMatchObject({ search: { provider: "xiaomi-mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" } });
  });

  it("接受四个固定 RAG 角色并保留 Embedding 维度", function parsesRagCategory() {
    expect(parseCredentialSettingsInput({
      category: "rag",
      rag: {
        textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "text-rerank", apiKey: "fixture-text" },
        visionRerank: null,
        textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture/v1", model: "text-embedding", dimension: 1024, apiKey: "fixture-embedding" },
        multimodalEmbedding: { provider: "dashscope", baseUrl: "https://multimodal.fixture", model: "multi-embedding", dimension: 1152, apiKey: "fixture-multi" },
      },
    })).toMatchObject({ category: "rag", rag: { textEmbedding: { dimension: 1024 }, multimodalEmbedding: { dimension: 1152 }, visionRerank: null } });
  });

  it("拒绝跨分类字段、凭据引用、错误角色供应商和非法维度", function rejectsUnsafeShapes() {
    expect(function crossCategory() { parseCredentialSettingsInput({ category: "rag", main: {}, rag: {} }); }).toThrow();
    expect(function credentialReference() { parseCredentialSettingsInput({ category: "main", main: { provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "m", credentialRef: { key: "x" } }, search: { enabled: false, useMainKey: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "s" } }); }).toThrow();
    expect(function wrongProvider() { parseCredentialSettingsInput({ category: "rag", rag: { textRerank: { provider: "openai-compatible", baseUrl: "https://rerank.fixture", model: "m" } } }); }).toThrow();
    expect(function invalidDimension() { parseCredentialSettingsInput({ category: "rag", rag: { textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture", model: "m", dimension: 0 } } }); }).toThrow();
    expect(function invalidMaxOutputTokens() { parseCredentialSettingsInput({ category: "main", main: { provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "m", maxOutputTokens: 0 }, search: { enabled: false, useMainKey: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "s" } }); }).toThrow();
  });
});
