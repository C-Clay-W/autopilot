/**
 * 专用 Rerank Provider 边界。
 *
 * 只把受控候选发送到专用文本或视觉 Rerank endpoint，并严格按本次输入 index
 * 映射结果。失败时保留上游候选顺序，不调用 Chat 模型模拟精排。
 */
import type { VectorOutput } from "../types";
import { classifyQuery } from "./query-classify";
import { bailianRerankAdapter } from "./bailian-rerank-provider";
import type { RerankDocument, RerankProviderAdapter, RerankProviderResult } from "./rerank-provider";

/** 当前 Turn 可持久化的非敏感 Rerank 配置快照。 */
export interface RerankPolicy {
  enabled: boolean;
  /** Stage2 独立文本连接；未传时兼容旧共享字段。 */
  text?: RerankConnectionPolicy;
  /** Stage2 独立视觉连接；未传时兼容旧共享字段。 */
  vision?: RerankConnectionPolicy;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  timeoutMs?: number;
  maxTextCandidates?: number;
  maxVisionCandidates?: number;
  maxQueryCharacters?: number;
  maxDocumentCharacters?: number;
}

/** 单个 Rerank 角色在一次检索内冻结的非敏感连接。 */
export interface RerankConnectionPolicy {
  provider: "bailian";
  baseUrl: string;
  model: string;
}

/** Rerank 使用的候选页图。 */
export interface RerankVisionImage {
  candidateId: string;
  dataUrl: string;
}

/** PDF 页图视觉定位结果。 */
export interface VisionLocationResult {
  candidateId: string;
  score?: number;
}

/** Rerank 安全终态。 */
export interface RerankOutcome {
  status: "completed" | "skipped" | "degraded" | "failed";
  role: "text" | "vision";
  model: string;
  results: { evidenceId: string; rank: number; relevanceScore?: number }[];
  warnings: string[];
}

/** Rerank 结果；保留旧字段供现有调用方兼容。 */
export interface RerankResult {
  results: VectorOutput[];
  completed: boolean;
  hasUsableResults: boolean;
  outcome: RerankOutcome;
}

/** Rerank 运行时依赖；Key 只由服务端闭包按需解析。 */
export interface RerankRuntime {
  resolveApiKey?: (role: "text" | "vision") => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
  adapter?: RerankProviderAdapter;
}

/** 仅在用户问题明确需要图像理解时，才使用视觉模型执行候选精排。 */
export function needsVisionRerank(question: string, candidates: VectorOutput[]): boolean {
  void candidates;
  return classifyQuery(question).requiresVision;
}

/** 提取候选原始页文本，防止相邻页摘要冒充当前页内容。 */
function getRerankEvidenceText(candidate: VectorOutput, maxCharacters: number): string {
  if (candidate.metadata.source !== "pdf") return candidate.text.slice(0, maxCharacters);
  const fileName = String(candidate.metadata.fileName ?? "未知文件");
  const pageNumber = String(candidate.metadata.pageNumber ?? "未知页");
  const title = String(candidate.metadata.title ?? "");
  const pageText = String(candidate.metadata.pageText ?? "").trim();
  return `文件：${fileName}\n页码：${pageNumber}\n标题：${title}\n\n${pageText}`.slice(0, maxCharacters);
}

/** 校验适配前后地址，禁止非本机明文 HTTP 与 Chat 精排旁路。 */
function validateEndpoint(url: string): void {
  const parsed = new URL(url);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if ((parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) || /chat\/completions/i.test(parsed.pathname)) {
    throw new Error("RERANK_BASE_URL_INVALID");
  }
}

/** 选择独立角色连接，并保留旧共享 Rerank 配置兼容。 */
function resolveRerankConnection(policy: RerankPolicy, role: "text" | "vision"): RerankConnectionPolicy | undefined {
  const configured = role === "text" ? policy.text : policy.vision;
  if (configured) return configured;
  const model = role === "text" ? policy.textModel : policy.visionModel;
  return policy.baseUrl && model ? { provider: "bailian", baseUrl: policy.baseUrl, model } : undefined;
}

/** 读取受控 Retry-After，避免异常响应制造超长等待。 */
function readRetryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds * 1_000, 2_000)) : 0;
}

/** 等待一次小预算重试，并允许 AbortSignal 立即终止。 */
async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>(function wait(resolve, reject) {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", function abort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** 对 Provider index/score 做全量校验；任一非法项都使整次响应降级。 */
function validateProviderResults(results: RerankProviderResult[], candidateCount: number): RerankProviderResult[] {
  if (!Array.isArray(results) || results.length === 0) throw new Error("RERANK_RESPONSE_EMPTY");
  const seen = new Set<number>();
  const ranked: RerankProviderResult[] = [];
  for (const item of results) {
    if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= candidateCount || seen.has(item.index)) {
      throw new Error("RERANK_RESPONSE_INDEX_INVALID");
    }
    if (item.score !== undefined && (typeof item.score !== "number" || !Number.isFinite(item.score))) {
      throw new Error("RERANK_RESPONSE_SCORE_INVALID");
    }
    if (item.relevant !== undefined && typeof item.relevant !== "boolean") throw new Error("RERANK_RESPONSE_RELEVANCE_INVALID");
    seen.add(item.index);
    ranked.push({ index: item.index, score: item.score, relevant: item.relevant });
  }
  if (seen.size !== candidateCount) throw new Error("RERANK_RESPONSE_INCOMPLETE");
  return ranked;
}

/** 调用一次专用 Rerank API；只对 429 与 5xx 做一次小预算重试。 */
async function requestRerank(input: {
  policy: RerankPolicy;
  runtime: RerankRuntime;
  role: "text" | "vision";
  model: string;
  query: string;
  documents: RerankDocument[];
  signal?: AbortSignal;
}): Promise<RerankProviderResult[]> {
  input.signal?.throwIfAborted();
  const adapter = input.runtime.adapter ?? bailianRerankAdapter;
  if (!adapter.supportedRoles.includes(input.role)) throw new Error("RERANK_MODALITY_UNSUPPORTED");
  const connection = resolveRerankConnection(input.policy, input.role);
  const apiKey = await input.runtime.resolveApiKey?.(input.role);
  if (!connection || !apiKey) throw new Error("RERANK_UNAVAILABLE");
  validateEndpoint(connection.baseUrl);
  const request = adapter.createRequest({ baseUrl: connection.baseUrl, apiKey, role: input.role, model: connection.model, query: input.query, documents: input.documents });
  validateEndpoint(request.url);
  const fetchImpl = input.runtime.fetch ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(input.policy.timeoutMs ?? 20_000, 60_000));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    });
    if (response.ok) return validateProviderResults(adapter.parseResponse(await response.json(), { model: input.model, role: input.role }), input.documents.length);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt > 0) throw new Error(`RERANK_PROVIDER_REJECTED_${response.status}`);
    await waitForRetry(readRetryAfterMs(response) || 100, input.signal);
  }
  throw new Error("RERANK_PROVIDER_FAILED");
}

/** 构造未调用 Provider 时的稳定结果，不泄露底层错误。 */
function createFallbackResult(
  candidates: VectorOutput[],
  role: "text" | "vision",
  model: string,
  status: "skipped" | "degraded" | "failed",
  warning: string,
): RerankResult {
  return {
    results: candidates,
    completed: false,
    hasUsableResults: candidates.length > 0,
    outcome: { status, role, model, results: candidates.map(function keep(candidate, index) { return { evidenceId: candidate.id, rank: index + 1 }; }), warnings: [warning] },
  };
}

/** 从一批 PDF 页图中用专用视觉 Rerank 找出相关页面。 */
export async function locatePdfPages(
  question: string,
  visionImages: RerankVisionImage[],
  policy?: RerankPolicy,
  runtime: RerankRuntime = {},
  signal?: AbortSignal,
): Promise<{ results: VisionLocationResult[]; outcome: RerankOutcome }> {
  const connection = policy ? resolveRerankConnection(policy, "vision") : undefined;
  const model = connection?.model ?? "qwen3-vl-rerank";
  if (visionImages.length === 0) return { results: [], outcome: { status: "skipped", role: "vision", model, results: [], warnings: [] } };
  if (!policy?.enabled || !connection) return { results: [], outcome: { status: "degraded", role: "vision", model, results: [], warnings: ["visual_rerank_unavailable"] } };
  const limit = Math.max(1, Math.min(policy.maxVisionCandidates ?? 8, 20));
  const selected = visionImages.slice(0, limit);
  try {
    const ranked = await requestRerank({
      policy,
      runtime,
      role: "vision",
      model: connection.model,
      query: question.slice(0, policy.maxQueryCharacters ?? 4_000),
      documents: selected.map(function document(image) { return { text: image.candidateId, image: image.dataUrl }; }),
      signal,
    });
    const results = ranked.map(function map(item) { return { candidateId: selected[item.index].candidateId, score: item.score }; });
    return { results, outcome: { status: "completed", role: "vision", model: connection.model, results: results.map(function result(item, index) { return { evidenceId: item.candidateId, rank: index + 1, relevanceScore: item.score }; }), warnings: [] } };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return { results: [], outcome: { status: "degraded", role: "vision", model, results: [], warnings: ["visual_rerank_unavailable"] } };
  }
}

/** 对候选执行一次专用精排；失败时保持上游候选顺序。 */
export async function rerankCandidates(
  question: string,
  candidates: VectorOutput[],
  visionImages: RerankVisionImage[] = [],
  forceVisionRerank = false,
  policy?: RerankPolicy,
  runtime: RerankRuntime = {},
  signal?: AbortSignal,
): Promise<RerankResult> {
  const role = forceVisionRerank || needsVisionRerank(question, candidates) ? "vision" : "text";
  const connection = policy ? resolveRerankConnection(policy, role) : undefined;
  const model = connection?.model ?? (role === "vision" ? "qwen3-vl-rerank" : "qwen3.7-text-rerank");
  if (candidates.length === 0) return createFallbackResult(candidates, role, model, "skipped", "rerank_no_candidates");
  if (role === "vision" && visionImages.length === 0) {
    return createFallbackResult(candidates, role, model, "degraded", "visual_evidence_unavailable");
  }
  if (!policy?.enabled || !connection) {
    return createFallbackResult(candidates, role, model, "degraded", "rerank_unavailable");
  }

  const candidateLimit = role === "vision"
    ? Math.max(1, Math.min(policy.maxVisionCandidates ?? 8, 20))
    : Math.max(1, Math.min(policy.maxTextCandidates ?? 50, 100));
  const selected = candidates.slice(0, candidateLimit);
  const imageByCandidate = new Map(visionImages.map(function entry(image) { return [image.candidateId, image.dataUrl]; }));
  const maxDocumentCharacters = Math.max(200, Math.min(policy.maxDocumentCharacters ?? 4_000, 30_000));
  const documents = selected.map(function document(candidate) {
    const text = getRerankEvidenceText(candidate, maxDocumentCharacters);
    return role === "vision" ? { text, image: imageByCandidate.get(candidate.id) } : { text };
  });
  try {
    const ranked = await requestRerank({ policy, runtime, role, model, query: question.slice(0, policy.maxQueryCharacters ?? 4_000), documents, signal });
    const rankedCandidates = ranked.map(function map(item) { return { ...selected[item.index], score: item.score ?? selected[item.index].score, metadata: { ...selected[item.index].metadata, rerankRelevance: item.score, rerankRelevant: item.relevant } }; });
    const rankedIds = new Set(ranked.map(function id(item) { return item.index; }));
    const unranked = selected.filter(function missing(_candidate, index) { return !rankedIds.has(index); });
    const overflow = candidates.slice(selected.length);
    const results = [...rankedCandidates, ...unranked, ...overflow];
    return {
      results,
      completed: true,
      hasUsableResults: results.length > 0,
      outcome: { status: "completed", role, model, results: ranked.map(function outcome(item, index) { return { evidenceId: selected[item.index].id, rank: index + 1, relevanceScore: item.score }; }), warnings: candidates.length > selected.length ? ["rerank_candidates_truncated"] : [] },
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return createFallbackResult(candidates, role, model, "degraded", role === "vision" ? "visual_rerank_unavailable" : "text_rerank_unavailable");
  }
}
