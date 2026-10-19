/**
 * Embedding 封装
 * - 云端文本 Embedding（OpenAI 兼容接口）
 * - 普通文本维度固定为 1024
 * - PDF 页级图文融合使用 DashScope 通义多模态 Embedding，维度 1152
 *
 */
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 普通文本 Embedding 服务配置
 *
 * 配置必须由应用层环境变量提供，禁止回退到本地 1234 服务或在源码写入密钥。
 */
const TEXT_EMBEDDING_BASE_URL = process.env.TEXT_EMBEDDING_BASE_URL?.replace(/\/$/, "") || "";
export const TEXT_EMBEDDING_MODEL = process.env.TEXT_EMBEDDING_MODEL || "";
const TEXT_EMBEDDING_API_KEY = process.env.TEXT_EMBEDDING_API_KEY || "";
export const TEXT_EMBEDDING_DIMENSION = 1024;
export const DASHSCOPE_EMBEDDING_MODEL = process.env.TONGYI_EMBEDDING_MODEL
  || "tongyi-embedding-vision-plus-2026-03-06";
export const DASHSCOPE_EMBEDDING_DIMENSION = 1152;
const DASHSCOPE_EMBEDDING_URL = process.env.DASHSCOPE_EMBEDDING_URL
  || "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
const TONGYI_API_KEY = process.env.TONGYI_API_KEY || "";
const MAX_DASHSCOPE_TEXT_LENGTH = 12000;

/** 单个 Embedding 角色在一次入库或检索操作内冻结的连接。 */
export interface EmbeddingConnection {
  provider: string;
  baseUrl: string;
  model: string;
  dimension: number;
  normalization: "raw" | "provider-normalized";
  pipelineVersion: "rag-v2";
  resolveApiKey: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
}

/** 文本与多模态 Embedding 的独立运行连接。 */
export interface EmbeddingRuntime {
  text?: EmbeddingConnection;
  multimodal?: EmbeddingConnection;
}

/** 可写入索引 profile 的当前 Embedding 空间元数据。 */
export interface EmbeddingProfile {
  role: "textEmbedding" | "multimodalEmbedding";
  provider: string;
  model: string;
  dimension: number;
  normalization: "raw" | "provider-normalized";
  pipelineVersion: "rag-v2";
  embeddingSpaceId: string;
}

const embeddingRuntimeStorage = new AsyncLocalStorage<EmbeddingRuntime>();

/** 在异步操作期间固定两类 Embedding 连接，避免 settings 热更新造成模型与 Key 拆分。 */
export function withEmbeddingRuntime<T>(runtime: EmbeddingRuntime | undefined, operation: () => Promise<T>): Promise<T> {
  return runtime ? embeddingRuntimeStorage.run(runtime, operation) : operation();
}

/** 返回兼容旧宿主环境变量的文本连接。 */
function getTextConnection(): EmbeddingConnection {
  const runtime = embeddingRuntimeStorage.getStore();
  if (runtime) return runtime.text ?? {
    provider: "openai-compatible", baseUrl: "", model: "unconfigured", dimension: TEXT_EMBEDDING_DIMENSION,
    normalization: "raw", pipelineVersion: "rag-v2", resolveApiKey: function resolveMissingTextKey() { return undefined; },
  };
  return {
    provider: "openai-compatible", baseUrl: TEXT_EMBEDDING_BASE_URL, model: TEXT_EMBEDDING_MODEL,
    dimension: TEXT_EMBEDDING_DIMENSION, normalization: "raw", pipelineVersion: "rag-v2",
    resolveApiKey: function resolveLegacyTextKey() { return TEXT_EMBEDDING_API_KEY; },
  };
}

/** 返回兼容旧宿主环境变量的多模态连接。 */
function getMultimodalConnection(): EmbeddingConnection {
  const runtime = embeddingRuntimeStorage.getStore();
  if (runtime) return runtime.multimodal ?? {
    provider: "dashscope", baseUrl: "", model: "unconfigured", dimension: DASHSCOPE_EMBEDDING_DIMENSION,
    normalization: "provider-normalized", pipelineVersion: "rag-v2", resolveApiKey: function resolveMissingMultimodalKey() { return undefined; },
  };
  return {
    provider: "dashscope", baseUrl: DASHSCOPE_EMBEDDING_URL, model: DASHSCOPE_EMBEDDING_MODEL,
    dimension: DASHSCOPE_EMBEDDING_DIMENSION, normalization: "provider-normalized", pipelineVersion: "rag-v2",
    resolveApiKey: function resolveLegacyMultimodalKey() { return TONGYI_API_KEY; },
  };
}

/** 从完整空间字段生成稳定标识；凭据不参与，因此只换 Key 不触发重建。 */
function createEmbeddingSpaceId(role: EmbeddingProfile["role"], connection: EmbeddingConnection): string {
  const canonical = JSON.stringify([role, connection.provider, connection.baseUrl.replace(/\/+$/u, ""), connection.model, connection.dimension, connection.normalization, connection.pipelineVersion]);
  return `rag-embedding-v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** 返回当前冻结连接对应的完整空间 profile。 */
export function getEmbeddingProfile(kind: "text" | "multimodal"): EmbeddingProfile {
  const connection = kind === "text" ? getTextConnection() : getMultimodalConnection();
  const role = kind === "text" ? "textEmbedding" : "multimodalEmbedding";
  return { role, provider: connection.provider, model: connection.model, dimension: connection.dimension, normalization: connection.normalization, pipelineVersion: connection.pipelineVersion, embeddingSpaceId: createEmbeddingSpaceId(role, connection) };
}

/** 返回文本向量的稳定空间标识，覆盖 Provider、模型、维度、归一化与 pipeline。 */
export function getTextEmbeddingSpaceId(): string {
  return getEmbeddingProfile("text").embeddingSpaceId;
}

/** 返回 PDF 多模态向量的稳定空间标识。 */
export function getMultimodalEmbeddingSpaceId(): string {
  return getEmbeddingProfile("multimodal").embeddingSpaceId;
}

/**
 * 调用云端文本 Embedding 服务将文本转为向量
 * @param text 输入文本
 * @returns 1024 维浮点向量
 * @throws 当云端配置缺失、调用失败或返回维度不正确时抛出异常
 */
export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const connection = getTextConnection();
  const apiKey = await connection.resolveApiKey();
  if (!connection.baseUrl || !connection.model || !apiKey) {
    throw new Error("云端文本 Embedding 配置不完整：请设置 TEXT_EMBEDDING_BASE_URL、TEXT_EMBEDDING_MODEL 和 TEXT_EMBEDDING_API_KEY");
  }

  const response = await (connection.fetch ?? fetch)(`${connection.baseUrl.replace(/\/+$/u, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: connection.model,
      input: text,
      dimensions: connection.dimension,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`云端文本 Embedding API 调用失败 (${response.status})`);
  }

  const json = (await response.json()) as {
    data: { embedding: number[] }[];
  };

  const embedding = json.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error("云端文本 Embedding API 返回空向量");
  }

  if (embedding.length !== connection.dimension) {
    throw new Error(`云端文本 Embedding 向量维度异常：期望 ${connection.dimension}，实际 ${embedding.length}`);
  }

  return embedding.map((value) => Number(value));
}

/**
 * 批量文本 Embedding（复用单条接口循环调用）
 * 为保持云端服务兼容性，逐条调用单条接口
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}

/**
 * 截断多模态模型输入文本，完整页文本仍保存在 metadata 中
 * 这里做截断是为了避免 DashScope 多模态 Embedding 接口报错（文本过长），
 * 但仍然保留了足够的文本信息用于向量化和检索。
 * 
 * added by clayw on 20260714
 */
export function limitDashScopeText(text: string): string {
  if (text.length <= MAX_DASHSCOPE_TEXT_LENGTH) return text;
  return text.slice(0, MAX_DASHSCOPE_TEXT_LENGTH);
}

/**
 * 调用 DashScope 多模态 Embedding HTTP 接口
 * 这里是按照plan0714的思路实现，文本和图片都可以传入，返回一个向量；
 * 文本先由本地文本嵌入模型提取文本但不转换向量，然后再由DashScope的多模态模型转换向量
 * 这样做是为了统一向量空间，便于后续检索和相似度计算。
 * 
 * 下方很多函数实现均调用此实现
 * 
 * added by clayw on 20260714
 */
async function callDashScopeMultimodalEmbedding(content: { text?: string; image?: string }, signal?: AbortSignal): Promise<number[]> {
  const connection = getMultimodalConnection();
  const apiKey = await connection.resolveApiKey();
  if (!apiKey) {
    throw new Error("缺少 TONGYI_API_KEY 环境变量");
  }

  const response = await (connection.fetch ?? fetch)(connection.baseUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: connection.model,
      input: {
        contents: [content],
      },
      parameters: {
        dimension: connection.dimension,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `DashScope 多模态 Embedding 调用失败 (${response.status}): ${errBody.slice(0, 500)}`
    );
  }

  const json = (await response.json()) as any;
  const embedding = json?.output?.embeddings?.[0]?.embedding
    || json?.output?.embedding
    || json?.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("DashScope 多模态 Embedding 返回空向量");
  }

  if (embedding.length !== connection.dimension) {
    throw new Error(`DashScope 向量维度异常：期望 ${connection.dimension}，实际 ${embedding.length}`);
  }

  return embedding.map((value: unknown) => Number(value));
}

/**
 * PDF 页级图文融合 Embedding，一页文本和一页截图生成同一个向量
 * 
 * 这里是为了能够让LLM知道某段文本和图片是一起的，来自于哪一个PDF
 * 
 * added by clayw on 20260714
 */
export async function embedPage(input: { text?: string; image?: string }, signal?: AbortSignal): Promise<number[]> {
  if (!input.text?.trim() && !input.image) {
    throw new Error("embedPage 至少需要 text 或 image");
  }
  return callDashScopeMultimodalEmbedding({
    text: input.text ? limitDashScopeText(input.text) : undefined,
    image: input.image,
  }, signal);
}

/**
 * PDF 检索问题 Embedding，使用和 PDF 页级向量相同的 DashScope 多模态空间
 */
export async function embedMultimodalText(text: string): Promise<number[]> {
  return callDashScopeMultimodalEmbedding({ text: limitDashScopeText(text) });
}

/**
 * 多模态图片 Embedding，保留兼容导出
 */
export async function embedImage(input: { image?: string; text?: string }): Promise<number[]> {
  return embedPage(input);
}

/**
 * Embedding 缓存
 *
 * TODO: 本函数暂为空壳，待多模态模型（阿里百炼 vision-plus）接入后实现。
 * 届时用于缓存图片/文档的 Embedding 结果，避免相同文件重复调用云端 API（有费用）。
 *
 * 文本 Embedding 已走云端服务，缓存策略留待后续按成本和命中率评估。
 *
 * @param key 缓存键（如文件 hash）
 * @param embedFn 实际的 Embedding 调用函数
 */
export async function getOrCreateEmbedding(
  key: string,
  embedFn: () => Promise<number[]>,
  cachePath?: string,
): Promise<number[]> {
  if (!cachePath) return embedFn();
  const root = path.resolve(cachePath);
  const cacheKey = createHash("sha256").update(key).digest("hex");
  const target = path.join(root, `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(target, "utf8")) as { vector?: unknown };
    if (Array.isArray(cached.vector) && cached.vector.length > 0 && cached.vector.every(function numeric(value) { return typeof value === "number" && Number.isFinite(value); })) return cached.vector;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const vector = await embedFn();
  await mkdir(root, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ vector }), { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
  return vector;
}
