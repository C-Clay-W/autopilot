/**
 * 文档检索预路由与查询向量复用。
 *
 * 只根据安全 manifest 和表级向量 metadata 规划查询，不读取文档正文、数据库快照或凭据。
 */
import type { KnowledgeResourceManifest, TableProfile } from "../knowledge-resource-store";
import { tokenizeLexicalText } from "./lexical-index";
import { RagError } from "../rag-error";

const MAX_ROUTED_TABLES = 8;

/** 检索时实际需要的向量空间信息。 */
export interface RetrievalEmbeddingProfile {
  embeddingSpaceId: string;
  kind: "text" | "multimodal";
}

/** 查询前比较持久索引 profile 与当前完整向量空间；未知旧元数据也必须阻断。 */
export function assertEmbeddingProfileCompatible(stored: TableProfile | undefined, current: { provider: string; model: string; dimension: number; pipelineVersion: "rag-v2"; embeddingSpaceId: string }): void {
  if (!stored || stored.schemaVersion !== 1 || stored.pipelineVersion !== current.pipelineVersion || !stored.embeddingProvider || !stored.embeddingModel || !Number.isInteger(stored.embeddingDimension) || !stored.embeddingSpaceId
    || stored.embeddingProvider !== current.provider || stored.embeddingModel !== current.model || stored.embeddingDimension !== current.dimension || stored.embeddingSpaceId !== current.embeddingSpaceId) {
    throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
  }
}

/** 从表首条 metadata 解析稳定向量空间；缺失字段只形成不兼容旧标识，由查询门禁拒绝。 */
export function resolveRetrievalEmbeddingProfile(metadata: Record<string, unknown> | null): RetrievalEmbeddingProfile {
  const provider = String(metadata?.embeddingProvider ?? "cloud-text");
  const model = String(metadata?.embeddingModel ?? "legacy-unversioned");
  const dimension = Number(metadata?.embeddingDimension ?? 0);
  const kind = provider === "dashscope" || provider === "dashscope-multimodal" || metadata?.source === "pdf" || metadata?.source === "image" ? "multimodal" : "text";
  const explicit = typeof metadata?.embeddingSpaceId === "string" ? metadata.embeddingSpaceId.trim() : "";
  return { embeddingSpaceId: explicit || `${provider}:${model}:${dimension || "unknown"}:legacy:rag-v2`, kind };
}

/** 创建按 query 与 embeddingSpaceId 去重的单次检索向量缓存。 */
export function createQueryVectorCache(input: {
  embedText: (query: string) => Promise<number[]>;
  embedMultimodal: (query: string) => Promise<number[]>;
}) {
  const vectors = new Map<string, Promise<number[]>>();

  /** 同一查询在同一向量空间只调用一次 Embedding。 */
  function get(query: string, profile: RetrievalEmbeddingProfile): Promise<number[]> {
    const key = `${profile.embeddingSpaceId}\u0000${query}`;
    const existing = vectors.get(key);
    if (existing) return existing;
    const pending = profile.kind === "multimodal" ? input.embedMultimodal(query) : input.embedText(query);
    vectors.set(key, pending);
    return pending;
  }

  return { get };
}

/** 判断资源类型是否符合查询分类器给出的来源偏好。 */
function isPreferredResource(resource: KnowledgeResourceManifest, preferredSources: string[]): boolean {
  if (resource.type === "image") return preferredSources.includes("pdf") || preferredSources.includes("image");
  if (resource.type === "pdf") return preferredSources.includes("pdf");
  if (resource.type === "excel") return preferredSources.includes("excel");
  return preferredSources.some(function isTextSource(source) { return source === "text" || source === "txt" || source === "md" || source === "docx"; });
}

/** 使用 manifest 名称与来源偏好选择有界物理表，并保留旧表只读兼容回退。 */
export function selectSearchTables(input: {
  query: string;
  explicitTableName?: string;
  manifests: KnowledgeResourceManifest[];
  fallbackTables: string[];
  preferredSources: string[];
}): string[] {
  if (input.explicitTableName) return [input.explicitTableName];
  const queryTerms = new Set(tokenizeLexicalText(input.query));
  const usable = input.manifests.filter(function isUsable(resource) { return resource.status === "completed" || resource.status === "partial"; });
  const scored = usable.map(function scoreResource(resource) {
    const nameTerms = tokenizeLexicalText(resource.displayName);
    const nameMatches = nameTerms.filter(function matches(term) { return queryTerms.has(term); }).length;
    return { tableName: resource.tableName, score: nameMatches * 10 + Number(isPreferredResource(resource, input.preferredSources)) };
  }).sort(function highestScoreFirst(left, right) { return right.score - left.score || left.tableName.localeCompare(right.tableName); });
  const candidates = scored.length > 0
    ? scored.map(function table(item) { return item.tableName; })
    : input.manifests.length > 0
      ? []
      : input.fallbackTables.filter(function isDocumentTable(name) { return !name.startsWith("mysql_"); });
  return [...new Set(candidates)].slice(0, MAX_ROUTED_TABLES);
}
