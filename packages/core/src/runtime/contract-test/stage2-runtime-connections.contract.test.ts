/**
 * Stage2 运行连接契约：捕获视觉、Rerank、Embedding 请求并验证索引空间门禁。
 */
import { describe, expect, it, vi } from "vitest";
import { createVisionAnalyzer } from "../provider/vision-analyzer";
import { embedText, getEmbeddingProfile, withEmbeddingRuntime, type EmbeddingRuntime } from "../../internal/lib/embeddings";
import { rerankCandidates } from "../../internal/lib/rerank";
import { assertEmbeddingProfileCompatible } from "../../internal/lib/retrieval-planner";
import { resolveAutopilotSettings } from "../config/autopilot-settings";

/** 创建可捕获文本 Embedding 请求的独立运行连接。 */
function embeddingRuntime(baseUrl: string, apiKey: string, request: ReturnType<typeof vi.fn>): EmbeddingRuntime {
  return { text: {
    provider: "openai-compatible", baseUrl, model: "fixture-embedding", dimension: 2, normalization: "raw", pipelineVersion: "rag-v2",
    resolveApiKey: function resolveKey() { return apiKey; },
    fetch: request as typeof fetch,
  } };
}

describe("Stage2 runtime connections", function stage2RuntimeConnectionsSuite() {
  it("专用 DS Search Key 只生成凭据引用且不泄露原值", function resolvesDedicatedSearchCredential() {
    const resolved = resolveAutopilotSettings([{ scope: "user", value: { env: { USER_SETTINGS_WEB_SEARCH_DEEPSEEK: "fixture-search-secret" } } }]);
    expect(resolved.webSearch?.credentialRef).toEqual({ provider: "deepseek", key: "USER_SETTINGS_WEB_SEARCH_DEEPSEEK" });
    expect(resolved.webSearch).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" });
    expect(JSON.stringify(resolved)).not.toContain("fixture-search-secret");
  });

  it("主 Anthropic 视觉请求继承地址、模型和 Bearer 凭据", async function capturesAnthropicVisionRequest() {
    const request = vi.fn(async function respond() { return Response.json({ content: [{ type: "text", text: "看见图表" }] }); });
    const analyzer = createVisionAnalyzer({ ref: { provider: "firstParty", modelId: "deepseek-v4-pro[1m]" }, apiProtocol: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic", credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" } }, async function credential() { return { apiKey: "fixture-main-key" }; }, request as typeof fetch);
    await expect(analyzer.analyze({ systemPrompt: "system", prompt: "question", imageDataUrl: "data:image/png;base64,YQ==" })).resolves.toBe("看见图表");
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(init.headers).toMatchObject({ authorization: "Bearer fixture-main-key", "anthropic-version": "2023-06-01" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "deepseek-v4-pro[1m]", messages: [{ content: [{ type: "text" }, { type: "image", source: { media_type: "image/png", data: "YQ==" } }] }] });
  });

  it("Embedding 连接按异步操作冻结且空间 ID 不受 Key 变化影响", async function freezesEmbeddingConnection() {
    const firstRequest = vi.fn(async function respond(_input: string | URL | Request, _init?: RequestInit) { return Response.json({ data: [{ embedding: [1, 2] }] }); });
    const secondRequest = vi.fn(async function respond(_input: string | URL | Request, _init?: RequestInit) { return Response.json({ data: [{ embedding: [3, 4] }] }); });
    const first = embeddingRuntime("https://embedding-a.fixture/v1", "key-a", firstRequest);
    const sameSpaceNewKey = embeddingRuntime("https://embedding-a.fixture/v1", "key-b", secondRequest);
    const differentSpace = embeddingRuntime("https://embedding-b.fixture/v1", "key-a", secondRequest);
    const firstId = await withEmbeddingRuntime(first, async function inspectFirst() { return getEmbeddingProfile("text").embeddingSpaceId; });
    const sameId = await withEmbeddingRuntime(sameSpaceNewKey, async function inspectSame() { return getEmbeddingProfile("text").embeddingSpaceId; });
    const differentId = await withEmbeddingRuntime(differentSpace, async function inspectDifferent() { return getEmbeddingProfile("text").embeddingSpaceId; });
    expect(firstId).toBe(sameId);
    expect(firstId).not.toBe(differentId);
    await expect(Promise.all([
      withEmbeddingRuntime(first, async function embedFirst() { return embedText("one"); }),
      withEmbeddingRuntime(sameSpaceNewKey, async function embedSecond() { return embedText("two"); }),
    ])).resolves.toEqual([[1, 2], [3, 4]]);
    expect(firstRequest.mock.calls[0][0]).toBe("https://embedding-a.fixture/v1/embeddings");
    expect(firstRequest.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer key-a" });
    expect(JSON.parse(String(firstRequest.mock.calls[0][1]?.body))).toMatchObject({ model: "fixture-embedding", input: "one", dimensions: 2 });
    expect(secondRequest.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer key-b" });
  });

  it("文本与视觉 Rerank 使用各自地址、模型和 Key", async function isolatesRerankRoles() {
    const requests: Array<{ url: string; authorization: string; model: string }> = [];
    const fetchMock = vi.fn(async function request(url: string | URL | Request, init?: RequestInit) {
      const headers = init?.headers as Record<string, string>;
      requests.push({ url: String(url), authorization: headers.Authorization, model: JSON.parse(String(init?.body)).model });
      return Response.json({ output: { results: [{ index: 0, relevance_score: 0.9 }] } });
    });
    const candidate = { id: "evidence-1", text: "正文", score: 0.1, metadata: { source: "text" } };
    const policy = { enabled: true, text: { provider: "bailian" as const, baseUrl: "https://text-rerank.fixture", model: "text-model" }, vision: { provider: "bailian" as const, baseUrl: "https://vision-rerank.fixture", model: "vision-model" } };
    const runtime = { resolveApiKey: function key(role: "text" | "vision") { return `${role}-key`; }, fetch: fetchMock as typeof fetch };
    await rerankCandidates("普通问题", [candidate], [], false, policy, runtime);
    await rerankCandidates("查看图片", [candidate], [{ candidateId: candidate.id, dataUrl: "data:image/png;base64,YQ==" }], true, policy, runtime);
    expect(requests).toEqual([
      { url: "https://text-rerank.fixture/api/v1/services/rerank/text-rerank/text-rerank", authorization: "Bearer text-key", model: "text-model" },
      { url: "https://vision-rerank.fixture/api/v1/services/rerank/text-rerank/text-rerank", authorization: "Bearer vision-key", model: "vision-model" },
    ]);
  });

  it("旧索引未知或任一空间字段变化时返回需重建错误", function rejectsUnknownOrIncompatibleProfiles() {
    const current = { provider: "openai-compatible", model: "model-a", dimension: 1024, pipelineVersion: "rag-v2" as const, embeddingSpaceId: "space-a" };
    expect(function unknown() { assertEmbeddingProfileCompatible(undefined, current); }).toThrowError(expect.objectContaining({ code: "RAG_VECTOR_SPACE_MISMATCH" }));
    const stored = { tableName: "rag_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", resourceId: "resource_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceType: "text" as const, embeddingProvider: current.provider, embeddingModel: current.model, embeddingDimension: current.dimension, embeddingSpaceId: current.embeddingSpaceId, lexicalIndexVersion: "lexical-v1" as const, pipelineVersion: "rag-v2" as const, schemaVersion: 1 as const };
    expect(function compatible() { assertEmbeddingProfileCompatible(stored, current); }).not.toThrow();
    expect(function changedModel() { assertEmbeddingProfileCompatible({ ...stored, embeddingModel: "model-b" }, current); }).toThrowError(expect.objectContaining({ code: "RAG_VECTOR_SPACE_MISMATCH" }));
  });
});
