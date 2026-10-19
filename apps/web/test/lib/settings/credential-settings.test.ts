/** Web 设置 DTO 测试：不加载 Stage5 前仍陈旧的 Adapter dist，只验证浏览器输入边界。 */
import { describe, expect, it } from "vitest";
import { parseCredentialSettingsInput } from "@/lib/settings/credential-settings";

describe("credential settings DTO", function suite() {
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
