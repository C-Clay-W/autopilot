/**
 * Node RAG 运行连接装配。
 *
 * 将 User settings 的四个独立角色或完整旧宿主环境回退转换为 Core 短生命周期闭包，
 * 明文凭据不进入配置快照、索引 profile 或持久状态。
 */
import { createNodeCredentialStore } from "../stores/node-credential-store";

/** Adapter 所需的最小安全角色快照，避免依赖未在 Stage5 生成的 Core dist 类型。 */
interface RagConnectionSnapshot {
  provider: "bailian" | "openai-compatible" | "dashscope";
  baseUrl: string;
  model: string;
  credentialRef: { provider: string; key: string };
  dimension?: number;
}

/** Adapter 所需的最小 settings 形状。 */
interface RagSettingsSnapshot {
  rag: Partial<Record<"textRerank" | "visionRerank" | "textEmbedding" | "multimodalEmbedding", RagConnectionSnapshot>>;
  diagnostics?: ReadonlyArray<{ code: string; field?: string }>;
}

/** Core Embedding 连接的结构兼容形状。 */
interface NodeEmbeddingConnection {
  provider: string;
  baseUrl: string;
  model: string;
  dimension: number;
  normalization: "raw" | "provider-normalized";
  pipelineVersion: "rag-v2";
  resolveApiKey: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
}

/** Node RAG 装配输入；fetch 仅用于隔离自动化捕获请求。 */
export interface CreateNodeRagRuntimeOptions {
  settings: RagSettingsSnapshot;
  userSettingsPath: string;
  env?: NodeJS.ProcessEnv;
  rerankFetch?: typeof fetch;
  embeddingFetch?: typeof fetch;
}

/** 解析显式角色凭据，缺失时让 Core 按角色返回不可用，绝不跨角色回退。 */
function createSettingsKeyResolver(connection: RagConnectionSnapshot, userSettingsPath: string, env: NodeJS.ProcessEnv) {
  const store = createNodeCredentialStore({ env, userSettingsPath, snapshot: true });
  return async function resolveSettingsKey(): Promise<string | undefined> {
    try { return (await store.resolve(connection.credentialRef)).apiKey; }
    catch { return undefined; }
  };
}

/** 仅当旧文本 Embedding 三项完整时创建整组回退。 */
function createLegacyTextEmbedding(env: NodeJS.ProcessEnv, fetchImplementation?: typeof fetch): NodeEmbeddingConnection | undefined {
  if (!env.TEXT_EMBEDDING_BASE_URL || !env.TEXT_EMBEDDING_MODEL || !env.TEXT_EMBEDDING_API_KEY) return undefined;
  return {
    provider: "openai-compatible", baseUrl: env.TEXT_EMBEDDING_BASE_URL.replace(/\/+$/u, ""), model: env.TEXT_EMBEDDING_MODEL,
    dimension: 1024, normalization: "raw", pipelineVersion: "rag-v2", fetch: fetchImplementation,
    resolveApiKey: function resolveLegacyTextKey() { return env.TEXT_EMBEDDING_API_KEY; },
  };
}

/** 仅当旧多模态 Embedding 三项完整时创建整组回退。 */
function createLegacyMultimodalEmbedding(env: NodeJS.ProcessEnv, fetchImplementation?: typeof fetch): NodeEmbeddingConnection | undefined {
  if (!env.DASHSCOPE_EMBEDDING_URL || !env.TONGYI_EMBEDDING_MODEL || !env.TONGYI_API_KEY) return undefined;
  return {
    provider: "dashscope", baseUrl: env.DASHSCOPE_EMBEDDING_URL.replace(/\/+$/u, ""), model: env.TONGYI_EMBEDDING_MODEL,
    dimension: 1152, normalization: "provider-normalized", pipelineVersion: "rag-v2", fetch: fetchImplementation,
    resolveApiKey: function resolveLegacyMultimodalKey() { return env.TONGYI_API_KEY; },
  };
}

/** 按角色完整性规则创建一次 RAG 操作使用的冻结连接。 */
export function createNodeRagRuntime(options: CreateNodeRagRuntimeOptions) {
  const env = { ...(options.env ?? process.env) };
  const textRerank = options.settings.rag.textRerank;
  const visionRerank = options.settings.rag.visionRerank;
  const textEmbedding = options.settings.rag.textEmbedding;
  const multimodalEmbedding = options.settings.rag.multimodalEmbedding;
  const invalidAllRag = options.settings.diagnostics?.some(function invalidRag(item) { return item.code === "SETTINGS_RAG_INVALID" && item.field === "rag"; }) ?? false;
  /** 显式无效角色必须保持失败关闭，不能被同机旧环境补齐。 */
  function allowsLegacyFallback(role: "textRerank" | "visionRerank" | "textEmbedding" | "multimodalEmbedding"): boolean {
    return !invalidAllRag && !options.settings.diagnostics?.some(function invalidRole(item) { return item.code === "SETTINGS_RAG_CONNECTION_INVALID" && item.field === `rag.${role}`; });
  }
  const legacyRerankBaseUrl = env.RERANK_BASE_URL?.replace(/\/+$/u, "");
  const textPolicy = textRerank
    ? { provider: "bailian" as const, baseUrl: textRerank.baseUrl, model: textRerank.model }
    : allowsLegacyFallback("textRerank") && legacyRerankBaseUrl && env.RERANK_API_KEY && env.RERANK_TEXT_MODEL
      ? { provider: "bailian" as const, baseUrl: legacyRerankBaseUrl, model: env.RERANK_TEXT_MODEL }
      : undefined;
  const visionPolicy = visionRerank
    ? { provider: "bailian" as const, baseUrl: visionRerank.baseUrl, model: visionRerank.model }
    : allowsLegacyFallback("visionRerank") && legacyRerankBaseUrl && env.RERANK_API_KEY && env.RERANK_VISION_MODEL
      ? { provider: "bailian" as const, baseUrl: legacyRerankBaseUrl, model: env.RERANK_VISION_MODEL }
      : undefined;
  const textKey = textRerank ? createSettingsKeyResolver(textRerank, options.userSettingsPath, env) : function resolveLegacyTextRerankKey() { return textPolicy ? env.RERANK_API_KEY : undefined; };
  const visionKey = visionRerank ? createSettingsKeyResolver(visionRerank, options.userSettingsPath, env) : function resolveLegacyVisionRerankKey() { return visionPolicy ? env.RERANK_API_KEY : undefined; };
  return {
    rerank: {
      defaultPolicy: { enabled: Boolean(textPolicy || visionPolicy), text: textPolicy, vision: visionPolicy },
      resolveApiKey: function resolveRerankKey(role: "text" | "vision") { return role === "text" ? textKey() : visionKey(); },
      fetch: options.rerankFetch,
    },
    embedding: {
      text: textEmbedding ? {
        provider: textEmbedding.provider, baseUrl: textEmbedding.baseUrl, model: textEmbedding.model, dimension: textEmbedding.dimension!,
        normalization: "raw" as const, pipelineVersion: "rag-v2" as const, fetch: options.embeddingFetch,
        resolveApiKey: createSettingsKeyResolver(textEmbedding, options.userSettingsPath, env),
      } : allowsLegacyFallback("textEmbedding") ? createLegacyTextEmbedding(env, options.embeddingFetch) : undefined,
      multimodal: multimodalEmbedding ? {
        provider: multimodalEmbedding.provider, baseUrl: multimodalEmbedding.baseUrl, model: multimodalEmbedding.model, dimension: multimodalEmbedding.dimension!,
        normalization: "provider-normalized" as const, pipelineVersion: "rag-v2" as const, fetch: options.embeddingFetch,
        resolveApiKey: createSettingsKeyResolver(multimodalEmbedding, options.userSettingsPath, env),
      } : allowsLegacyFallback("multimodalEmbedding") ? createLegacyMultimodalEmbedding(env, options.embeddingFetch) : undefined,
    },
  };
}
