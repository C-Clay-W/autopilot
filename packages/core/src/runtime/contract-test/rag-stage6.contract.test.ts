/**
 * RAG Stage 6 契约测试。
 *
 * 验证专用文本/视觉 Rerank、稳定降级、index 全量校验、取消、Turn 冻结与证据归属。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { KnowledgeResourceManifest } from "../../internal/knowledge-resource-store";
import type { VectorOutput } from "../../internal/types";
import { hasSufficientPrivateEvidence, validateRagEvidenceResults } from "../../internal/agent-flow";
import { locatePdfPages, rerankCandidates, type RerankPolicy } from "../../internal/lib/rerank";
import type { RerankProviderAdapter, RerankProviderResult } from "../../internal/lib/rerank-provider";
import { resolveRunConfig } from "../protocol/run-config";

const policy: RerankPolicy = {
  enabled: true,
  baseUrl: "https://rerank.invalid",
  textModel: "qwen3.7-text-rerank",
  visionModel: "qwen3-vl-rerank",
  maxTextCandidates: 2,
  maxVisionCandidates: 2,
};

/** 创建无业务含义的候选。 */
function candidate(index: number): VectorOutput {
  return { id: `evidence-${index}`, text: `fixture-${index}`, score: index, metadata: { source: "text" } };
}

/** 创建合法的 Provider JSON 响应。 */
function providerResponse(results: Array<{ index: number; relevance_score: number }>, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ output: { results } }), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** 合成另一种供应商协议，验证业务层不依赖百炼的请求、字段和分数范围。 */
const fixtureAdapter: RerankProviderAdapter = {
  id: "fixture-vendor",
  supportedRoles: ["text"],
  /** 将统一文档转换为该夹具供应商的请求格式。 */
  createRequest(input) {
    return { url: `${input.baseUrl}/v2/ranking`, headers: { "X-Api-Key": input.apiKey }, body: JSON.stringify({ engine: input.model, question: input.query, passages: input.documents.map(function text(item) { return item.text; }) }) };
  },
  /** 将供应商有序结果转换为输入索引，并使用其自己的相关性判断。 */
  parseResponse(payload) {
    return (payload as { ranking: Array<{ position: number; value?: number; accepted?: boolean }> }).ranking.map(function normalize(item) { return { index: item.position, score: item.value, relevant: item.accepted }; });
  },
};

describe("RAG Stage 6 contract", function ragStage6ContractSuite() {
  it("文本路径使用专用 endpoint、关闭正文回显并严格按 index 映射", async function reranksTextCandidates() {
    const fetchMock = vi.fn(async function request(_url: string | URL | Request, init?: RequestInit) {
      expect(String(_url)).toContain("/services/rerank/text-rerank/text-rerank");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-fixture" });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "qwen3.7-text-rerank", parameters: { return_documents: false, top_n: 2 } });
      expect(body.input.documents).toEqual(["fixture-0", "fixture-1"]);
      return providerResponse([{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }]);
    });
    const result = await rerankCandidates("query", [candidate(0), candidate(1)], [], false, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.results.map(function id(item) { return item.id; })).toEqual(["evidence-1", "evidence-0"]);
    expect(result.results.map(function relevance(item) { return item.metadata.rerankRelevance; })).toEqual([0.9, 0.2]);
    expect(result.results.map(function relevant(item) { return item.metadata.rerankRelevant; })).toEqual([true, false]);
    expect(result.results.map(function sufficient(item) { return hasSufficientPrivateEvidence("fixture", item); })).toEqual([true, false]);
    expect(result.outcome).toMatchObject({ status: "completed", role: "text", model: "qwen3.7-text-rerank" });
  });

  it("视觉路径只发送受控 Data URI 并映射回候选 ID", async function reranksVisualCandidates() {
    const fetchMock = vi.fn(async function request(url: string | URL | Request, init?: RequestInit) {
      expect(String(url)).toBe("https://rerank.invalid/api/v1/services/rerank/text-rerank/text-rerank");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen3-vl-rerank");
      expect(body.input.documents[0]).toEqual({ text: "page-a", image: "data:image/png;base64,AA==" });
      return providerResponse([{ index: 0, relevance_score: 0.8 }]);
    });
    const result = await locatePdfPages("看图", [{ candidateId: "page-a", dataUrl: "data:image/png;base64,AA==" }], policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.results).toEqual([{ candidateId: "page-a", score: 0.8 }]);
    expect(result.outcome.status).toBe("completed");
  });

  it("视觉页不可用时不伪装为已看图", async function rejectsMissingVisualEvidence() {
    const fetchMock = vi.fn();
    const page = { ...candidate(0), metadata: { source: "pdf", pageNumber: 1, pageText: "" } };
    const result = await rerankCandidates("请查看图片", [page], [], true, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.results).toEqual([page]);
    expect(result.outcome).toMatchObject({ status: "degraded", role: "vision", warnings: ["visual_evidence_unavailable"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [[{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.4 }]],
    [[{ index: 2, relevance_score: 0.5 }, { index: 0, relevance_score: 0.4 }]],
    [[{ index: 0, relevance_score: 0.5 }]],
    [[]],
  ])("重复、越界、不完整或空 index 响应整体降级", async function rejectsInvalidIndexes(results) {
    const original = [candidate(0), candidate(1)];
    const output = await rerankCandidates("query", original, [], false, policy, {
      resolveApiKey: function key() { return "secret-fixture"; },
      fetch: vi.fn(async function request() { return providerResponse(results); }) as typeof fetch,
    });
    expect(output.results).toEqual(original);
    expect(output.outcome).toMatchObject({ status: "degraded", warnings: ["text_rerank_unavailable"] });
  });

  it("429 只做一次小预算重试，4xx 不重试且不切换 Chat 模型", async function retriesOnlyTransientFailures() {
    const retryFetch = vi.fn()
      .mockResolvedValueOnce(providerResponse([], 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(providerResponse([{ index: 0, relevance_score: 0.7 }]));
    const success = await rerankCandidates("query", [candidate(0)], [], false, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: retryFetch as typeof fetch });
    expect(success.completed).toBe(true);
    expect(retryFetch).toHaveBeenCalledTimes(2);

    const clientFetch = vi.fn(async function request() { return providerResponse([], 401); });
    const degraded = await rerankCandidates("query", [candidate(0)], [], false, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: clientFetch as typeof fetch });
    expect(degraded.results[0].id).toBe("evidence-0");
    expect(clientFetch).toHaveBeenCalledTimes(1);
  });

  it("缺少配置时保持基础顺序且实现中不存在 Chat 精排调用", async function degradesWithoutChatFallback() {
    const fetchMock = vi.fn();
    const original = [candidate(0), candidate(1)];
    const result = await rerankCandidates("query", original, [], false, { enabled: false }, { fetch: fetchMock as typeof fetch });
    expect(result.results).toEqual(original);
    expect(result.outcome).toMatchObject({ status: "degraded", warnings: ["rerank_unavailable"] });
    expect(fetchMock).not.toHaveBeenCalled();
    const source = readFileSync(path.resolve(__dirname, "../../internal/lib/rerank.ts"), "utf8");
    expect(source).not.toMatch(/askLoopLLM|askLLMWithImages|chat\/completions`/);
  });

  it("候选超限时只裁剪 Provider 输入并保留基础候选", async function clipsProviderInput() {
    const fetchMock = vi.fn(async function request(_url: string | URL | Request, init?: RequestInit) {
      const body = JSON.parse(String(init?.body));
      expect(body.input.documents).toHaveLength(2);
      return providerResponse([{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }]);
    });
    const result = await rerankCandidates("query", [candidate(0), candidate(1), candidate(2)], [], false, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.results.map(function id(item) { return item.id; })).toEqual(["evidence-1", "evidence-0", "evidence-2"]);
    expect(result.outcome.warnings).toContain("rerank_candidates_truncated");
  });

  it("取消信号终止 Provider 调用而不是伪装降级", async function propagatesCancellation() {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async function request(_url: string | URL | Request, init?: RequestInit) {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return providerResponse([{ index: 0, relevance_score: 1 }]);
    });
    await expect(rerankCandidates("query", [candidate(0)], [], false, policy, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("新 Turn 克隆非敏感 Rerank 配置且不持久化 API Key", function freezesRerankPolicy() {
    const mutable = { ...policy };
    const frozen = resolveRunConfig({ turnOverride: { rerankPolicy: mutable } });
    mutable.textModel = "changed-after-freeze";
    expect(frozen.rerankPolicy?.textModel).toBe("qwen3.7-text-rerank");
    expect(JSON.stringify(frozen)).not.toContain("secret-fixture");
  });

  it("供应商 Adapter 转换不同请求响应且质量门不套用统一分数阈值", async function adaptsDifferentProvider() {
    const fetchMock = vi.fn(async function request(url: string | URL | Request, init?: RequestInit) {
      expect(String(url)).toBe("https://rerank.invalid/v2/ranking");
      expect(init?.headers).toEqual({ "X-Api-Key": "secret-fixture" });
      expect(JSON.parse(String(init?.body))).toEqual({ engine: "fixture-model", question: "query", passages: ["fixture-0", "fixture-1"] });
      return Response.json({ ranking: [{ position: 1, value: 20, accepted: true }, { position: 0, value: 10, accepted: false }] });
    });
    const result = await rerankCandidates("query", [candidate(0), candidate(1)], [], false, { ...policy, textModel: "fixture-model" }, { adapter: fixtureAdapter, resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.outcome).toMatchObject({ status: "completed", results: [{ evidenceId: "evidence-1", rank: 1, relevanceScore: 20 }, { evidenceId: "evidence-0", rank: 2, relevanceScore: 10 }] });
    expect(result.results.map(function sufficient(item) { return hasSufficientPrivateEvidence("query", item); })).toEqual([true, false]);
  });

  it("供应商只返回排名时保留其顺序且未知相关性继续走正文质量门", async function acceptsRankOnlyProvider() {
    const result = await rerankCandidates("query", [candidate(0), candidate(1)], [], false, policy, {
      adapter: fixtureAdapter,
      resolveApiKey: function key() { return "secret-fixture"; },
      fetch: vi.fn(async function request() { return Response.json({ ranking: [{ position: 0 }, { position: 1 }] }); }) as typeof fetch,
    });
    expect(result.completed).toBe(true);
    expect(result.results.map(function id(item) { return item.id; })).toEqual(["evidence-0", "evidence-1"]);
    expect(result.outcome.results[0].relevanceScore).toBeUndefined();
    expect(hasSufficientPrivateEvidence("query", result.results[0])).toBe(false);
    expect(hasSufficientPrivateEvidence("fixture", result.results[0])).toBe(true);
  });

  it("未知百炼模型只排序，不继承已接入模型的 0.5 门槛", async function isolatesModelScorePolicy() {
    const result = await rerankCandidates("query", [candidate(0)], [], false, { ...policy, textModel: "future-model" }, {
      resolveApiKey: function key() { return "secret-fixture"; },
      fetch: vi.fn(async function request() { return providerResponse([{ index: 0, relevance_score: 90 }]); }) as typeof fetch,
    });
    expect(result.completed).toBe(true);
    expect(result.results[0].metadata.rerankRelevant).toBeUndefined();
    expect(hasSufficientPrivateEvidence("query", result.results[0])).toBe(false);
  });

  it("不支持视觉的供应商在读取凭据与发送请求前降级", async function rejectsUnsupportedModality() {
    const fetchMock = vi.fn();
    const resolveApiKey = vi.fn();
    const result = await locatePdfPages("看图", [{ candidateId: "page-a", dataUrl: "data:image/png;base64,AA==" }], policy, { adapter: fixtureAdapter, resolveApiKey, fetch: fetchMock as typeof fetch });
    expect(result.outcome.status).toBe("degraded");
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ index: 0 }, { index: 0 }],
    [{ index: 0 }, { index: 2 }],
    [{ index: 0 }],
    [{ index: 0, score: Number.NaN }, { index: 1 }],
    [{ index: 0, relevant: "yes" }, { index: 1 }],
  ])("Adapter 非法统一结果仍需通过公共校验：%j", async function validatesAdapterOutput(...items) {
    const original = [candidate(0), candidate(1)];
    const adapter: RerankProviderAdapter = { ...fixtureAdapter, parseResponse: function parse() { return items as RerankProviderResult[]; } };
    const output = await rerankCandidates("query", original, [], false, policy, { adapter, resolveApiKey: function key() { return "secret-fixture"; }, fetch: vi.fn(async function request() { return Response.json({}); }) as typeof fetch });
    expect(output.completed).toBe(false);
    expect(output.results).toEqual(original);
  });

  it("百炼完整 endpoint 不重复追加路径", async function acceptsFullEndpoint() {
    const url = "https://rerank.invalid/api/v1/services/rerank/text-rerank/text-rerank";
    const fetchMock = vi.fn(async function request(actual: string | URL | Request) {
      expect(String(actual)).toBe(url);
      return providerResponse([{ index: 0, relevance_score: 0.9 }]);
    });
    expect((await rerankCandidates("query", [candidate(0)], [], false, { ...policy, baseUrl: url }, { resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch })).completed).toBe(true);
  });

  it.each(["http://remote.invalid/rerank", "https://remote.invalid/chat/completions"])("Adapter 不能绕过受控精排地址边界：%s", async function validatesAdapterEndpoint(url) {
    const fetchMock = vi.fn();
    const adapter: RerankProviderAdapter = { ...fixtureAdapter, createRequest: function request(input) { return { ...fixtureAdapter.createRequest(input), url }; } };
    const result = await rerankCandidates("query", [candidate(0)], [], false, policy, { adapter, resolveApiKey: function key() { return "secret-fixture"; }, fetch: fetchMock as typeof fetch });
    expect(result.completed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("证据只允许回查当前 Workspace manifest，并生成 opaque 页引用", function validatesEvidenceOwnership() {
    const resourceId = "resource_0123456789abcdef0123456789abcdef";
    const manifests: KnowledgeResourceManifest[] = [{ schemaVersion: 1, pipelineVersion: "rag-v2", resourceId, displayName: "fixture.pdf", type: "pdf", status: "completed", tableName: "pdf_fixture", recordCount: 1, pageCount: 1, createdAt: 1, updatedAt: 1 }];
    const valid = { ...candidate(0), metadata: { source: "pdf", resourceId, tableName: "pdf_fixture", pageNumber: 1 } };
    const foreign = { ...candidate(1), metadata: { source: "pdf", resourceId, tableName: "foreign", pageNumber: 1 } };
    const results = validateRagEvidenceResults([valid, foreign], manifests);
    expect(results).toHaveLength(1);
    expect(results[0].metadata.visualEvidenceRef).toBe(`rag-resource:${resourceId}:page:1`);
  });
});
