/**
 * Stage2 Node 装配契约：验证 DS 主凭据继承/隔离与 RAG 四角色独立解析。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodeCapabilityLoader } from "../src/node/create-node-capability-loader";
import { createNodeRagRuntime } from "../src/node/rag/node-rag-runtime";

const temporaryRoots: string[] = [];

/** 创建隔离 User settings 文件并登记清理。 */
async function createUserSettings(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage2-node-runtime-"));
  temporaryRoots.push(root);
  const file = path.join(root, "settings.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

afterEach(async function cleanup() {
  await Promise.all(temporaryRoots.splice(0).map(function remove(root) { return rm(root, { recursive: true, force: true }); }));
});

/** 创建满足 loader 的最小安全 settings 快照。 */
function settings(baseUrl: string, userPath: string) {
  const value = {
    modelRef: { provider: "firstParty", modelId: "deepseek-v4-flash" }, availableModels: [], modelCandidates: [], modelOverrides: {}, providerRoutes: {}, diagnostics: [], rag: {},
    firstParty: { baseUrl, credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" } },
  };
  return {
    load: function load() { return { settings: value, paths: { user: userPath, project: "missing", local: "missing" } }; },
    loadUser: function loadUser() { return { settings: value, paths: { user: userPath } }; },
  };
}

describe("Stage2 Node runtime assembly", function stage2NodeRuntimeSuite() {
  it("仅官方 DS 主连接继承主 Key 装配 Anthropic Search", async function inheritsOnlyOfficialDeepSeekCredential() {
    const userPath = await createUserSettings({ env: { ANTHROPIC_AUTH_TOKEN: "fixture-main-key" } });
    const request = vi.fn(async function respond() { return Response.json({ content: [{ type: "web_search_tool_result", tool_use_id: "t", content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }] }, { type: "text", text: "answer" }] }); });
    const official = createNodeCapabilityLoader({ settingsLoader: settings("https://api.deepseek.com/anthropic", userPath) as any, webSearchFetch: request as typeof fetch });
    await (await official.loadChatWeb({ retrievalMode: "web" }))?.search?.search({ query: "public" });
    expect(request.mock.calls[0][0]).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer fixture-main-key" });

    request.mockClear();
    const gateway = createNodeCapabilityLoader({ settingsLoader: settings("https://gateway.fixture/anthropic", userPath) as any, webSearchFetch: request as typeof fetch });
    expect((await gateway.loadChatWeb({ retrievalMode: "web" }))?.search).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("显式非 DS Search 使用自身 endpoint、模型和 Key", async function usesConfiguredCompatibleSearchConnection() {
    const userPath = await createUserSettings({ env: { SEARCH_KEY: "fixture-search-key" } });
    const request = vi.fn(async function respond() { return Response.json({ object: "response", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }] }); });
    const loader = settings("https://gateway.fixture/anthropic", userPath) as any;
    const baseLoad = loader.load;
    loader.load = function load() { const loaded = baseLoad(); return { ...loaded, settings: { ...loaded.settings, webSearch: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "SEARCH_KEY" } } } }; };
    const runtime = createNodeCapabilityLoader({ settingsLoader: loader, webSearchFetch: request as typeof fetch });
    await (await runtime.loadWeb("C:/trusted"))?.search?.search({ query: "public" });
    expect(request.mock.calls[0][0]).toBe("https://search.fixture/v1/responses");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ model: "search-model" });
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer fixture-search-key" });
  });

  it("四个 RAG 角色使用各自固定 Key 且不跨角色拼接", async function isolatesRagRoleCredentials() {
    const userPath = await createUserSettings({ env: {
      RAG_TEXT_RERANK_API_KEY: "text-rerank-key", RAG_VISION_RERANK_API_KEY: "vision-rerank-key",
      RAG_TEXT_EMBEDDING_API_KEY: "text-embedding-key", RAG_MULTIMODAL_EMBEDDING_API_KEY: "multimodal-embedding-key",
    } });
    const rag = {
      textRerank: { provider: "bailian" as const, baseUrl: "https://text-rerank.fixture", model: "text-rerank", credentialRef: { provider: "rag-textRerank", key: "RAG_TEXT_RERANK_API_KEY" } },
      visionRerank: { provider: "bailian" as const, baseUrl: "https://vision-rerank.fixture", model: "vision-rerank", credentialRef: { provider: "rag-visionRerank", key: "RAG_VISION_RERANK_API_KEY" } },
      textEmbedding: { provider: "openai-compatible" as const, baseUrl: "https://text-embedding.fixture/v1", model: "text-embedding", dimension: 1024, credentialRef: { provider: "rag-textEmbedding", key: "RAG_TEXT_EMBEDDING_API_KEY" } },
      multimodalEmbedding: { provider: "dashscope" as const, baseUrl: "https://multimodal-embedding.fixture", model: "multimodal-embedding", dimension: 1152, credentialRef: { provider: "rag-multimodalEmbedding", key: "RAG_MULTIMODAL_EMBEDDING_API_KEY" } },
    };
    const runtime = createNodeRagRuntime({ settings: { rag }, userSettingsPath: userPath, env: {} });
    await expect(runtime.rerank.resolveApiKey("text")).resolves.toBe("text-rerank-key");
    await expect(runtime.rerank.resolveApiKey("vision")).resolves.toBe("vision-rerank-key");
    await expect(runtime.embedding.text?.resolveApiKey()).resolves.toBe("text-embedding-key");
    await expect(runtime.embedding.multimodal?.resolveApiKey()).resolves.toBe("multimodal-embedding-key");
    expect(runtime.rerank.defaultPolicy.text?.baseUrl).not.toBe(runtime.rerank.defaultPolicy.vision?.baseUrl);
  });

  it("角色完全缺省时才采用完整旧环境回退", async function usesCompleteLegacyRoleFallbacks() {
    const userPath = await createUserSettings({ env: {} });
    const runtime = createNodeRagRuntime({ settings: { rag: {} }, userSettingsPath: userPath, env: {
      RERANK_BASE_URL: "https://rerank.fixture", RERANK_API_KEY: "legacy-rerank", RERANK_TEXT_MODEL: "legacy-text",
      TEXT_EMBEDDING_BASE_URL: "https://embedding.fixture/v1", TEXT_EMBEDDING_MODEL: "legacy-embedding", TEXT_EMBEDDING_API_KEY: "legacy-embedding-key",
      DASHSCOPE_EMBEDDING_URL: "https://multimodal.fixture", TONGYI_EMBEDDING_MODEL: "legacy-multimodal",
    } });
    expect(runtime.rerank.defaultPolicy.text?.model).toBe("legacy-text");
    expect(runtime.rerank.resolveApiKey("text")).toBe("legacy-rerank");
    expect(runtime.rerank.defaultPolicy.vision).toBeUndefined();
    expect(runtime.embedding.text?.dimension).toBe(1024);
    expect(runtime.embedding.multimodal).toBeUndefined();

    const invalidExplicit = createNodeRagRuntime({ settings: { rag: {}, diagnostics: [{ code: "SETTINGS_RAG_CONNECTION_INVALID", field: "rag.textEmbedding" }] }, userSettingsPath: userPath, env: {
      TEXT_EMBEDDING_BASE_URL: "https://embedding.fixture/v1", TEXT_EMBEDDING_MODEL: "legacy-embedding", TEXT_EMBEDDING_API_KEY: "legacy-embedding-key",
    } });
    expect(invalidExplicit.embedding.text).toBeUndefined();
  });
});
