/** runtime/provider/compatibility-presets.ts — 内置兼容预设的有限协议策略，不推断厂商或模型。 */
import type { CompatibilityPreset, OpenAiResponsesProtocolProfile } from "./api-protocol";
import type { ReasoningEffort } from "../domain/model-ref";

/** 已实现的参数开关只供协议 Adapter 和受信配置校验消费。 */
interface CompatibilityPresetPolicy {
  responses: {
    defaultProfile: OpenAiResponsesProtocolProfile;
    requiresMatchingReplay: boolean;
    supportedReasoningEfforts?: readonly ReasoningEffort[];
    samplingWithoutReasoning: boolean;
  };
  chat: {
    maxTokensField: "max_tokens" | "max_completion_tokens";
    sampling: "default" | "none-only" | "omit";
    supportsThinking: boolean;
    supportsLegacyTopP: boolean;
  };
}

/** 三种既有预设的声明式合同；增加预设必须先实现其有限协议行为。 */
const COMPATIBILITY_PRESETS: Record<CompatibilityPreset, CompatibilityPresetPolicy> = {
  openai: {
    responses: {
      defaultProfile: { apiProtocol: "openai-responses", reasoningReplay: "encrypted" },
      requiresMatchingReplay: true,
      samplingWithoutReasoning: true,
    },
    chat: { maxTokensField: "max_completion_tokens", sampling: "none-only", supportsThinking: false, supportsLegacyTopP: false },
  },
  deepseek: {
    responses: {
      defaultProfile: { apiProtocol: "openai-responses", reasoningReplay: "content" },
      requiresMatchingReplay: true,
      supportedReasoningEfforts: ["none", "low", "high", "max"],
      samplingWithoutReasoning: false,
    },
    chat: { maxTokensField: "max_tokens", sampling: "default", supportsThinking: true, supportsLegacyTopP: false },
  },
  generic: {
    responses: {
      defaultProfile: { apiProtocol: "openai-responses", reasoningReplay: "none" },
      requiresMatchingReplay: false,
      samplingWithoutReasoning: false,
    },
    chat: { maxTokensField: "max_tokens", sampling: "omit", supportsThinking: true, supportsLegacyTopP: false },
  },
};

/** 无预设的历史 Chat 保留旧采样字段，Responses 使用公共保守缺省。 */
const LEGACY_POLICY: CompatibilityPresetPolicy = {
  responses: COMPATIBILITY_PRESETS.generic.responses,
  chat: { maxTokensField: "max_tokens", sampling: "default", supportsThinking: true, supportsLegacyTopP: true },
};

/** 只接受数据表中已实现的受信预设。 */
export function isCompatibilityPreset(value: unknown): value is CompatibilityPreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMPATIBILITY_PRESETS, value);
}

/** 按显式预设选择策略，未设置时保留历史兼容行为。 */
export function getCompatibilityPresetPolicy(preset?: CompatibilityPreset): CompatibilityPresetPolicy {
  return preset ? COMPATIBILITY_PRESETS[preset] : LEGACY_POLICY;
}
