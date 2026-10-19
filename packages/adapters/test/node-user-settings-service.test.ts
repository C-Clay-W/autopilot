/**
 * Node 用户设置分类服务测试：验证主连接迁移、RAG 独立角色和修订冲突。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeUserSettingsService } from "../src/node/settings/node-user-settings-service";

const temporaryRoots: string[] = [];

/** 创建隔离 Home 与 settings 文件路径。 */
function fixture(): { homeDirectory: string; settingsPath: string } {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-user-settings-"));
  temporaryRoots.push(homeDirectory);
  return { homeDirectory, settingsPath: path.join(homeDirectory, ".autopilot", "settings.json") };
}

/** 清理本文件创建的隔离目录。 */
afterEach(function removeFixtures() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node user settings service", function userSettingsServiceSuite() {
  it("用三项主连接启动并迁移旧 route、动态凭据与视觉引用", async function migratesLegacyPrimaryConnection() {
    const { homeDirectory, settingsPath } = fixture();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: "deepseek/deepseek-old",
      visionModel: "legacy-vision/vision-old",
      custom: { keep: true },
      env: { USER_SETTINGS_WEB_MAIN_OLD: "fixture-main", USER_SETTINGS_WEB_VISION_OLD: "fixture-vision" },
      providerRoutes: {
        deepseek: { id: "deepseek", apiProtocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com", credentialRef: { provider: "deepseek", key: "USER_SETTINGS_WEB_MAIN_OLD" }, models: [{ id: "deepseek-old" }] },
        "legacy-vision": { id: "legacy-vision", apiProtocol: "openai-chat-completions", baseUrl: "https://vision.fixture", credentialRef: { provider: "legacy-vision", key: "USER_SETTINGS_WEB_VISION_OLD" }, models: [{ id: "vision-old" }] },
        retained: { id: "retained", apiProtocol: "openai-chat-completions", baseUrl: "https://retained.fixture", credentialRef: { provider: "retained", key: "RETAINED_KEY" }, models: [{ id: "retained-model" }] },
      },
    }));
    const service = createNodeUserSettingsService({ homeDirectory });
    await service.saveMain({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro[1m]", availableModels: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"], effort: "max", compactWindow: 786432 });

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(saved).toMatchObject({ custom: { keep: true }, env: { ANTHROPIC_AUTH_TOKEN: "fixture-main", ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_MODEL: "deepseek-v4-pro[1m]", CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432" }, availableModels: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"] });
    expect(saved.model).toBeUndefined();
    expect(saved.visionModel).toBeUndefined();
    expect(saved.providerRoutes).toEqual({ retained: expect.any(Object) });
    expect(saved.env.USER_SETTINGS_WEB_MAIN_OLD).toBeUndefined();
    expect(saved.env.USER_SETTINGS_WEB_VISION_OLD).toBeUndefined();
  });

  it("旧主凭据不一致时拒绝猜测，显式新 Key 才允许完成迁移", async function rejectsAmbiguousLegacyCredentials() {
    const { homeDirectory, settingsPath } = fixture();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: "legacy/model",
      env: { ANTHROPIC_AUTH_TOKEN: "fixture-first", LEGACY_KEY: "fixture-second" },
      providerRoutes: { legacy: { id: "legacy", apiProtocol: "openai-chat-completions", baseUrl: "https://legacy.fixture", credentialRef: { provider: "legacy", key: "LEGACY_KEY" }, models: [{ id: "model" }] } },
    }));
    const service = createNodeUserSettingsService({ homeDirectory });
    await expect(service.saveMain({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash" })).rejects.toMatchObject({ code: "SETTINGS_MIGRATION_CONFLICT" });
    await service.saveMain({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", apiKey: "fixture-replacement" });
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(saved.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "fixture-replacement" });
    expect(saved.env.LEGACY_KEY).toBeUndefined();
  });

  it("按角色独立保存 RAG 配置，空 Key 仅保留同一连接且状态不回显秘密", async function savesRagRolesIndependently() {
    const { homeDirectory, settingsPath } = fixture();
    const service = createNodeUserSettingsService({ homeDirectory });
    const first = await service.saveRag({
      textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "qwen3.7-text-rerank", apiKey: "fixture-rerank" },
      textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture/v1", model: "text-model", dimension: 1024, apiKey: "fixture-embedding" },
    });
    expect(JSON.stringify(first)).not.toContain("fixture-");
    await service.saveRag({ textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "new-text-model", apiKey: "" } }, first.revision);
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(saved.rag.textRerank.model).toBe("new-text-model");
    expect(saved.rag.textEmbedding.model).toBe("text-model");
    expect(saved.env.RAG_TEXT_RERANK_API_KEY).toBe("fixture-rerank");
    expect(saved.env.RAG_TEXT_EMBEDDING_API_KEY).toBe("fixture-embedding");
    await expect(service.saveRag({ visionRerank: { provider: "bailian", baseUrl: "https://other.fixture", model: "vision-model", apiKey: "" } })).rejects.toMatchObject({ code: "SETTINGS_KEY_REQUIRED" });
  });

  it("修订冲突不覆盖另一分类已经保存的内容", async function rejectsStaleRevision() {
    const { homeDirectory } = fixture();
    const service = createNodeUserSettingsService({ homeDirectory });
    const initialRevision = service.getRevision();
    await service.saveMain({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", apiKey: "fixture-main" }, initialRevision);
    await expect(service.saveRag({ textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "text-model", apiKey: "fixture-rerank" } }, initialRevision)).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
  });

  it("主模型与完整 Search 原子保存且不覆盖既有 RAG 分类", async function savesMainAndSearchWithoutOverwritingRag() {
    const { homeDirectory, settingsPath } = fixture();
    const service = createNodeUserSettingsService({ homeDirectory });
    const rag = await service.saveRag({
      textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture/v1", model: "embed-model", dimension: 1024, apiKey: "fixture-embedding" },
    });
    await service.saveMainCategory({
      main: { baseUrl: "https://custom.fixture/anthropic", model: "custom-model", apiKey: "fixture-main", availableModels: ["custom-model", "custom-fast"], effort: "max", maxOutputTokens: 65536, compactWindow: 786432 },
      search: { enabled: true, useMainKey: false, provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model", apiKey: "fixture-search" },
    }, rag.revision);

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(saved.rag.textEmbedding.model).toBe("embed-model");
    expect(saved.maxOutputTokens).toBe(65536);
    expect(saved.webSearch).toMatchObject({ provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model" });
    const status = service.getStatus();
    expect(status).toMatchObject({
      main: { provider: "custom", model: "custom-model", configured: true, effort: "max", maxOutputTokens: 65536, compactWindow: 786432 },
      search: { provider: "openai-compatible", model: "search-model", enabled: true, configured: true, useMainKey: false },
      rag: { textEmbedding: { model: "embed-model", dimension: 1024, configured: true }, visionRerank: { configured: false } },
    });
    expect(JSON.stringify(status)).not.toContain("fixture-");
  });

  it("DeepSeek 官方主连接复用同一凭据引用并保持 RAG 分类", async function reusesOfficialDeepSeekMainCredential() {
    const { homeDirectory, settingsPath } = fixture();
    const service = createNodeUserSettingsService({ homeDirectory });
    await service.saveRag({ textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "rerank-model", apiKey: "fixture-rerank" } });
    await service.saveMainCategory({
      main: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro[1m]", apiKey: "fixture-main" },
      search: { enabled: true, useMainKey: true, provider: "openai-compatible", baseUrl: "https://ignored.fixture", model: "ignored" },
    });

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(saved.webSearch).toEqual({ provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", credentialRef: { provider: "deepseek", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" } });
    expect(saved.env.USER_SETTINGS_WEB_SEARCH_DEEPSEEK).toBeUndefined();
    expect(service.getStatus().search).toMatchObject({ useMainKey: true, configured: true });
    expect(saved.rag.textRerank.model).toBe("rerank-model");
  });

  it("仅在用户主动刷新时读取 DeepSeek 官方模型目录并在失败时回退维护目录", async function refreshesDeepSeekCatalogWithFallback() {
    const { homeDirectory } = fixture();
    const fetchImpl = async function fetchModels() { return new Response(JSON.stringify({ data: [{ id: "deepseek-live" }, { id: "deepseek-live" }] }), { status: 200, headers: { "content-type": "application/json" } }); } as typeof fetch;
    const service = createNodeUserSettingsService({ homeDirectory, fetchImpl });
    expect(await service.refreshMainModelCatalog()).toEqual({ models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"], source: "maintained" });
    await service.saveMain({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", apiKey: "fixture-main" });
    expect(await service.refreshMainModelCatalog()).toEqual({ models: ["deepseek-live"], source: "official" });

    const fallback = createNodeUserSettingsService({ homeDirectory, fetchImpl: async function unavailable() { return new Response(null, { status: 503 }); } });
    expect(await fallback.refreshMainModelCatalog()).toEqual({ models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"], source: "maintained" });
  });
});
