/**
 * runtime/provider/model-capability-catalog.ts — 首发受信模型能力目录
 *
 * 目录是版本化的本地 allowlist，统一表达 Provider、模型与输入能力；不读取凭据、不做在线探测。
 */

import type { ModelRef, ReasoningEffort } from "../domain/model-ref";
import type { ApiProtocol, CompatibilityPreset, ModelCapabilityDeclaration, ProviderRouteProfile, ProtocolProfile } from "./api-protocol";
import { getCompatibilityPresetPolicy } from "./compatibility-presets";
import { AgentRuntimeError } from "../protocol/error-code";

/**
 * 提示缓存的客户端标记策略，只描述"本端是否发送协议缓存标记"。
 * - server-auto：服务端自动前缀缓存，本端不发标记（DeepSeek 官方上下文缓存默认开启）。
 * - explicit：必须由本端在协议允许的稳定前缀边界发送缓存标记（Anthropic 原生 cache_control）。
 * - none：未确认或不启用客户端标记；不代表服务端一定没有缓存。
 */
export type PromptCacheMode = "server-auto" | "explicit" | "none";

/** 受信模型的统一能力描述。 */
export interface ModelCapability {
  provider: "deepseek" | "ali";
  modelId: "deepseek-v4-flash" | "deepseek-v4-pro" | "qwen3-vl-flash";
  inputModalities: readonly ("text" | "image")[];
  supportsToolCalls: boolean;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** 只有 explicit 允许发送协议缓存标记；未登记模型一律按 none 处理。 */
  promptCacheMode: PromptCacheMode;
}

/** 精确模型记录共用的完整缺省值，不扩展用户能力声明的配置形状。 */
type CatalogCapability = ModelCapabilityDeclaration & Pick<ModelCapability, "inputModalities" | "supportsToolCalls" | "supportedReasoningEfforts" | "contextWindowTokens" | "maxOutputTokens">;

/** 协议限制在用户覆盖后相交，不能借显式声明放开已知工具或 effort 限制。 */
interface ProtocolCapabilityLimit {
  supportsToolCalls: boolean;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

/** 同一记录提供预设能力和旧公开目录视图，旧协议差异显式保存在 legacy 中。 */
interface CatalogEntry {
  preset?: CompatibilityPreset;
  modelIds: readonly string[];
  capability: CatalogCapability;
  protocols?: Partial<Record<ApiProtocol, ProtocolCapabilityLimit>>;
  hardLimits?: { outputTokens?: boolean; reasoningEfforts?: boolean; inputModalities?: boolean };
  legacy?: Pick<ModelCapability, "provider" | "modelId" | "promptCacheMode"> & { supportedReasoningEfforts?: readonly ReasoningEffort[] };
}

/** OpenAI 五模型的公共数据，逐模型差异只在下面的精确记录中声明。 */
const OPENAI_CAPABILITY: CatalogCapability = {
  supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"], supportsToolCalls: true, contextWindowTokens: 1_050_000, maxOutputTokens: 128_000,
};
const OPENAI_REASONING_ONLY: CatalogCapability = { ...OPENAI_CAPABILITY, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] };
const OPENAI_HARD_LIMITS = { outputTokens: true, reasoningEfforts: true };
const CHAT_NO_TOOLS: ProtocolCapabilityLimit = { supportsToolCalls: false, supportedReasoningEfforts: [] };
const CHAT_NONE_ONLY: ProtocolCapabilityLimit = { supportsToolCalls: true, supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" };
const DEEPSEEK_CAPABILITY: CatalogCapability = {
  supportedReasoningEfforts: ["none", "low", "high", "max"], defaultReasoningEffort: "high",
  inputModalities: ["text", "image"], supportsToolCalls: true, contextWindowTokens: 1_000_000, maxOutputTokens: 384_000,
};

/** 本地精确目录；预设绑定和协议差异均为数据，不按模型前缀推断。 */
const MODEL_CATALOG: readonly CatalogEntry[] = [
  { preset: "openai", modelIds: ["gpt-6-astra"], capability: OPENAI_REASONING_ONLY, hardLimits: OPENAI_HARD_LIMITS, protocols: { "openai-chat-completions": CHAT_NO_TOOLS } },
  { preset: "openai", modelIds: ["gpt-6.1-sol"], capability: OPENAI_REASONING_ONLY, hardLimits: OPENAI_HARD_LIMITS, protocols: { "openai-chat-completions": CHAT_NO_TOOLS } },
  { preset: "openai", modelIds: ["gpt-6.1-terra"], capability: OPENAI_CAPABILITY, hardLimits: OPENAI_HARD_LIMITS, protocols: { "openai-chat-completions": CHAT_NO_TOOLS } },
  { preset: "openai", modelIds: ["gpt-6-sol"], capability: OPENAI_CAPABILITY, hardLimits: OPENAI_HARD_LIMITS, protocols: { "openai-chat-completions": CHAT_NONE_ONLY } },
  { preset: "openai", modelIds: ["gpt-6-luna"], capability: OPENAI_CAPABILITY, hardLimits: OPENAI_HARD_LIMITS, protocols: { "openai-chat-completions": CHAT_NONE_ONLY } },
  {
    preset: "deepseek", modelIds: ["deepseek-flash", "deepseek-v4-flash"], capability: DEEPSEEK_CAPABILITY,
    legacy: { provider: "deepseek", modelId: "deepseek-v4-flash", promptCacheMode: "server-auto" },
  },
  {
    preset: "deepseek", modelIds: ["deepseek-v4-pro"], capability: { ...DEEPSEEK_CAPABILITY, inputModalities: ["text"] }, hardLimits: { inputModalities: true },
    legacy: { provider: "deepseek", modelId: "deepseek-v4-pro", promptCacheMode: "server-auto", supportedReasoningEfforts: ["none", "high", "max"] },
  },
  {
    modelIds: ["qwen3-vl-flash"], capability: { inputModalities: ["text", "image"], supportsToolCalls: true, supportedReasoningEfforts: [], contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    legacy: { provider: "ali", modelId: "qwen3-vl-flash", promptCacheMode: "none" },
  },
];

/** 保留公开 list/get 的三条旧目录、字段和顺序，不把 Responses 新目录扩散到旧调用方。 */
const MODEL_CAPABILITIES: readonly ModelCapability[] = MODEL_CATALOG.flatMap(function legacyCapability(entry): ModelCapability[] {
  if (!entry.legacy) return [];
  const capability = entry.capability;
  return [{
    ...entry.legacy,
    inputModalities: capability.inputModalities,
    supportsToolCalls: capability.supportsToolCalls,
    supportedReasoningEfforts: entry.legacy.supportedReasoningEfforts ?? capability.supportedReasoningEfforts,
    contextWindowTokens: capability.contextWindowTokens,
    maxOutputTokens: capability.maxOutputTokens,
  }];
});

/** 受信生产 ModelRef 到目录身份的精确别名；不扩展未知 Provider 或模型。 */
const MODEL_CAPABILITY_ALIASES: readonly {
  modelRef: Readonly<Pick<ModelRef, "provider" | "modelId">>;
  capabilityRef: Readonly<Pick<ModelCapability, "provider" | "modelId">>;
}[] = [
  {
    modelRef: { provider: "firstParty", modelId: "deepseek-flash" },
    capabilityRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
  },
];

/** 返回不可扩张的完整受信模型目录。 */
export function listModelCapabilities(): readonly ModelCapability[] {
  return MODEL_CAPABILITIES;
}

/** 仅按 Provider 与模型 ID 查询本地受信能力。 */
export function getModelCapability(provider: string, modelId: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES.find(function findCapability(capability) {
    return capability.provider === provider && capability.modelId === modelId;
  });
}

/** 按完整 ModelRef 解析目录能力；只有显式登记的精确别名才跨 Provider 命中。 */
export function getModelCapabilityForRef(modelRef: ModelRef): ModelCapability | undefined {
  const alias = MODEL_CAPABILITY_ALIASES.find(function matchesModelRef(candidate) {
    return candidate.modelRef.provider === modelRef.provider && candidate.modelRef.modelId === modelRef.modelId;
  });
  if (alias) return getModelCapability(alias.capabilityRef.provider, alias.capabilityRef.modelId);
  return getModelCapability(modelRef.provider, modelRef.modelId);
}


/** 旧协议继续使用旧目录语义；未知 Responses 模型只启用公共文字和函数。 */
function getLegacyCapability(route: ProviderRouteProfile, modelId: string): ModelCapabilityDeclaration & { contextWindowTokens?: number } {
  if (route.apiProtocol === "anthropic-messages") {
    return { ...getModelCapabilityForRef({ provider: route.id, modelId }), supportedReasoningEfforts: ["none", "low", "medium", "high", "max"] };
  }
  if (route.apiProtocol === "openai-chat-completions" && !route.compatibilityPreset) {
    // 旧无预设 Chat 保留原有五档兼容意图，不以 reasoning_content 格式判断强度。
    return getModelCapabilityForRef({ provider: route.id, modelId })
      ?? { supportedReasoningEfforts: ["none", "low", "medium", "high", "max"] };
  }
  return {};
}

/** 解析 route 内的能力覆盖，保留预设硬限制，列表整体替换且不跨 route 传播。 */
export function resolveRouteModelCapability(route: ProviderRouteProfile, modelId: string): ModelCapabilityDeclaration & { contextWindowTokens?: number } {
  const model = route.models.find(function matches(item) { return item.id === modelId; });
  const entry = route.compatibilityPreset ? MODEL_CATALOG.find(function matchesPreset(candidate) {
    return candidate.preset === route.compatibilityPreset && candidate.modelIds.includes(modelId);
  }) : undefined;
  const builtin = entry?.capability ?? getLegacyCapability(route, modelId);
  const capability = {
    inputModalities: ["text"] as readonly ("text" | "image")[],
    supportsToolCalls: true,
    ...builtin,
    ...model?.capabilities,
    ...(model?.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
  };
  if (capability.defaultReasoningEffort && !capability.supportedReasoningEfforts?.includes(capability.defaultReasoningEffort)) {
    throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", "默认 effort 必须属于 supportedReasoningEfforts");
  }
  if (entry?.hardLimits?.outputTokens && capability.maxOutputTokens! > builtin.maxOutputTokens!) {
    throw new AgentRuntimeError("MODEL_NOT_SUPPORTED", "能力声明不能提高内置模型的输出硬上限");
  }
  if (entry?.hardLimits?.reasoningEfforts && capability.supportedReasoningEfforts?.some(function unsupported(effort) { return !builtin.supportedReasoningEfforts!.includes(effort); })) {
    throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", "能力声明与内置模型强度限制冲突");
  }
  if (entry?.hardLimits?.inputModalities && capability.inputModalities.some(function unsupported(modality) { return !builtin.inputModalities!.includes(modality); })) {
    throw new AgentRuntimeError("MODEL_NOT_SUPPORTED", "能力声明与内置模型输入限制冲突");
  }
  const protocolEfforts = route.apiProtocol === "openai-responses" ? getCompatibilityPresetPolicy(route.compatibilityPreset).responses.supportedReasoningEfforts : undefined;
  if (protocolEfforts && capability.supportedReasoningEfforts?.some(function unsupported(effort) { return !protocolEfforts.includes(effort); })) {
    throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", "能力声明与兼容预设的协议强度限制冲突");
  }
  if (route.apiProtocol === "anthropic-messages" && capability.supportedReasoningEfforts?.includes("xhigh")) {
    throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", "Anthropic 不支持 xhigh");
  }
  const protocol = entry?.protocols?.[route.apiProtocol];
  if (protocol) {
    const efforts = protocol.supportedReasoningEfforts.filter(function supported(effort) { return capability.supportedReasoningEfforts?.includes(effort); });
    return {
      ...capability,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: protocol.defaultReasoningEffort && efforts.includes(protocol.defaultReasoningEffort) ? protocol.defaultReasoningEffort : undefined,
      supportsToolCalls: protocol.supportsToolCalls && capability.supportsToolCalls,
    };
  }
  return capability;
}

/** 按完整对象优先级选择 profile，并校验已知厂商的 replay 合同。 */
export function resolveRouteProtocolProfile(route: ProviderRouteProfile, modelId: string): ProtocolProfile | undefined {
  const profile = route.models.find(function matches(model) { return model.id === modelId; })?.protocolProfile ?? route.protocolProfile;
  if (route.apiProtocol !== "openai-responses") return profile;
  const policy = getCompatibilityPresetPolicy(route.compatibilityPreset).responses;
  if (profile && (profile.apiProtocol !== "openai-responses"
    || policy.requiresMatchingReplay && profile.reasoningReplay !== policy.defaultProfile.reasoningReplay)) {
    throw new AgentRuntimeError("INVALID_PROTOCOL_PROFILE", "兼容预设与 Responses replay 策略冲突");
  }
  return profile ?? { ...policy.defaultProfile };
}
