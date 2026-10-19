/**
 * runtime/provider/model-capability-catalog.ts — 首发受信模型能力目录
 *
 * 目录是版本化的本地 allowlist，统一表达 Provider、模型与输入能力；不读取凭据、不做在线探测。
 */

import type { ModelRef, ReasoningEffort } from "../domain/model-ref";

/** 受信模型的统一能力描述。 */
export interface ModelCapability {
  provider: "deepseek" | "ali";
  modelId: "deepseek-v4-flash" | "deepseek-v4-pro" | "qwen3-vl-flash";
  inputModalities: readonly ("text" | "image")[];
  supportsToolCalls: boolean;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  contextWindowTokens: number;
  maxOutputTokens: number;
}

/** 首发内置目录；未知 Provider 或模型一律不进入此处。 */
const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  { provider: "deepseek", modelId: "deepseek-v4-flash", inputModalities: ["text"], supportsToolCalls: true, supportedReasoningEfforts: ["none", "low", "high", "max"], contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
  { provider: "deepseek", modelId: "deepseek-v4-pro", inputModalities: ["text"], supportsToolCalls: true, supportedReasoningEfforts: ["none", "high", "max"], contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
  { provider: "ali", modelId: "qwen3-vl-flash", inputModalities: ["text", "image"], supportsToolCalls: true, supportedReasoningEfforts: [], contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
];

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
