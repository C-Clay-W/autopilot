/**
 * Node 用户设置分类保存服务：原子合并三种主模型协议与 RAG 配置，兼容旧 Anthropic 主连接。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isExternalPermissionDiagnostic, normalizeProviderBaseUrl, resolveAutopilotSettings, resolveRouteModelCapability, type ApiProtocol, type ProviderRouteProfile, type ReasoningEffort, type SettingsDiagnostic } from "@autopilot-agent/core";
import { atomicReplace, withFileLock } from "../file-utils";
import { ensureUserConfigDirectory } from "./user-config-directory";
import { resolveNodeUserSettingsPath } from "./node-settings-loader";

const RAG_ROLE_CONTRACT = Object.freeze({
  textRerank: { provider: "bailian", key: "RAG_TEXT_RERANK_API_KEY", dimension: false },
  visionRerank: { provider: "bailian", key: "RAG_VISION_RERANK_API_KEY", dimension: false },
  textEmbedding: { provider: "openai-compatible", key: "RAG_TEXT_EMBEDDING_API_KEY", dimension: true },
  multimodalEmbedding: { provider: "dashscope", key: "RAG_MULTIMODAL_EMBEDDING_API_KEY", dimension: true },
} as const);

/** Adapter 分类写入允许的固定 RAG 角色，与 Core 用户 settings 契约同名。 */
type RagConnectionRole = keyof typeof RAG_ROLE_CONTRACT;

/** 主模型分类提交值；Key 留空时仅允许沿用无冲突的同一主连接凭据。 */
export interface MainSettingsCategoryInput {
  apiProtocol?: ApiProtocol;
  compatibilityPreset?: ProviderRouteProfile["compatibilityPreset"];
  baseUrl: string;
  model: string;
  apiKey?: string;
  availableModels?: string[];
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  subagentModel?: string;
  effort?: "auto" | ReasoningEffort;
  maxOutputTokens?: number;
  compactWindow?: number;
  timeoutMs?: number;
  alwaysThinkingEnabled?: boolean;
}

/** 仅供设置表单预览的连接元数据，不含凭据或内部路由标识。 */
export type MainModelCapabilitiesInput = Pick<MainSettingsCategoryInput, "apiProtocol" | "compatibilityPreset" | "baseUrl" | "model">;

/** 由 Core 统一解析的可请求强度和 Agent 工具能力。 */
export interface MainModelCapabilities {
  supportedReasoningEfforts: readonly ReasoningEffort[];
  supportsToolCalls: boolean;
}

/** 单个 RAG 角色提交值；Embedding 角色必须显式给出维度。 */
export interface RagSettingsCategoryConnectionInput {
  provider: "bailian" | "openai-compatible" | "dashscope";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimension?: number;
}

/** RAG 分类按角色增量更新；null 明确删除，缺省保持原值。 */
export type RagSettingsCategoryInput = Partial<Record<RagConnectionRole, RagSettingsCategoryConnectionInput | null>>;

/** Search 与主模型同属主模型分类，但保持独立搜索连接和凭据。 */
export interface WebSearchSettingsCategoryInput {
  enabled: boolean;
  useMainKey: boolean;
  provider: "deepseek" | "openai-compatible" | "xiaomi-mimo";
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** 设置页可展示的脱敏诊断：只有错误码、字段路径与作用域，不含配置值。 */
export interface UserSettingsDiagnostic {
  code: string;
  field?: string;
  scope: string;
}

/** Web 设置页读取的安全快照；只包含连接元数据、凭据是否存在与权限段脱敏诊断。 */
export interface UserSettingsStatus {
  revision: string;
  main: Omit<MainSettingsCategoryInput, "apiKey"> & { provider: "deepseek" | "custom"; configured: boolean };
  search: Omit<WebSearchSettingsCategoryInput, "apiKey"> & { configured: boolean };
  rag: Record<RagConnectionRole, RagSettingsCategoryConnectionInput & { configured: boolean }>;
  /** 权限段单独隔离：模型字段仍可用，页面按类别说明不支持的字段与作用域。 */
  diagnostics: UserSettingsDiagnostic[];
}

/** 主模型分类一次提交主连接与 Search，避免分类内两次写入产生修订竞争。 */
export interface MainSettingsCategoryUpdate {
  main: MainSettingsCategoryInput;
  search: WebSearchSettingsCategoryInput;
}

/** 分类写入后的安全状态，不包含配置正文、路径或凭据。 */
export interface UserSettingsWriteResult {
  revision: string;
  configured: boolean;
}

/** 主模型目录刷新结果；失败时明确回退到随版本维护目录。 */
export interface MainModelCatalogResult {
  models: string[];
  source: "official" | "maintained";
}

/** 用户设置保存错误；调用方只能按稳定码展示，不回显底层内容。 */
export class NodeUserSettingsError extends Error {
  constructor(
    public readonly code: "SETTINGS_INVALID" | "SETTINGS_CHANGED" | "SETTINGS_INPUT_INVALID" | "SETTINGS_KEY_REQUIRED" | "SETTINGS_MIGRATION_CONFLICT",
    /** 触发错误的脱敏诊断；只含错误码与字段路径，供页面指出具体字段。 */
    public readonly diagnostic?: UserSettingsDiagnostic,
  ) {
    super(code);
  }
}

/** 把 Core 诊断归约为不含配置值的安全三元组。 */
function safeDiagnostic(diagnostic: SettingsDiagnostic): UserSettingsDiagnostic {
  return { code: diagnostic.code, scope: diagnostic.scope, ...(diagnostic.field ? { field: diagnostic.field } : {}) };
}

/** 拆分可隔离的权限诊断与必须阻断的分类诊断。 */
function splitDiagnostics(diagnostics: readonly SettingsDiagnostic[]): { blocking: SettingsDiagnostic[]; permissions: UserSettingsDiagnostic[] } {
  const blocking: SettingsDiagnostic[] = [];
  const permissions: UserSettingsDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (isExternalPermissionDiagnostic(diagnostic)) permissions.push(safeDiagnostic(diagnostic));
    else blocking.push(diagnostic);
  }
  return { blocking, permissions };
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验不含空白和控制字符的短配置字符串。 */
function parseSettingString(value: unknown, maximum = 240): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

/** 校验 API Key；空字符串等价于未提交。 */
function parseApiKey(value: unknown): string | undefined {
  if (value === "" || value === undefined) return undefined;
  return typeof value === "string" && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

/** 计算设置正文修订号。 */
function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 读取安全的用户 JSON 对象；损坏文件和链接均拒绝覆盖。 */
function readUserSettings(settingsPath: string): { raw: Record<string, unknown>; original: string } {
  if (!fs.existsSync(settingsPath)) return { raw: {}, original: "" };
  try {
    const stat = fs.lstatSync(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    const original = fs.readFileSync(settingsPath, "utf8");
    const raw: unknown = JSON.parse(original);
    if (!isRecord(raw) || (raw.env !== undefined && !isRecord(raw.env))) throw new Error();
    return { raw: { ...raw }, original };
  } catch {
    throw new NodeUserSettingsError("SETTINGS_INVALID");
  }
}

/** 校验可选修订号并拒绝并发覆盖。 */
function assertRevision(original: string, revision: string | undefined): void {
  if (revision !== undefined && (!/^[a-f0-9]{64}$/u.test(revision) || revision !== revisionOf(original))) throw new NodeUserSettingsError("SETTINGS_CHANGED");
}

/** 从固定 env 字段读取非空旧凭据，不向结果或错误暴露值。 */
function readEnvironmentKey(environment: Record<string, unknown>, key: string | undefined): string | undefined {
  if (!key) return undefined;
  return parseApiKey(environment[key] ?? (key.startsWith("USER_SETTINGS_") ? environment[key.slice("USER_SETTINGS_".length)] : undefined));
}

/** 与 Node CredentialStore 一致按显式引用检查用户 Key，再检查非 USER_SETTINGS 的宿主环境。 */
function readMainCredential(environment: Record<string, unknown>, ref: ProviderRouteProfile["credentialRef"], env: NodeJS.ProcessEnv): string | undefined {
  const configured = readEnvironmentKey(environment, ref.key);
  if (configured || ref.key.startsWith("USER_SETTINGS_")) return configured;
  const envKey = `${ref.provider.toUpperCase().replace(/[^A-Z0-9_]/gu, "_")}_${ref.key.toUpperCase()}`;
  return parseApiKey(env[envKey]);
}

/** 返回主连接与旧 route 中可迁移的凭据候选。 */
function collectMainCredentialCandidates(raw: Record<string, unknown>, environment: Record<string, unknown>): Array<{ key: string; value: string }> {
  const candidates: Array<{ key: string; value: string }> = [];
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const value = readEnvironmentKey(environment, key);
    if (value) candidates.push({ key, value });
  }
  const model = typeof raw.model === "string" ? raw.model : "";
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
  const route = provider && isRecord(raw.providerRoutes) && isRecord(raw.providerRoutes[provider]) ? raw.providerRoutes[provider] as Record<string, unknown> : undefined;
  const ref = route && isRecord(route.credentialRef) ? route.credentialRef as Record<string, unknown> : undefined;
  const key = parseSettingString(ref?.key);
  const value = readEnvironmentKey(environment, key);
  if (key && value) candidates.push({ key, value });
  return candidates;
}

/** 保留仍被其他连接引用的凭据字段，避免迁移后留下悬空引用。 */
function hasCredentialReference(value: unknown, key: string): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.credentialRef) && (value.credentialRef.key === key || value.credentialRef.key === `USER_SETTINGS_${key}`)) return true;
  return Object.entries(value).some(function referenced([name, child]) { return name !== "env" && hasCredentialReference(child, key); });
}

/** 删除旧主/视觉 route 及其动态凭据，但保留无关 Provider route。 */
function removeLegacyPrimaryRoutes(raw: Record<string, unknown>, environment: Record<string, unknown>): void {
  if (!isRecord(raw.providerRoutes)) {
    delete raw.visionModel;
    return;
  }
  const routes = { ...raw.providerRoutes };
  const removedKeys = new Set<string>();
  const selected = [raw.model, raw.visionModel].filter(function stringValue(value): value is string { return typeof value === "string" && value.includes("/"); });
  for (const value of selected) {
    const provider = value.slice(0, value.indexOf("/"));
    const route = isRecord(routes[provider]) ? routes[provider] as Record<string, unknown> : undefined;
    const ref = route && isRecord(route.credentialRef) ? route.credentialRef as Record<string, unknown> : undefined;
    const key = parseSettingString(ref?.key);
    if (key) removedKeys.add(key);
    delete routes[provider];
  }
  if (Object.keys(routes).length > 0) raw.providerRoutes = routes;
  else delete raw.providerRoutes;
  delete raw.visionModel;
  for (const key of removedKeys) if (!hasCredentialReference(raw, key)) delete environment[key];
}

/** 解析并规范化主模型分类提交。 */
function normalizeMainInput(input: MainSettingsCategoryInput): Omit<MainSettingsCategoryInput, "apiKey"> & { apiKey?: string } {
  const apiProtocol = input.apiProtocol ?? "anthropic-messages";
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
  const model = parseSettingString(input.model);
  const apiKey = parseApiKey(input.apiKey);
  const availableModels = input.availableModels?.map(function parseModel(value) { return parseSettingString(value); });
  if (!["anthropic-messages", "openai-chat-completions", "openai-responses"].includes(apiProtocol)
    || (input.compatibilityPreset !== undefined && (apiProtocol === "anthropic-messages" || !["openai", "deepseek", "generic"].includes(input.compatibilityPreset)))
    || !baseUrl || !model || (input.apiKey !== undefined && input.apiKey !== "" && !apiKey)
    || (availableModels && (availableModels.length === 0 || availableModels.some(function missing(value) { return !value; }) || new Set(availableModels).size !== availableModels.length))
    || (input.effort !== undefined && !["auto", "none", "low", "medium", "high", "xhigh", "max"].includes(input.effort))
    || (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 1_000_000))
    || (input.compactWindow !== undefined && (!Number.isInteger(input.compactWindow) || input.compactWindow < 1 || input.compactWindow > 10_000_000))
    || (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 600_000))
    || (input.alwaysThinkingEnabled !== undefined && typeof input.alwaysThinkingEnabled !== "boolean")) throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID");
  for (const value of [input.opusModel, input.sonnetModel, input.haikuModel, input.subagentModel]) {
    if (value !== undefined && !parseSettingString(value)) throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID");
  }
  return { ...input, apiProtocol, baseUrl, model, ...(apiKey ? { apiKey } : {}), ...(availableModels ? { availableModels: availableModels as string[] } : {}) };
}

/** 连接与预设不变时保留受信模型覆盖；切换协议或地址时从新协议缺省重新解析。 */
function createMainRoute(raw: Record<string, unknown>, input: MainSettingsCategoryInput): ProviderRouteProfile {
  const previous = resolveAutopilotSettings([{ scope: "user", value: raw }]);
  const selected = previous.modelRef && previous.providerRoutes[previous.modelRef.provider];
  const apiProtocol = input.apiProtocol ?? "anthropic-messages";
  const sameConnection = selected?.apiProtocol === apiProtocol && selected.baseUrl === input.baseUrl;
  const matches = sameConnection && selected.compatibilityPreset === input.compatibilityPreset;
  let id = selected?.id ?? "web-main";
  for (let suffix = 2; !selected && previous.providerRoutes[id]; suffix += 1) id = `web-main-${suffix}`;
  const ids = [...new Set([...(input.availableModels ?? (matches ? selected.models.map(function modelId(model) { return model.id; }) : [])), input.model])];
  return {
    id, apiProtocol, baseUrl: input.baseUrl,
    credentialRef: sameConnection ? selected.credentialRef : { provider: id, key: `USER_SETTINGS_WEB_MAIN_${revisionOf(`${id}/${apiProtocol}/${input.baseUrl}`).slice(0, 16).toUpperCase()}` },
    ...(selected?.displayName ? { displayName: selected.displayName } : {}),
    ...(input.compatibilityPreset ? { compatibilityPreset: input.compatibilityPreset } : {}),
    ...(matches && selected.protocolProfile ? { protocolProfile: selected.protocolProfile } : {}),
    models: ids.map(function modelEntry(modelId) { return matches ? selected.models.find(function matchesId(model) { return model.id === modelId; }) ?? { id: modelId } : { id: modelId }; }),
  };
}

/** 只返回 Core 的实际能力结果，未知模型不自行扩展 effort，错误不包含配置正文。 */
function resolveMainCapabilities(route: ProviderRouteProfile, model: string): MainModelCapabilities {
  try {
    const capability = resolveRouteModelCapability(route, model);
    return { supportedReasoningEfforts: capability.supportedReasoningEfforts ?? [], supportsToolCalls: capability.supportsToolCalls !== false };
  } catch {
    throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID");
  }
}

/** 原子更新选中的协议 route，保留其他 route、视觉连接和未修改的受信模型元数据。 */
function applyRoutedMainCategory(raw: Record<string, unknown>, input: MainSettingsCategoryInput, env: NodeJS.ProcessEnv): void {
  const route = createMainRoute(raw, input);
  const capabilities = resolveMainCapabilities(route, input.model);
  if (!capabilities.supportsToolCalls) throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID", { scope: "user", code: "MODEL_NOT_SUPPORTED", field: "model" });
  if (input.effort && input.effort !== "auto" && !capabilities.supportedReasoningEfforts.includes(input.effort)) {
    throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID", { scope: "user", code: "SETTINGS_EFFORT_INVALID", field: "effortLevel" });
  }
  const environment = { ...(isRecord(raw.env) ? raw.env : {}) };
  const previous = resolveAutopilotSettings([{ scope: "user", value: raw }]);
  const selected = previous.modelRef && previous.providerRoutes[previous.modelRef.provider];
  const sameConnection = selected?.apiProtocol === route.apiProtocol && selected.baseUrl === route.baseUrl;
  if (!input.apiKey && !sameConnection) throw new NodeUserSettingsError("SETTINGS_KEY_REQUIRED");
  const key = input.apiKey ?? readMainCredential(environment, route.credentialRef, env);
  if (!key) throw new NodeUserSettingsError("SETTINGS_KEY_REQUIRED");
  if (input.apiKey) environment[route.credentialRef.key] = input.apiKey;
  delete environment.ANTHROPIC_MODEL;
  delete environment.CLAUDE_CODE_EFFORT_LEVEL;
  raw.env = environment;
  raw.providerRoutes = { ...(isRecord(raw.providerRoutes) ? raw.providerRoutes : {}), [route.id]: route };
  raw.model = `${route.id}/${input.model}`;
  if (input.effort && input.effort !== "auto") raw.effortLevel = input.effort;
  else delete raw.effortLevel;
}

/** 将完整主模型分类写入 CC env，并在有歧义时拒绝猜测旧 Key。 */
function applyMainCategory(raw: Record<string, unknown>, input: MainSettingsCategoryInput, env: NodeJS.ProcessEnv): void {
  const normalized = normalizeMainInput(input);
  const previous = resolveAutopilotSettings([{ scope: "user", value: raw }]);
  const previousRoute = previous.modelRef && previous.providerRoutes[previous.modelRef.provider];
  if (normalized.apiProtocol !== "anthropic-messages" || (input.apiProtocol !== undefined && previousRoute)) {
    applyRoutedMainCategory(raw, normalized, env);
    if (normalized.maxOutputTokens === undefined) delete raw.maxOutputTokens;
    else raw.maxOutputTokens = normalized.maxOutputTokens;
    const environment = raw.env as Record<string, unknown>;
    const optional = {
      ANTHROPIC_DEFAULT_OPUS_MODEL: normalized.opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: normalized.sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: normalized.haikuModel,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: normalized.compactWindow?.toString(),
      API_TIMEOUT_MS: normalized.timeoutMs?.toString(),
      CLAUDE_CODE_SUBAGENT_MODEL: normalized.subagentModel,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
    if (normalized.apiProtocol === "anthropic-messages" && normalized.alwaysThinkingEnabled !== undefined) raw.alwaysThinkingEnabled = normalized.alwaysThinkingEnabled;
    return;
  }
  const environment = { ...(isRecord(raw.env) ? raw.env : {}) };
  const candidates = collectMainCredentialCandidates(raw, environment);
  const distinct = [...new Set(candidates.map(function value(candidate) { return candidate.value; }))];
  if (!normalized.apiKey && distinct.length > 1) throw new NodeUserSettingsError("SETTINGS_MIGRATION_CONFLICT");
  const previousBaseUrl = normalizeProviderBaseUrl(previousRoute?.baseUrl ?? previous.firstParty.baseUrl);
  const officialDeepSeekMigration = previousBaseUrl === "https://api.deepseek.com" && normalized.baseUrl === "https://api.deepseek.com/anthropic";
  if (!normalized.apiKey && previousBaseUrl !== normalized.baseUrl && !officialDeepSeekMigration) throw new NodeUserSettingsError("SETTINGS_KEY_REQUIRED");
  const apiKey = normalized.apiKey ?? distinct[0];
  if (!apiKey) throw new NodeUserSettingsError("SETTINGS_KEY_REQUIRED");
  removeLegacyPrimaryRoutes(raw, environment);
  for (const candidate of candidates) if (!hasCredentialReference(raw, candidate.key)) delete environment[candidate.key];
  if (!hasCredentialReference(raw, "ANTHROPIC_API_KEY")) delete environment.ANTHROPIC_API_KEY;
  environment.ANTHROPIC_AUTH_TOKEN = apiKey;
  environment.ANTHROPIC_BASE_URL = normalized.baseUrl;
  environment.ANTHROPIC_MODEL = normalized.model;
  const optional = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: normalized.opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: normalized.sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: normalized.haikuModel,
    CLAUDE_CODE_SUBAGENT_MODEL: normalized.subagentModel,
    CLAUDE_CODE_EFFORT_LEVEL: normalized.effort,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: normalized.compactWindow?.toString(),
    API_TIMEOUT_MS: normalized.timeoutMs?.toString(),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  raw.env = environment;
  delete raw.model;
  delete raw.effortLevel;
  raw.availableModels = normalized.availableModels ?? [...new Set([normalized.model, normalized.opusModel, normalized.sonnetModel, normalized.haikuModel, normalized.subagentModel].filter(function present(value): value is string { return Boolean(value); }))];
  if (normalized.maxOutputTokens === undefined) delete raw.maxOutputTokens;
  else raw.maxOutputTokens = normalized.maxOutputTokens;
  if (normalized.alwaysThinkingEnabled === undefined) delete raw.alwaysThinkingEnabled;
  else raw.alwaysThinkingEnabled = normalized.alwaysThinkingEnabled;
}

/** 校验并合并独立 Search；仅 DeepSeek 官方主连接可直接引用主凭据。 */
function applyWebSearch(raw: Record<string, unknown>, input: WebSearchSettingsCategoryInput, env: NodeJS.ProcessEnv): void {
  if (typeof input.enabled !== "boolean" || typeof input.useMainKey !== "boolean") throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID");
  if (!input.enabled) {
    raw.webSearch = false;
    return;
  }
  const provider = input.provider;
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
  const model = parseSettingString(input.model);
  const environment = { ...(isRecord(raw.env) ? raw.env : {}) };
  const settings = resolveAutopilotSettings([{ scope: "user", value: raw }]);
  const mainRoute = settings.modelRef && settings.providerRoutes[settings.modelRef.provider];
  const mainBaseUrl = mainRoute?.baseUrl ?? normalizeProviderBaseUrl(environment.ANTHROPIC_BASE_URL);
  const mainRef = mainRoute?.credentialRef ?? { provider: "deepseek", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" };
  const mainKey = mainRoute ? readMainCredential(environment, mainRef, env) : readEnvironmentKey(environment, "ANTHROPIC_AUTH_TOKEN") ?? readEnvironmentKey(environment, "ANTHROPIC_API_KEY");
  const canReuseMainKey = (!mainRoute || mainRoute.apiProtocol === "anthropic-messages") && mainBaseUrl === "https://api.deepseek.com/anthropic" && Boolean(mainKey);
  if (input.useMainKey) {
    if (!canReuseMainKey) throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID");
    raw.webSearch = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-flash",
      credentialRef: mainRef,
    };
    return;
  }
  const apiKey = parseApiKey(input.apiKey);
  const current = isRecord(raw.webSearch) ? raw.webSearch : undefined;
  const currentRef = current && isRecord(current.credentialRef) ? current.credentialRef : undefined;
  const sameConnection = current?.provider === provider && normalizeProviderBaseUrl(current?.baseUrl) === baseUrl;
  const preservedKeyName = sameConnection ? parseSettingString(currentRef?.key) : undefined;
  const preservedKey = readEnvironmentKey(environment, preservedKeyName);
  if ((provider !== "deepseek" && provider !== "openai-compatible" && provider !== "xiaomi-mimo") || !baseUrl || !model || (!apiKey && !preservedKey)) {
    throw new NodeUserSettingsError(apiKey || preservedKey ? "SETTINGS_INPUT_INVALID" : "SETTINGS_KEY_REQUIRED");
  }
  const key = provider === "deepseek" ? "USER_SETTINGS_WEB_SEARCH_DEEPSEEK" : provider === "xiaomi-mimo" ? "USER_SETTINGS_WEB_SEARCH_XIAOMI_MIMO" : "USER_SETTINGS_WEB_SEARCH_OPENAI_COMPATIBLE";
  environment[key] = apiKey ?? preservedKey;
  raw.env = environment;
  raw.webSearch = { provider, baseUrl, model, credentialRef: { provider, key } };
}

/** 校验并合并一个 RAG 角色，连接改变时不允许空 Key 沿用。 */
function applyRagRole(raw: Record<string, unknown>, role: RagConnectionRole, input: RagSettingsCategoryConnectionInput | null): void {
  const environment = { ...(isRecord(raw.env) ? raw.env : {}) };
  const rag = { ...(isRecord(raw.rag) ? raw.rag : {}) };
  const contract = RAG_ROLE_CONTRACT[role];
  if (input === null) {
    delete rag[role];
    delete environment[contract.key];
  } else {
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    const model = parseSettingString(input.model);
    const apiKey = parseApiKey(input.apiKey);
    const current = isRecord(rag[role]) ? rag[role] as Record<string, unknown> : undefined;
    const sameConnection = current?.provider === input.provider && current?.baseUrl === baseUrl;
    const preservedKey = sameConnection ? readEnvironmentKey(environment, contract.key) : undefined;
    const dimension = contract.dimension && Number.isInteger(input.dimension) && (input.dimension as number) >= 1 && (input.dimension as number) <= 65_536 ? input.dimension : undefined;
    if (input.provider !== contract.provider || !baseUrl || !model || (!apiKey && !preservedKey) || (contract.dimension && !dimension)) throw new NodeUserSettingsError(apiKey || preservedKey ? "SETTINGS_INPUT_INVALID" : "SETTINGS_KEY_REQUIRED");
    rag[role] = { provider: contract.provider, baseUrl, model, ...(dimension ? { dimension } : {}) };
    environment[contract.key] = apiKey ?? preservedKey;
  }
  if (Object.keys(rag).length > 0) raw.rag = rag;
  else delete raw.rag;
  raw.env = environment;
}

/** 创建用户设置分类服务；只操作受限 User settings 路径。 */
export function createNodeUserSettingsService(options: { homeDirectory?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  const homeDirectory = options.homeDirectory;
  const settingsPath = resolveNodeUserSettingsPath(homeDirectory);
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;

  /** 在跨进程锁内执行一次修订校验、分类合并、Core 校验和原子替换。 */
  async function save(update: (raw: Record<string, unknown>) => void, revision?: string): Promise<UserSettingsWriteResult> {
    return withFileLock(settingsPath, function writeSettings() {
      ensureUserConfigDirectory({ ...(homeDirectory ? { homeDirectory } : {}) });
      const current = readUserSettings(settingsPath);
      assertRevision(current.original, revision);
      update(current.raw);
      // 权限段问题不阻断模型/凭据保存：原 permissions 原样保留，不删除、不迁移、不扩大。
      const { blocking } = splitDiagnostics(resolveAutopilotSettings([{ scope: "user", value: current.raw }]).diagnostics);
      if (blocking.length > 0) throw new NodeUserSettingsError("SETTINGS_INPUT_INVALID", safeDiagnostic(blocking[0]!));
      const content = `${JSON.stringify(current.raw, null, 2)}\n`;
      atomicReplace(settingsPath, content);
      return { revision: revisionOf(content), configured: true };
    });
  }

  return {
    /** 预览草稿模型在当前 route 覆盖下的能力，不读取或返回 API Key。 */
    getMainModelCapabilities(input: MainModelCapabilitiesInput): MainModelCapabilities {
      const normalized = normalizeMainInput(input);
      return resolveMainCapabilities(createMainRoute(readUserSettings(settingsPath).raw, normalized), normalized.model);
    },
    /** 用户主动刷新时调用 DeepSeek 官方目录；无凭据、失败或异常响应均使用维护目录。 */
    async refreshMainModelCatalog(): Promise<MainModelCatalogResult> {
      const maintained = ["deepseek-v4-pro[1m]", "deepseek-v4-flash"];
      const current = readUserSettings(settingsPath);
      const environment = isRecord(current.raw.env) ? current.raw.env : {};
      const baseUrl = normalizeProviderBaseUrl(environment.ANTHROPIC_BASE_URL);
      const apiKey = readEnvironmentKey(environment, "ANTHROPIC_AUTH_TOKEN") ?? readEnvironmentKey(environment, "ANTHROPIC_API_KEY");
      if (baseUrl !== "https://api.deepseek.com/anthropic" || !apiKey) return { models: maintained, source: "maintained" };
      try {
        const response = await fetchImpl("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return { models: maintained, source: "maintained" };
        const body = await response.json() as { data?: Array<{ id?: unknown }> };
        const models = [...new Set((body.data ?? []).map(function model(entry) { return parseSettingString(entry.id); }).filter(function present(value): value is string { return Boolean(value); }))];
        return models.length > 0 ? { models, source: "official" } : { models: maintained, source: "maintained" };
      } catch {
        return { models: maintained, source: "maintained" };
      }
    },
    /** 读取设置中心安全状态；缺省值仅用于表单，不会自动写入文件。 */
    getStatus(): UserSettingsStatus {
      ensureUserConfigDirectory({ ...(homeDirectory ? { homeDirectory } : {}) });
      const current = readUserSettings(settingsPath);
      const raw = current.raw;
      const environment = isRecord(raw.env) ? raw.env : {};
      const resolved = resolveAutopilotSettings([{ scope: "user", value: raw }]);
      const { blocking, permissions } = splitDiagnostics(resolved.diagnostics);
      // 权限段错误不阻断安全模型状态读取；其他分类仍 fail-closed，并指出首个出错字段。
      if (blocking.length > 0) throw new NodeUserSettingsError("SETTINGS_INVALID", safeDiagnostic(blocking[0]!));
      const mainRoute = resolved.modelRef && resolved.providerRoutes[resolved.modelRef.provider];
      const mainBaseUrl = mainRoute?.baseUrl ?? resolved.firstParty.baseUrl ?? "https://api.deepseek.com/anthropic";
      const mainModel = resolved.modelRef?.modelId ?? "deepseek-v4-flash";
      const mainKey = mainRoute ? readMainCredential(environment, mainRoute.credentialRef, env) : readEnvironmentKey(environment, "ANTHROPIC_AUTH_TOKEN") ?? readEnvironmentKey(environment, "ANTHROPIC_API_KEY");
      const search = resolved.webSearch ?? (!resolved.webSearchDisabled && !mainRoute && mainKey && mainBaseUrl === "https://api.deepseek.com/anthropic"
        ? { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", credentialRef: { key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" } }
        : undefined);
      const searchKeyName = search?.credentialRef.key;
      const searchKey = readEnvironmentKey(environment, searchKeyName)
        ?? (searchKeyName === "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" ? mainKey : undefined);
      const rag = {} as UserSettingsStatus["rag"];
      const defaults: Record<RagConnectionRole, Omit<RagSettingsCategoryConnectionInput, "apiKey">> = {
        textRerank: { provider: "bailian", baseUrl: "https://dashscope.aliyuncs.com", model: "qwen3.7-text-rerank" },
        visionRerank: { provider: "bailian", baseUrl: "https://dashscope.aliyuncs.com", model: "qwen3-vl-rerank" },
        textEmbedding: { provider: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dimension: 1024 },
        multimodalEmbedding: { provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding", model: "tongyi-embedding-vision-plus-2026-03-06", dimension: 1152 },
      };
      for (const role of Object.keys(RAG_ROLE_CONTRACT) as RagConnectionRole[]) {
        const configuredConnection = resolved.rag[role];
        const connection = configuredConnection ?? defaults[role];
        rag[role] = { provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model, ...(connection.dimension ? { dimension: connection.dimension } : {}), configured: Boolean(configuredConnection && readEnvironmentKey(environment, RAG_ROLE_CONTRACT[role].key)) };
      }
      return {
        revision: revisionOf(current.original),
        main: {
          provider: mainBaseUrl === "https://api.deepseek.com/anthropic" || mainRoute?.compatibilityPreset === "deepseek" ? "deepseek" : "custom",
          apiProtocol: mainRoute?.apiProtocol ?? "anthropic-messages",
          ...(mainRoute?.compatibilityPreset ? { compatibilityPreset: mainRoute.compatibilityPreset } : {}),
          baseUrl: mainBaseUrl,
          model: mainModel,
          configured: Boolean(mainKey),
          availableModels: mainRoute ? mainRoute.models.map(function modelId(model) { return model.id; }) : resolved.availableModels.length > 0 ? [...resolved.availableModels] : ["deepseek-v4-flash", "deepseek-v4-pro[1m]"],
          opusModel: typeof environment.ANTHROPIC_DEFAULT_OPUS_MODEL === "string" ? environment.ANTHROPIC_DEFAULT_OPUS_MODEL : undefined,
          sonnetModel: typeof environment.ANTHROPIC_DEFAULT_SONNET_MODEL === "string" ? environment.ANTHROPIC_DEFAULT_SONNET_MODEL : undefined,
          haikuModel: typeof environment.ANTHROPIC_DEFAULT_HAIKU_MODEL === "string" ? environment.ANTHROPIC_DEFAULT_HAIKU_MODEL : undefined,
          subagentModel: resolved.firstParty.subagentModelId,
          effort: resolved.reasoningProfile?.effort ?? "auto",
          maxOutputTokens: resolved.firstParty.maxOutputTokens,
          compactWindow: resolved.firstParty.compactWindow,
          timeoutMs: resolved.firstParty.timeoutMs,
          alwaysThinkingEnabled: resolved.firstParty.thinkingEnabled,
        },
        search: {
          enabled: Boolean(search),
          useMainKey: mainRoute ? mainRoute.apiProtocol === "anthropic-messages" && mainRoute.baseUrl === "https://api.deepseek.com/anthropic" && searchKeyName === mainRoute.credentialRef.key : searchKeyName === "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN",
          provider: search?.provider ?? "deepseek",
          baseUrl: search?.baseUrl ?? "https://api.deepseek.com",
          model: search?.model ?? "deepseek-v4-flash",
          configured: Boolean(search && searchKey),
        },
        diagnostics: permissions,
        rag,
      };
    },
    /** 读取不含正文的当前修订号。 */
    getRevision(): string {
      ensureUserConfigDirectory({ ...(homeDirectory ? { homeDirectory } : {}) });
      return revisionOf(readUserSettings(settingsPath).original);
    },
    /** 保存主模型分类并执行旧 route/哈希凭据迁移。 */
    saveMain(input: MainSettingsCategoryInput, revision?: string): Promise<UserSettingsWriteResult> {
      return save(function updateMain(raw) { applyMainCategory(raw, input, env); }, revision);
    },
    /** 原子保存设置中心的主模型分类，包含已经独立化的 Search 连接。 */
    saveMainCategory(input: MainSettingsCategoryUpdate, revision?: string): Promise<UserSettingsWriteResult> {
      if (!isRecord(input) || !isRecord(input.main) || !isRecord(input.search) || Object.keys(input).some(function unknown(key) { return key !== "main" && key !== "search"; })) return Promise.reject(new NodeUserSettingsError("SETTINGS_INPUT_INVALID"));
      return save(function updateMainAndSearch(raw) {
        applyMainCategory(raw, input.main, env);
        applyWebSearch(raw, input.search, env);
      }, revision);
    },
    /** 增量保存 RAG 分类；未提交角色保持不变。 */
    saveRag(input: RagSettingsCategoryInput, revision?: string): Promise<UserSettingsWriteResult> {
      if (!isRecord(input) || Object.keys(input).some(function unknown(role) { return !Object.prototype.hasOwnProperty.call(RAG_ROLE_CONTRACT, role); })) return Promise.reject(new NodeUserSettingsError("SETTINGS_INPUT_INVALID"));
      return save(function updateRag(raw) {
        for (const [role, connection] of Object.entries(input) as Array<[RagConnectionRole, RagSettingsCategoryConnectionInput | null]>) applyRagRole(raw, role, connection);
      }, revision);
    },
  };
}
