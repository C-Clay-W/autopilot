/** Web 设置服务：校验两类表单 DTO，并把原子读写委托给 Node 用户设置服务。 */
import os from "node:os";
import { createNodeUserSettingsService } from "@autopilot-agent/adapters";

export type RagRole = "textRerank" | "visionRerank" | "textEmbedding" | "multimodalEmbedding";

/** 主模型表单只暴露 Anthropic Messages 连接与已支持的 CC 高级字段。 */
export interface MainSettingsInput {
  provider: "deepseek" | "custom";
  baseUrl: string;
  model: string;
  apiKey?: string;
  availableModels?: string[];
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  subagentModel?: string;
  effort?: "auto" | "low" | "medium" | "high" | "max";
  maxOutputTokens?: number;
  compactWindow?: number;
  timeoutMs?: number;
  alwaysThinkingEnabled?: boolean;
}

/** Search 表单保存完整搜索连接，Key 留空时由服务端判定能否保留。 */
export interface SearchSettingsInput {
  enabled: boolean;
  useMainKey: boolean;
  provider: "deepseek" | "openai-compatible" | "xiaomi-mimo";
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** 单个 RAG 角色；关闭时提交 null，Embedding 必须包含维度。 */
export interface RagConnectionInput {
  provider: "bailian" | "openai-compatible" | "dashscope";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimension?: number;
}

export type CredentialSettingsInput =
  | { category: "main"; revision?: string; main: MainSettingsInput; search: SearchSettingsInput }
  | { category: "rag"; revision?: string; rag: Partial<Record<RagRole, RagConnectionInput | null>> };

/** Web 设置中心安全状态，不包含凭据正文或凭据引用。 */
export interface CredentialSettingsStatus {
  revision: string;
  main: Omit<MainSettingsInput, "apiKey"> & { configured: boolean };
  search: Omit<SearchSettingsInput, "apiKey"> & { configured: boolean };
  rag: Record<RagRole, RagConnectionInput & { configured: boolean }>;
}

/** 设置 API 只暴露稳定错误码。 */
export class CredentialSettingsError extends Error {
  constructor(public readonly code: "INVALID_SETTINGS_INPUT") {
    super(code);
  }
}

/** 判断外部值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验无空白控制字符的短模型或供应商字段。 */
function parseShortString(value: unknown, maximum = 240): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : undefined;
}

/** 校验可选 Key；空字符串表示保留既有凭据。 */
function parseApiKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : undefined;
}

/** 校验 HTTP(S) Base URL 并移除尾部斜杠，不接受 query、fragment 或内嵌凭据。 */
function parseBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return value.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/** 校验主模型分类，供应商只决定 UI 预设，Runtime 始终走 Anthropic Messages。 */
function parseMain(value: unknown): MainSettingsInput {
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["provider", "baseUrl", "model", "apiKey", "availableModels", "opusModel", "sonnetModel", "haikuModel", "subagentModel", "effort", "maxOutputTokens", "compactWindow", "timeoutMs", "alwaysThinkingEnabled"].includes(key); })) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  const provider = value.provider === "deepseek" || value.provider === "custom" ? value.provider : undefined;
  const baseUrl = parseBaseUrl(value.baseUrl);
  const model = parseShortString(value.model);
  const apiKey = parseApiKey(value.apiKey);
  const availableModels = Array.isArray(value.availableModels) ? value.availableModels.map(function modelId(item) { return parseShortString(item); }) : undefined;
  if (!provider || !baseUrl || !model || (provider === "deepseek" && baseUrl !== "https://api.deepseek.com/anthropic") || (provider === "custom" && baseUrl === "https://api.deepseek.com/anthropic") || (value.apiKey !== undefined && value.apiKey !== "" && !apiKey)
    || (availableModels && (availableModels.length === 0 || availableModels.some(function missing(item) { return !item; }) || new Set(availableModels).size !== availableModels.length))
    || (value.effort !== undefined && !["auto", "low", "medium", "high", "max"].includes(String(value.effort)))
    || (value.maxOutputTokens !== undefined && (!Number.isInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1 || Number(value.maxOutputTokens) > 1_000_000))
    || (value.compactWindow !== undefined && (!Number.isInteger(value.compactWindow) || Number(value.compactWindow) < 1 || Number(value.compactWindow) > 10_000_000))
    || (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1_000 || Number(value.timeoutMs) > 600_000))
    || (value.alwaysThinkingEnabled !== undefined && typeof value.alwaysThinkingEnabled !== "boolean")) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  for (const key of ["opusModel", "sonnetModel", "haikuModel", "subagentModel"]) {
    if (value[key] !== undefined && !parseShortString(value[key])) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  }
  return { ...value, provider, baseUrl, model, ...(apiKey ? { apiKey } : {}), ...(availableModels ? { availableModels: availableModels as string[] } : {}) } as MainSettingsInput;
}

/** 校验独立 Search 连接与复用选择。 */
function parseSearch(value: unknown): SearchSettingsInput {
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["enabled", "useMainKey", "provider", "baseUrl", "model", "apiKey"].includes(key); })) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  const provider = value.provider === "deepseek" || value.provider === "openai-compatible" || value.provider === "xiaomi-mimo" ? value.provider : undefined;
  const baseUrl = parseBaseUrl(value.baseUrl);
  const model = parseShortString(value.model);
  const apiKey = parseApiKey(value.apiKey);
  if (typeof value.enabled !== "boolean" || typeof value.useMainKey !== "boolean" || !provider || !baseUrl || !model || (value.apiKey !== undefined && value.apiKey !== "" && !apiKey)) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  return { enabled: value.enabled, useMainKey: value.useMainKey, provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

/** 校验一个固定 RAG 角色的连接。 */
function parseRagConnection(role: RagRole, value: unknown): RagConnectionInput | null {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["provider", "baseUrl", "model", "apiKey", "dimension"].includes(key); })) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  const expectedProvider = role === "textRerank" || role === "visionRerank" ? "bailian" : role === "textEmbedding" ? "openai-compatible" : "dashscope";
  const baseUrl = parseBaseUrl(value.baseUrl);
  const model = parseShortString(value.model);
  const apiKey = parseApiKey(value.apiKey);
  const embedding = role === "textEmbedding" || role === "multimodalEmbedding";
  if (value.provider !== expectedProvider || !baseUrl || !model || (value.apiKey !== undefined && value.apiKey !== "" && !apiKey)
    || (embedding && (!Number.isInteger(value.dimension) || Number(value.dimension) < 1 || Number(value.dimension) > 65_536))
    || (!embedding && value.dimension !== undefined)) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  return { provider: expectedProvider, baseUrl, model, ...(apiKey ? { apiKey } : {}), ...(embedding ? { dimension: Number(value.dimension) } : {}) };
}

/** 校验分类化设置请求，防止浏览器注入路径、凭据引用或未知字段。 */
export function parseCredentialSettingsInput(value: unknown): CredentialSettingsInput {
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["category", "revision", "main", "search", "rag"].includes(key); })
    || (value.revision !== undefined && (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/u.test(value.revision)))) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
  if (value.category === "main" && value.rag === undefined) return { category: "main", revision: value.revision as string | undefined, main: parseMain(value.main), search: parseSearch(value.search) };
  if (value.category === "rag" && value.main === undefined && value.search === undefined && isRecord(value.rag)) {
    const roles = Object.keys(value.rag);
    if (roles.some(function unknown(role) { return !["textRerank", "visionRerank", "textEmbedding", "multimodalEmbedding"].includes(role); })) throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
    return { category: "rag", revision: value.revision as string | undefined, rag: Object.fromEntries(roles.map(function connection(role) { return [role, parseRagConnection(role as RagRole, (value.rag as Record<string, unknown>)[role])]; })) };
  }
  throw new CredentialSettingsError("INVALID_SETTINGS_INPUT");
}

/** 创建 Web 宿主设置服务；Home 注入只用于隔离测试。 */
export function createCredentialSettingsService(options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {}) {
  const service = createNodeUserSettingsService({ homeDirectory: options.homeDirectory ?? os.homedir() });
  return {
    /** 返回安全状态，不回显任何 Key。 */
    getStatus(): CredentialSettingsStatus {
      return service.getStatus();
    },
    /** 用户主动请求时刷新主模型目录。 */
    refreshMainModelCatalog(): Promise<{ models: string[]; source: "official" | "maintained" }> {
      return service.refreshMainModelCatalog();
    },
    /** 按分类保存，另一分类字段由 Adapter 原子合并并保持不变。 */
    async save(value: unknown): Promise<CredentialSettingsStatus> {
      const input = parseCredentialSettingsInput(value);
      if (input.category === "main") {
        const main = { ...input.main } as Omit<MainSettingsInput, "provider"> & { provider?: MainSettingsInput["provider"] };
        delete main.provider;
        await service.saveMainCategory({ main, search: input.search }, input.revision);
      } else await service.saveRag(input.rag, input.revision);
      return service.getStatus();
    },
  };
}
