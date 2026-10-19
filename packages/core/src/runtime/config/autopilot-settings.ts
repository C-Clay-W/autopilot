/**
 * runtime/config/autopilot-settings.ts — CC-compatible settings 的平台无关解析。
 *
 * Core 仅消费可信宿主传入的纯数据，生成不含认证原文的候选快照；Adapter 负责文件、
 * 权限、热重载和按 CredentialRef 延迟读取用户认证。
 */

import type { CredentialRef } from "../domain";
import { parseExternalPermissionRule } from "../domain/external-permissions";
import type { SandboxMode } from "../domain/sandbox-policy";
import type { ModelRef } from "../domain/model-ref";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import {
  isApiProtocol,
  isProtocolProfileForApiProtocol,
  type ProviderRouteProfile,
} from "../provider/api-protocol";

/** settings 来源优先级；后者仅能覆盖被该 scope 授权的非敏感字段。 */
export type AutopilotSettingsScope = "user" | "project" | "local";

/** 不含配置值、路径、URL 或认证原文的 settings 诊断。 */
export interface SettingsDiagnostic {
  scope: AutopilotSettingsScope;
  code: string;
  field?: string;
}

/** 进入配置系统前的原始 settings 文件内容。 */
export interface AutopilotSettingsSource {
  scope: AutopilotSettingsScope;
  value: unknown;
}

/** 当前 firstParty/Anthropic Messages 配置的安全快照，不包含认证原文。 */
export interface ResolvedFirstPartySettings {
  baseUrl?: string;
  credentialRef?: CredentialRef;
  subagentModelId?: string;
  maxOutputTokens?: number;
  compactWindow?: number;
  timeoutMs?: number;
  thinkingEnabled?: boolean;
}

/** 用户显式启用 Web Search 的安全连接；凭据仍只保存受信引用。 */
export interface ResolvedWebSearchSettings {
  provider: "deepseek" | "openai-compatible" | "xiaomi-mimo";
  baseUrl: string;
  model: string;
  credentialRef: CredentialRef;
}

/** 首版 RAG 角色；每个角色使用独立连接，不能跨角色静默拼接配置。 */
export type RagConnectionRole = "textRerank" | "visionRerank" | "textEmbedding" | "multimodalEmbedding";

/** RAG 专用连接的非敏感快照；凭据只保留固定用途引用。 */
export interface ResolvedRagConnectionSettings {
  provider: "bailian" | "openai-compatible" | "dashscope";
  baseUrl: string;
  model: string;
  credentialRef: CredentialRef;
  dimension?: number;
}

/** 四个 RAG 角色的独立连接；未配置的角色由宿主在 Stage2 决定是否使用旧环境回退。 */
export type ResolvedRagSettings = Readonly<Partial<Record<RagConnectionRole, ResolvedRagConnectionSettings>>>;

/**
 * settings 中沙箱安全字段（Talk-Plan0917 Stage 2）的解析快照。mode 与网络 allowlist
 * 只能由 User scope 声明，Project/Local 不能放宽；deniedRead/deniedWrite 跨 scope 取
 * 并集（只收窄）。danger-full-access 不允许从 settings 文件声明，只能来自宿主代码中的
 * 明确人工操作（RunConfig 边界 2）。
 */
export interface ResolvedSandboxSettings {
  mode?: Exclude<SandboxMode, "danger-full-access">;
  allowedDomains: readonly string[];
  deniedRead: readonly string[];
  deniedWrite: readonly string[];
}

/** Talk-Plan1013 Stage 2：外部权限规则快照；allow 仅来自 local 投影，deny/ask 任意 scope 并集。 */
export interface ResolvedExternalPermissionSettings {
  allow: readonly string[];
  deny: readonly string[];
  ask: readonly string[];
}

/** 供 Runtime 后续阶段消费的安全 settings 快照；未知 CC 字段不进入该对象。 */
export interface ResolvedAutopilotSettings {
  /** 每个执行段最多进行的 Agent 采样/工具循环数；未配置表示无限制。 */
  maxTurns?: number;
  modelRef?: ModelRef;
  /** User-only 视觉角色；false 明确关闭，undefined 保留宿主兼容配置。 */
  visionModelRef?: ModelRef | false;
  modelSource?: "environment" | "settings";
  reasoningProfile?: ReasoningProfile;
  reasoningSource?: "environment" | "settings";
  availableModels: readonly string[];
  /** CC settings 未声明 availableModels 时，由主模型、默认 alias 与子模型组成的可选目录。 */
  modelCandidates: readonly string[];
  modelOverrides: Readonly<Record<string, string>>;
  firstParty: ResolvedFirstPartySettings;
  /** 用户受信配置显式声明的第三方 route；不含明文认证。 */
  providerRoutes: Readonly<Record<string, ProviderRouteProfile>>;
  /** 仅来自 User scope 的 Web Search 配置；不含明文认证。 */
  webSearch?: ResolvedWebSearchSettings;
  webSearchDisabled?: boolean;
  /** 仅来自 User scope 的 RAG 专用连接，不含明文认证。 */
  rag: ResolvedRagSettings;
  /** 沙箱安全字段快照；缺省无声明时列表为空。 */
  sandbox: ResolvedSandboxSettings;
  /** Talk-Plan1013 Stage 2：外部权限规则快照；授权判定仍以 grant 为准，本快照仅供双边校验与展示。 */
  permissions: ResolvedExternalPermissionSettings;
  diagnostics: readonly SettingsDiagnostic[];
}

/** 仅允许从 User scope 消费的 CC 环境变量。 */
const USER_ONLY_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "API_TIMEOUT_MS", "CLAUDE_CODE_DISABLE_AUTO_UPDATE",
  "USER_SETTINGS_WEB_SEARCH_DEEPSEEK",
  "USER_SETTINGS_WEB_SEARCH_OPENAI_COMPATIBLE",
  "USER_SETTINGS_WEB_SEARCH_XIAOMI_MIMO",
  "RAG_TEXT_RERANK_API_KEY", "RAG_VISION_RERANK_API_KEY",
  "RAG_TEXT_EMBEDDING_API_KEY", "RAG_MULTIMODAL_EMBEDDING_API_KEY",
]);
const SECRET_ENV_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "RAG_TEXT_RERANK_API_KEY",
  "RAG_VISION_RERANK_API_KEY", "RAG_TEXT_EMBEDDING_API_KEY", "RAG_MULTIMODAL_EMBEDDING_API_KEY",
  "USER_SETTINGS_WEB_SEARCH_DEEPSEEK",
  "USER_SETTINGS_WEB_SEARCH_OPENAI_COMPATIBLE",
  "USER_SETTINGS_WEB_SEARCH_XIAOMI_MIMO",
]);
const ENDPOINT_ENV_KEYS = new Set(["ANTHROPIC_BASE_URL"]);

/** 将外部 URL 规范化为无尾部斜杠的安全 HTTP(S) 端点。 */
export function normalizeProviderBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** 判断对象是否可安全按字段读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 解析不含控制字符且不含前后空白的模型或环境变量字符串。 */
function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

/** 解析 env；未知变量仅 passthrough，Project/Local 的 User-only 字段必须拒绝。 */
function parseEnvironment(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    diagnostics.push({ scope, code: "SETTINGS_ENV_INVALID", field: "env" });
    return {};
  }
  const environment: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== "string") {
      diagnostics.push({ scope, code: "SETTINGS_ENV_INVALID", field: "env" });
      continue;
    }
    if (!USER_ONLY_ENV_KEYS.has(key)) continue;
    if (scope !== "user") {
      diagnostics.push({
        scope,
        code: SECRET_ENV_KEYS.has(key) ? "SETTINGS_SECRET_SCOPE_FORBIDDEN" : ENDPOINT_ENV_KEYS.has(key) ? "SETTINGS_ENDPOINT_SCOPE_FORBIDDEN" : "SETTINGS_ENV_SCOPE_FORBIDDEN",
        field: `env.${key}`,
      });
      continue;
    }
    environment[key] = candidate;
  }
  return environment;
}

/** 返回 CC alias 的 User env 映射。 */
function getAliases(environment: Record<string, string>): Record<"opus" | "sonnet" | "haiku", string | undefined> {
  return {
    opus: parseNonEmptyString(environment.ANTHROPIC_DEFAULT_OPUS_MODEL),
    sonnet: parseNonEmptyString(environment.ANTHROPIC_DEFAULT_SONNET_MODEL),
    haiku: parseNonEmptyString(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL),
  };
}

/** 将 CC model 值或 alias 解析为 User 声明的完整模型 ID。 */
function resolveModelId(value: unknown, aliases: Record<"opus" | "sonnet" | "haiku", string | undefined>, scope: AutopilotSettingsScope, field: string, diagnostics: SettingsDiagnostic[]): string | undefined {
  const model = parseNonEmptyString(value);
  if (!model) {
    if (value !== undefined) diagnostics.push({ scope, code: "SETTINGS_MODEL_INVALID", field });
    return undefined;
  }
  if (model !== "opus" && model !== "sonnet" && model !== "haiku") return model;
  const mapped = aliases[model];
  if (!mapped) diagnostics.push({ scope, code: "SETTINGS_MODEL_ALIAS_UNRESOLVED", field });
  return mapped;
}

/** 解析顶层 `model` 的 provider/model 选择；裸模型只属于 firstParty。 */
function resolveConfiguredModelRef(
  value: unknown,
  aliases: Record<"opus" | "sonnet" | "haiku", string | undefined>,
  routes: Readonly<Record<string, ProviderRouteProfile>>,
  scope: AutopilotSettingsScope,
  field: string,
  diagnostics: SettingsDiagnostic[],
): ModelRef | undefined {
  const model = parseNonEmptyString(value);
  if (!model) {
    if (value !== undefined) diagnostics.push({ scope, code: "SETTINGS_MODEL_INVALID", field });
    return undefined;
  }
  if (model === "opus" || model === "sonnet" || model === "haiku") {
    const mapped = aliases[model];
    if (!mapped) {
      diagnostics.push({ scope, code: "SETTINGS_MODEL_ALIAS_UNRESOLVED", field });
      return undefined;
    }
    return { provider: "firstParty", modelId: mapped };
  }
  const separator = model.indexOf("/");
  if (separator < 0) return { provider: "firstParty", modelId: model };
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  if (provider === "firstParty" && parseNonEmptyString(modelId)) return { provider, modelId };
  const route = routes[provider];
  if (!route || !parseNonEmptyString(modelId) || !route.models.some(function hasModel(candidate) { return candidate.id === modelId; })) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_NOT_ALLOWED", field });
    return undefined;
  }
  return { provider, modelId };
}

/** 验证 User availableModels 的字符串数组；该数组只限制后续显式选择，不推断能力。 */
function parseAvailableModels(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_INVALID", field: "availableModels" });
    return undefined;
  }
  const models = value.map(parseNonEmptyString);
  if (models.some((model) => !model) || new Set(models).size !== models.length) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_INVALID", field: "availableModels" });
    return undefined;
  }
  return models as string[];
}

/** 合并模型候选并保持配置中的稳定顺序。 */
function mergeModelCandidates(...groups: ReadonlyArray<readonly (string | undefined)[]>): readonly string[] {
  const candidates: string[] = [];
  for (const group of groups) {
    for (const modelId of group) {
      if (modelId && !candidates.includes(modelId)) candidates.push(modelId);
    }
  }
  return candidates;
}

/** 验证单跳 modelOverrides，拒绝空值、循环和链式替换。 */
function parseModelOverrides(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_OVERRIDE_INVALID", field: "modelOverrides" });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([source, target]) => !parseNonEmptyString(source) || !parseNonEmptyString(target))) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_OVERRIDE_INVALID", field: "modelOverrides" });
    return undefined;
  }
  const keys = new Set(entries.map(([source]) => source));
  if (entries.some(([source, target]) => source === target || keys.has(target as string))) {
    diagnostics.push({ scope, code: "SETTINGS_MODEL_OVERRIDE_INVALID", field: "modelOverrides" });
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries as Array<[string, string]>));
}

/** 解析 route 的 credential 引用，禁止 route 借用其他 Provider 的凭据命名空间。 */
function parseRouteCredentialRef(value: unknown, routeId: string): CredentialRef | undefined {
  if (!isRecord(value) || value.provider !== routeId) return undefined;
  const key = parseNonEmptyString(value.key);
  return key ? { provider: routeId, key } : undefined;
}

/** 解析 Web Search 连接；旧的仅凭据引用形状按 DeepSeek 官方连接兼容读取。 */
function parseWebSearchSettings(value: unknown): ResolvedWebSearchSettings | undefined {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "credentialRef")) return undefined;
  if (!isRecord(value.credentialRef) || Object.keys(value.credentialRef).length !== 2) return undefined;
  const referenceProvider = parseNonEmptyString(value.credentialRef.provider);
  const key = parseNonEmptyString(value.credentialRef.key);
  if (!referenceProvider || !key) return undefined;
  if (Object.keys(value).length === 1 && referenceProvider === "deepseek") return Object.freeze({ provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", credentialRef: { provider: referenceProvider, key } });
  if (Object.keys(value).length !== 4) return undefined;
  const provider = value.provider === "deepseek" || value.provider === "openai-compatible" || value.provider === "xiaomi-mimo" ? value.provider : undefined;
  const baseUrl = normalizeProviderBaseUrl(value.baseUrl);
  const model = parseNonEmptyString(value.model);
  return provider && referenceProvider === provider && baseUrl && model
    ? Object.freeze({ provider, baseUrl, model, credentialRef: { provider: referenceProvider, key } })
    : undefined;
}

const RAG_ROLE_CONTRACT = Object.freeze({
  textRerank: { provider: "bailian", key: "RAG_TEXT_RERANK_API_KEY", dimension: false },
  visionRerank: { provider: "bailian", key: "RAG_VISION_RERANK_API_KEY", dimension: false },
  textEmbedding: { provider: "openai-compatible", key: "RAG_TEXT_EMBEDDING_API_KEY", dimension: true },
  multimodalEmbedding: { provider: "dashscope", key: "RAG_MULTIMODAL_EMBEDDING_API_KEY", dimension: true },
} as const);

/** 解析一项完整 RAG 角色连接；显式不完整时仅产生诊断，不允许混入其他角色或旧宿主凭据。 */
function parseRagConnection(role: RagConnectionRole, value: unknown, environment: Record<string, string>, diagnostics: SettingsDiagnostic[]): ResolvedRagConnectionSettings | undefined {
  const contract = RAG_ROLE_CONTRACT[role];
  const field = `rag.${role}`;
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["provider", "baseUrl", "model", ...(contract.dimension ? ["dimension"] : [])].includes(key); })) {
    diagnostics.push({ scope: "user", code: "SETTINGS_RAG_CONNECTION_INVALID", field });
    return undefined;
  }
  const provider = parseNonEmptyString(value.provider);
  const baseUrl = normalizeProviderBaseUrl(value.baseUrl);
  const model = parseNonEmptyString(value.model);
  const credential = parseNonEmptyString(environment[contract.key]);
  const dimension = contract.dimension && Number.isInteger(value.dimension) && (value.dimension as number) >= 1 && (value.dimension as number) <= 65_536
    ? value.dimension as number
    : undefined;
  if (provider !== contract.provider || !baseUrl || !model || !credential || (contract.dimension && !dimension)) {
    diagnostics.push({ scope: "user", code: "SETTINGS_RAG_CONNECTION_INVALID", field });
    return undefined;
  }
  return Object.freeze({
    provider: contract.provider,
    baseUrl,
    model,
    credentialRef: { provider: `rag-${role}`, key: contract.key },
    ...(dimension ? { dimension } : {}),
  });
}

/** 解析固定四角色 RAG 配置；未知角色和非 User 声明均拒绝。 */
function parseRagSettings(value: unknown, environment: Record<string, string>, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): ResolvedRagSettings | undefined {
  if (value === undefined) return undefined;
  if (scope !== "user") {
    diagnostics.push({ scope, code: "SETTINGS_RAG_SCOPE_FORBIDDEN", field: "rag" });
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).some(function unknown(role) { return !Object.prototype.hasOwnProperty.call(RAG_ROLE_CONTRACT, role); })) {
    diagnostics.push({ scope, code: "SETTINGS_RAG_INVALID", field: "rag" });
    return undefined;
  }
  const rag: Partial<Record<RagConnectionRole, ResolvedRagConnectionSettings>> = {};
  for (const role of Object.keys(value) as RagConnectionRole[]) {
    const connection = parseRagConnection(role, value[role], environment, diagnostics);
    if (connection) rag[role] = connection;
  }
  return Object.freeze(rag);
}

/** 校验沙箱列表字段：非空字符串、去重，且拒绝裸 `*` 通配兜底。 */
function parseSandboxStringList(value: unknown, scope: AutopilotSettingsScope, field: string, diagnostics: SettingsDiagnostic[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push({ scope, code: "SETTINGS_SANDBOX_INVALID", field });
    return undefined;
  }
  const items = value.map(parseNonEmptyString);
  if (items.some((item) => !item) || new Set(items).size !== items.length || items.some((item) => item === "*")) {
    diagnostics.push({ scope, code: "SETTINGS_SANDBOX_INVALID", field });
    return undefined;
  }
  return Object.freeze(items as string[]);
}

/** 解析 settings 的 sandbox 段；mode 与 allowlist 仅 User scope，deny 列表任意 scope 并集收窄。 */
function parseSandboxSettings(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): Partial<ResolvedSandboxSettings> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["mode", "allowedDomains", "deniedRead", "deniedWrite"].includes(key); })) {
    diagnostics.push({ scope, code: "SETTINGS_SANDBOX_INVALID", field: "sandbox" });
    return {};
  }
  const isUser = scope === "user";
  let mode: ResolvedSandboxSettings["mode"];
  if (value.mode !== undefined) {
    if (!isUser) diagnostics.push({ scope, code: "SETTINGS_SANDBOX_SCOPE_FORBIDDEN", field: "sandbox.mode" });
    else if (value.mode === "read-only" || value.mode === "workspace-write") mode = value.mode;
    else diagnostics.push({ scope, code: value.mode === "danger-full-access" ? "SETTINGS_SANDBOX_MODE_FORBIDDEN" : "SETTINGS_SANDBOX_INVALID", field: "sandbox.mode" });
  }
  let allowedDomains: readonly string[] | undefined;
  if (value.allowedDomains !== undefined) {
    if (!isUser) diagnostics.push({ scope, code: "SETTINGS_SANDBOX_SCOPE_FORBIDDEN", field: "sandbox.allowedDomains" });
    else allowedDomains = parseSandboxStringList(value.allowedDomains, scope, "sandbox.allowedDomains", diagnostics);
  }
  const deniedRead = parseSandboxStringList(value.deniedRead, scope, "sandbox.deniedRead", diagnostics);
  const deniedWrite = parseSandboxStringList(value.deniedWrite, scope, "sandbox.deniedWrite", diagnostics);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(allowedDomains !== undefined ? { allowedDomains } : {}),
    ...(deniedRead !== undefined ? { deniedRead } : {}),
    ...(deniedWrite !== undefined ? { deniedWrite } : {}),
  };
}

/** 解析外部权限规则列表：条目必须符合 Write|Edit|Read(<绝对路径>) 语法，非法整列表丢弃。 */
function parseExternalPermissionList(value: unknown, scope: AutopilotSettingsScope, field: string, diagnostics: SettingsDiagnostic[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push({ scope, code: "SETTINGS_PERMISSIONS_INVALID", field });
    return undefined;
  }
  const items = value.map(parseNonEmptyString);
  if (items.some((item) => !item || !parseExternalPermissionRule(item!))) {
    diagnostics.push({ scope, code: "SETTINGS_PERMISSIONS_INVALID", field });
    return undefined;
  }
  return Object.freeze(items as string[]);
}

/** 解析 settings 的 permissions 段：allow 仅 local（投影写入口），deny/ask 任意 scope 并集收窄。 */
function parseExternalPermissions(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): Partial<ResolvedExternalPermissionSettings> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(function unknown(key) { return !["allow", "deny", "ask"].includes(key); })) {
    diagnostics.push({ scope, code: "SETTINGS_PERMISSIONS_INVALID", field: "permissions" });
    return {};
  }
  let allow: readonly string[] | undefined;
  if (value.allow !== undefined) {
    if (scope !== "local") diagnostics.push({ scope, code: "SETTINGS_PERMISSIONS_SCOPE_FORBIDDEN", field: "permissions.allow" });
    else allow = parseExternalPermissionList(value.allow, scope, "permissions.allow", diagnostics);
  }
  const deny = parseExternalPermissionList(value.deny, scope, "permissions.deny", diagnostics);
  const ask = parseExternalPermissionList(value.ask, scope, "permissions.ask", diagnostics);
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
    ...(ask !== undefined ? { ask } : {}),
  };
}

/** 解析显式 route 的模型清单、受信兼容 profile 覆盖与受信上下文窗口声明。 */
function parseRouteModels(value: unknown, apiProtocol: ProviderRouteProfile["apiProtocol"]): ProviderRouteProfile["models"] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const models: Array<{ id: string; protocolProfile?: ProviderRouteProfile["protocolProfile"]; contextWindowTokens?: number }> = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const id = parseNonEmptyString(item.id);
    if (!id || models.some(function hasSameId(model) { return model.id === id; })) return undefined;
    if (item.protocolProfile !== undefined && !isProtocolProfileForApiProtocol(item.protocolProfile, apiProtocol)) return undefined;
    const contextWindowTokens = item.contextWindowTokens === undefined
      ? undefined
      : Number.isSafeInteger(item.contextWindowTokens) && (item.contextWindowTokens as number) >= 1 && (item.contextWindowTokens as number) <= 10_000_000
        ? item.contextWindowTokens as number
        : undefined;
    if (item.contextWindowTokens !== undefined && contextWindowTokens === undefined) return undefined;
    models.push({
      id,
      ...(item.protocolProfile !== undefined ? { protocolProfile: item.protocolProfile } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    });
  }
  return Object.freeze(models);
}

/** 解析 User scope 的任意受信 Provider route 字典；任何不完整条目均不进入运行快照。 */
function parseProviderRoutes(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): Readonly<Record<string, ProviderRouteProfile>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push({ scope, code: "SETTINGS_PROVIDER_ROUTE_INVALID", field: "providerRoutes" });
    return undefined;
  }
  const routes: Record<string, ProviderRouteProfile> = {};
  for (const [routeId, rawRoute] of Object.entries(value)) {
    if (!parseNonEmptyString(routeId) || !isRecord(rawRoute) || rawRoute.id !== routeId || !isApiProtocol(rawRoute.apiProtocol)) {
      diagnostics.push({ scope, code: "SETTINGS_PROVIDER_ROUTE_INVALID", field: "providerRoutes" });
      return undefined;
    }
    const baseUrl = normalizeProviderBaseUrl(rawRoute.baseUrl);
    const credentialRef = parseRouteCredentialRef(rawRoute.credentialRef, routeId);
    const models = parseRouteModels(rawRoute.models, rawRoute.apiProtocol);
    if (!baseUrl || !credentialRef || !models || (rawRoute.protocolProfile !== undefined && !isProtocolProfileForApiProtocol(rawRoute.protocolProfile, rawRoute.apiProtocol))) {
      diagnostics.push({ scope, code: "SETTINGS_PROVIDER_ROUTE_INVALID", field: "providerRoutes" });
      return undefined;
    }
    const displayName = rawRoute.displayName === undefined ? undefined : parseNonEmptyString(rawRoute.displayName);
    if (rawRoute.displayName !== undefined && !displayName) {
      diagnostics.push({ scope, code: "SETTINGS_PROVIDER_ROUTE_INVALID", field: "providerRoutes" });
      return undefined;
    }
    routes[routeId] = Object.freeze({
      id: routeId,
      ...(displayName ? { displayName } : {}),
      apiProtocol: rawRoute.apiProtocol,
      baseUrl,
      credentialRef,
      ...(rawRoute.protocolProfile !== undefined ? { protocolProfile: rawRoute.protocolProfile } : {}),
      models,
    });
  }
  return Object.freeze(routes);
}

/** 对一个已经解析的模型 ID 应用单跳 override，不递归追踪目标，防止循环或隐式路由。 */
function applyModelOverride(modelId: string | undefined, overrides: Readonly<Record<string, string>>): string | undefined {
  return modelId ? overrides[modelId] ?? modelId : undefined;
}

/** 将最终主/子模型路由收敛到 allowlist、route 清单和单跳 override。 */
function finalizeModelRouting(resolved: ResolvedAutopilotSettings, diagnostics: SettingsDiagnostic[]): ResolvedAutopilotSettings {
  const resolveSelectedModel = function resolveSelectedModel(modelRef: ModelRef | undefined, field: string): ModelRef | undefined {
    if (!modelRef) return undefined;
    const routed = modelRef.provider === "firstParty"
      ? applyModelOverride(modelRef.modelId, resolved.modelOverrides)
      : applyModelOverride(`${modelRef.provider}/${modelRef.modelId}`, resolved.modelOverrides);
    const selected = routed && routed.includes("/")
      ? resolveConfiguredModelRef(routed, { opus: undefined, sonnet: undefined, haiku: undefined }, resolved.providerRoutes, "user", field, diagnostics)
      : routed ? { provider: modelRef.provider, modelId: routed } : undefined;
    if (!selected) return undefined;
    if (selected.provider === "firstParty" && resolved.availableModels.length > 0 && !resolved.availableModels.includes(selected.modelId)) {
      diagnostics.push({ scope: "user", code: "SETTINGS_MODEL_NOT_ALLOWED", field });
      return undefined;
    }
    const route = selected.provider === "firstParty" ? undefined : resolved.providerRoutes[selected.provider];
    if (selected.provider !== "firstParty" && (!route || !route.models.some(function hasModel(candidate) { return candidate.id === selected.modelId; }))) {
      diagnostics.push({ scope: "user", code: "SETTINGS_MODEL_NOT_ALLOWED", field });
      return undefined;
    }
    return selected;
  };
  const primaryModelRef = resolveSelectedModel(resolved.modelRef, "model");
  const subagentModelRef = resolveSelectedModel(resolved.firstParty.subagentModelId ? { provider: "firstParty", modelId: resolved.firstParty.subagentModelId } : undefined, "env.CLAUDE_CODE_SUBAGENT_MODEL");
  const subagentModelId = subagentModelRef?.provider === "firstParty" ? subagentModelRef.modelId : undefined;
  const modelCandidates = mergeModelCandidates(
    resolved.modelCandidates.map(function applyCandidateOverride(modelId) { return applyModelOverride(modelId, resolved.modelOverrides); }),
    [primaryModelRef ? primaryModelRef.provider === "firstParty" ? primaryModelRef.modelId : `${primaryModelRef.provider}/${primaryModelRef.modelId}` : undefined, subagentModelId],
  );
  return {
    ...resolved,
    modelRef: primaryModelRef,
    modelCandidates,
    firstParty: { ...resolved.firstParty, subagentModelId },
  };
}

/** 解析 CC 顶层 effortLevel；max/xhigh/ultra 不属于顶层有效值域。 */
function parseTopLevelEffort(value: unknown, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): ReasoningProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return { effort: value };
  diagnostics.push({ scope, code: "SETTINGS_EFFORT_INVALID", field: "effortLevel" });
  return undefined;
}

/** 解析 CC env effort；auto/unset 明确删除显式请求。 */
function parseEnvironmentEffort(value: string | undefined, scope: AutopilotSettingsScope, diagnostics: SettingsDiagnostic[]): ReasoningProfile | undefined | "unset" {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "unset") return "unset";
  if (value === "low" || value === "medium" || value === "high" || value === "max") return { effort: value };
  diagnostics.push({ scope, code: "SETTINGS_EFFORT_INVALID", field: "env.CLAUDE_CODE_EFFORT_LEVEL" });
  return undefined;
}

/** 解析有界十进制 env 数值，拒绝浮点、负号与越界输入。 */
function parseEnvironmentInteger(value: string | undefined, minimum: number, maximum: number, scope: AutopilotSettingsScope, field: string, diagnostics: SettingsDiagnostic[]): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    diagnostics.push({ scope, code: "SETTINGS_VALUE_OUT_OF_RANGE", field });
    return undefined;
  }
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < minimum || numberValue > maximum) {
    diagnostics.push({ scope, code: "SETTINGS_VALUE_OUT_OF_RANGE", field });
    return undefined;
  }
  return numberValue;
}

/** 解析用户 settings 顶层有界整数；无效值只产生诊断，不进入运行时。 */
function parseSettingsInteger(value: unknown, minimum: number, maximum: number, scope: AutopilotSettingsScope, field: string, diagnostics: SettingsDiagnostic[]): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    diagnostics.push({ scope, code: "SETTINGS_VALUE_OUT_OF_RANGE", field });
    return undefined;
  }
  return Number(value);
}

/** 将一份 CC-compatible settings 按 scope 合入安全快照。 */
function mergeCcSource(current: ResolvedAutopilotSettings, source: AutopilotSettingsSource, diagnostics: SettingsDiagnostic[]): ResolvedAutopilotSettings {
  if (!isRecord(source.value)) {
    diagnostics.push({ scope: source.scope, code: "SETTINGS_SOURCE_IGNORED" });
    return current;
  }
  const isUser = source.scope === "user";
  const environment = parseEnvironment(source.value.env, source.scope, diagnostics);
  const aliases = getAliases(environment);
  const envModel = isUser ? resolveModelId(environment.ANTHROPIC_MODEL, aliases, source.scope, "env.ANTHROPIC_MODEL", diagnostics) : undefined;
  const requestedProviderRoutes = parseProviderRoutes(source.value.providerRoutes, source.scope, diagnostics);
  if (!isUser && source.value.providerRoutes !== undefined) diagnostics.push({ scope: source.scope, code: "SETTINGS_PROVIDER_ROUTE_SCOPE_FORBIDDEN", field: "providerRoutes" });
  const providerRoutes = isUser && requestedProviderRoutes ? requestedProviderRoutes : current.providerRoutes;
  let visionModelRef = current.visionModelRef;
  if (source.value.visionModel !== undefined) {
    if (!isUser) diagnostics.push({ scope: source.scope, code: "SETTINGS_MODEL_NOT_ALLOWED", field: "visionModel" });
    else if (source.value.visionModel === false) visionModelRef = false;
    else {
      const requestedVision = resolveConfiguredModelRef(source.value.visionModel, aliases, providerRoutes, source.scope, "visionModel", diagnostics);
      const route = requestedVision && providerRoutes[requestedVision.provider];
      if (!requestedVision || route?.apiProtocol !== "openai-chat-completions" || !route.models.some(function matches(model) { return model.id === requestedVision.modelId; })) {
        diagnostics.push({ scope: source.scope, code: "SETTINGS_MODEL_NOT_ALLOWED", field: "visionModel" });
        visionModelRef = false;
      } else visionModelRef = requestedVision;
    }
  }
  const explicitWebSearch = parseWebSearchSettings(source.value.webSearch);
  const requestedWebSearch = source.value.webSearch !== undefined ? explicitWebSearch
    : (isUser && parseNonEmptyString(environment.USER_SETTINGS_WEB_SEARCH_DEEPSEEK)
      ? { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", credentialRef: { provider: "deepseek", key: "USER_SETTINGS_WEB_SEARCH_DEEPSEEK" } }
      : isUser && parseNonEmptyString(environment.USER_SETTINGS_WEB_SEARCH_XIAOMI_MIMO)
        ? { provider: "xiaomi-mimo" as const, baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5", credentialRef: { provider: "xiaomi-mimo", key: "USER_SETTINGS_WEB_SEARCH_XIAOMI_MIMO" } }
        : undefined);
  if (source.value.webSearch !== undefined && !isUser) diagnostics.push({ scope: source.scope, code: "SETTINGS_WEB_SEARCH_SCOPE_FORBIDDEN", field: "webSearch" });
  else if (source.value.webSearch !== undefined && source.value.webSearch !== false && !requestedWebSearch) diagnostics.push({ scope: source.scope, code: "SETTINGS_WEB_SEARCH_INVALID", field: "webSearch" });
  const webSearchDisabled = isUser && source.value.webSearch !== undefined ? source.value.webSearch === false : current.webSearchDisabled;
  const webSearch = webSearchDisabled ? undefined : isUser && requestedWebSearch ? requestedWebSearch : current.webSearch;
  const requestedRag = parseRagSettings(source.value.rag, environment, source.scope, diagnostics);
  const rag = isUser && requestedRag ? requestedRag : current.rag;
  const topLevelModel = resolveConfiguredModelRef(source.value.model, aliases, providerRoutes, source.scope, "model", diagnostics);
  const requestedModel = envModel ? { provider: "firstParty" as const, modelId: envModel } : topLevelModel;
  const requestedModelSource = envModel ? "environment" as const : topLevelModel ? "settings" as const : undefined;
  const requestedAvailableModels = parseAvailableModels(source.value.availableModels, source.scope, diagnostics);
  if (!isUser && source.value.availableModels !== undefined) diagnostics.push({ scope: source.scope, code: "SETTINGS_MODEL_INVALID", field: "availableModels" });
  const availableModels = isUser && requestedAvailableModels ? requestedAvailableModels : current.availableModels;
  const requestedOverrides = parseModelOverrides(source.value.modelOverrides, source.scope, diagnostics);
  if (!isUser && source.value.modelOverrides !== undefined) diagnostics.push({ scope: source.scope, code: "SETTINGS_MODEL_OVERRIDE_INVALID", field: "modelOverrides" });
  const modelOverrides = isUser && requestedOverrides ? requestedOverrides : current.modelOverrides;
  let modelRef = current.modelRef;
  let modelSource = current.modelSource;
  if (requestedModel) {
    const requestedModelId = requestedModel.provider === "firstParty" ? requestedModel.modelId : `${requestedModel.provider}/${requestedModel.modelId}`;
    const routeAllowsModel = requestedModel.provider === "firstParty"
      ? availableModels.includes(requestedModel.modelId)
      : Boolean(providerRoutes[requestedModel.provider]?.models.some(function hasModel(candidate) { return candidate.id === requestedModel.modelId; }));
    if (!isUser && !availableModels.includes(requestedModelId) && !routeAllowsModel) diagnostics.push({ scope: source.scope, code: "SETTINGS_MODEL_NOT_ALLOWED", field: "model" });
    else if (isUser || current.modelSource !== "environment") {
      modelRef = requestedModel;
      modelSource = requestedModelSource;
    }
  }
  const parsedBaseUrl = isUser && environment.ANTHROPIC_BASE_URL !== undefined ? normalizeProviderBaseUrl(environment.ANTHROPIC_BASE_URL) : undefined;
  if (isUser && environment.ANTHROPIC_BASE_URL !== undefined && !parsedBaseUrl) diagnostics.push({ scope: source.scope, code: "SETTINGS_BASE_URL_INVALID", field: "env.ANTHROPIC_BASE_URL" });
  const hasAuthToken = Boolean(parseNonEmptyString(environment.ANTHROPIC_AUTH_TOKEN));
  const hasApiKey = Boolean(parseNonEmptyString(environment.ANTHROPIC_API_KEY));
  let credentialRef = current.firstParty.credentialRef;
  if (isUser && hasAuthToken && hasApiKey) {
    diagnostics.push({ scope: source.scope, code: "SETTINGS_AUTH_CONFLICT", field: "env" });
    credentialRef = undefined;
  } else if (isUser && hasAuthToken) credentialRef = { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" };
  else if (isUser && hasApiKey) credentialRef = { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_API_KEY" };
  const environmentEffort = isUser ? parseEnvironmentEffort(environment.CLAUDE_CODE_EFFORT_LEVEL, source.scope, diagnostics) : undefined;
  const topLevelEffort = parseTopLevelEffort(source.value.effortLevel, source.scope, diagnostics);
  let reasoningProfile = current.reasoningProfile;
  let reasoningSource = current.reasoningSource;
  if (environmentEffort === "unset") {
    reasoningProfile = undefined;
    reasoningSource = "environment";
  } else if (environmentEffort) {
    reasoningProfile = environmentEffort;
    reasoningSource = "environment";
  } else if (topLevelEffort && (isUser || current.reasoningSource !== "environment")) {
    reasoningProfile = topLevelEffort;
    reasoningSource = "settings";
  }
  const thinkingEnabled = source.value.alwaysThinkingEnabled === undefined ? current.firstParty.thinkingEnabled : typeof source.value.alwaysThinkingEnabled === "boolean" ? source.value.alwaysThinkingEnabled : current.firstParty.thinkingEnabled;
  if (source.value.alwaysThinkingEnabled !== undefined && typeof source.value.alwaysThinkingEnabled !== "boolean") diagnostics.push({ scope: source.scope, code: "SETTINGS_VALUE_OUT_OF_RANGE", field: "alwaysThinkingEnabled" });
  const requestedMaxOutputTokens = parseSettingsInteger(source.value.maxOutputTokens, 1, 1_000_000, source.scope, "maxOutputTokens", diagnostics);
  const requestedMaxTurns = parseSettingsInteger(source.value.maxTurns, 1, Number.MAX_SAFE_INTEGER, source.scope, "maxTurns", diagnostics);
  const maxTurns = requestedMaxTurns ?? current.maxTurns;
  if (!isUser && source.value.maxOutputTokens !== undefined) diagnostics.push({ scope: source.scope, code: "SETTINGS_OUTPUT_TOKENS_SCOPE_FORBIDDEN", field: "maxOutputTokens" });
  const maxOutputTokens = isUser && requestedMaxOutputTokens !== undefined ? requestedMaxOutputTokens : current.firstParty.maxOutputTokens;
  const compactWindow = isUser ? parseEnvironmentInteger(environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 1, 10_000_000, source.scope, "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW", diagnostics) ?? current.firstParty.compactWindow : current.firstParty.compactWindow;
  const timeoutMs = isUser ? parseEnvironmentInteger(environment.API_TIMEOUT_MS, 1_000, 600_000, source.scope, "env.API_TIMEOUT_MS", diagnostics) ?? current.firstParty.timeoutMs : current.firstParty.timeoutMs;
  const subagentModelId = isUser && environment.CLAUDE_CODE_SUBAGENT_MODEL !== undefined
    ? resolveModelId(environment.CLAUDE_CODE_SUBAGENT_MODEL, aliases, source.scope, "env.CLAUDE_CODE_SUBAGENT_MODEL", diagnostics) ?? current.firstParty.subagentModelId
    : current.firstParty.subagentModelId;
  const routeModelCandidates = Object.values(providerRoutes).flatMap(function collectRouteModels(route) {
    return route.models.map(function qualifyRouteModel(model) { return `${route.id}/${model.id}`; });
  });
  const modelCandidates = isUser
    ? mergeModelCandidates(
        requestedAvailableModels ?? current.modelCandidates,
        [envModel, topLevelModel?.provider === "firstParty" ? topLevelModel.modelId : topLevelModel ? `${topLevelModel.provider}/${topLevelModel.modelId}` : undefined, ...Object.values(aliases), subagentModelId],
        routeModelCandidates,
      )
    : current.modelCandidates;
  // 沙箱安全字段：mode/allowlist 只由 User 声明（后续 scope 声明已被诊断拒绝），
  // deny 列表按并集累积，只收窄不放宽。
  const requestedSandbox = parseSandboxSettings(source.value.sandbox, source.scope, diagnostics);
  const sandbox: ResolvedSandboxSettings = {
    mode: requestedSandbox.mode ?? current.sandbox.mode,
    allowedDomains: requestedSandbox.allowedDomains ?? current.sandbox.allowedDomains,
    deniedRead: Object.freeze([...current.sandbox.deniedRead, ...(requestedSandbox.deniedRead ?? [])]),
    deniedWrite: Object.freeze([...current.sandbox.deniedWrite, ...(requestedSandbox.deniedWrite ?? [])]),
  };
  // Talk-Plan1013 Stage 2：外部权限规则快照。allow 只由 local 投影贡献（授权判定仍以 grant 为准），
  // deny/ask 按并集累积只收窄；手写 allow 不获得 authority（16.4 导入边界）。
  const requestedPermissions = parseExternalPermissions(source.value.permissions, source.scope, diagnostics);
  const permissions: ResolvedExternalPermissionSettings = {
    allow: Object.freeze([...current.permissions.allow, ...(requestedPermissions.allow ?? [])]),
    deny: Object.freeze([...current.permissions.deny, ...(requestedPermissions.deny ?? [])]),
    ask: Object.freeze([...current.permissions.ask, ...(requestedPermissions.ask ?? [])]),
  };
  return { ...current, maxTurns, modelRef, visionModelRef, modelSource, reasoningProfile, reasoningSource, availableModels, modelCandidates, modelOverrides, providerRoutes, webSearch, webSearchDisabled, rag, sandbox, permissions, firstParty: { baseUrl: parsedBaseUrl ?? current.firstParty.baseUrl, credentialRef, maxOutputTokens, compactWindow, timeoutMs, subagentModelId, thinkingEnabled }, diagnostics: current.diagnostics };
}

/** 依照 User < Project < Local 优先级构建一次可原子替换的 settings 快照。 */
export function resolveAutopilotSettings(sources: readonly AutopilotSettingsSource[]): ResolvedAutopilotSettings {
  const diagnostics: SettingsDiagnostic[] = [];
  let resolved: ResolvedAutopilotSettings = { availableModels: [], modelCandidates: [], modelOverrides: Object.freeze({}), firstParty: {}, providerRoutes: Object.freeze({}), rag: Object.freeze({}), sandbox: { allowedDomains: Object.freeze([]), deniedRead: Object.freeze([]), deniedWrite: Object.freeze([]) }, permissions: { allow: Object.freeze([]), deny: Object.freeze([]), ask: Object.freeze([]) }, diagnostics };
  const priority: AutopilotSettingsScope[] = ["user", "project", "local"];
  for (const scope of priority) {
    for (const source of sources.filter((item) => item.scope === scope)) {
      if (!isRecord(source.value)) {
        diagnostics.push({ scope: source.scope, code: "SETTINGS_SOURCE_IGNORED" });
        continue;
      }
      const version = source.value.schemaVersion;
      if (version === undefined) resolved = mergeCcSource(resolved, source, diagnostics);
      else diagnostics.push({ scope: source.scope, code: "SETTINGS_SCHEMA_VERSION_UNSUPPORTED", field: "schemaVersion" });
    }
  }
  return { ...finalizeModelRouting(resolved, diagnostics), diagnostics };
}
