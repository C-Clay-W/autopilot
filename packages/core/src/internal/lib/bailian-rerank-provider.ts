/** 百炼专用精排适配器：封装文本/视觉模型共用的 HTTP 协议与已接入模型的相关性策略。 */
import type { RerankProviderAdapter, RerankProviderResult } from "./rerank-provider";

const RERANK_PATH = "/api/v1/services/rerank/text-rerank/text-rerank";

export const bailianRerankAdapter: RerankProviderAdapter = {
  id: "bailian",
  supportedRoles: ["text", "vision"],
  /** 两个百炼模型共用专用路径，按角色转换文档输入并要求返回全部候选。 */
  createRequest(input) {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    return {
      url: baseUrl.endsWith(RERANK_PATH) ? baseUrl : `${baseUrl}${RERANK_PATH}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        input: { query: input.query, documents: input.documents.map(function document(item) { return input.role === "text" ? item.text : item; }) },
        parameters: { return_documents: false, top_n: input.documents.length },
      }),
    };
  },
  /** 读取百炼字段并排序；0.5 仅保留为当前两个已接入模型的项目策略，不套用到未知模型。 */
  parseResponse(payload, context) {
    const results = (payload as { output?: { results?: Array<{ index: number; relevance_score: number }> } } | null)?.output?.results;
    if (!Array.isArray(results) || results.length === 0) throw new Error("RERANK_RESPONSE_EMPTY");
    const knownModel = (context.role === "text" && context.model === "qwen3.7-text-rerank")
      || (context.role === "vision" && context.model === "qwen3-vl-rerank");
    return results.map(function normalize(item): RerankProviderResult {
      if (typeof item?.relevance_score !== "number" || !Number.isFinite(item.relevance_score)) throw new Error("RERANK_RESPONSE_SCORE_INVALID");
      return { index: item.index, score: item.relevance_score, ...(knownModel ? { relevant: item.relevance_score >= 0.5 } : {}) };
    }).sort(function byScore(left, right) { return right.score! - left.score! || left.index - right.index; });
  },
};
