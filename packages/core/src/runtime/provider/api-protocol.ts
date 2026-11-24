/**
 * runtime/provider/api-protocol.ts — 受信 Provider route 的协议与兼容 profile 定义。
 *
 * 协议只由 Host 在新 Turn 前解析并冻结；运行期不得根据 Provider 名、模型名或 endpoint 猜测。
 */

import type { CredentialRef } from "../domain";

/** 当前 Core 明确支持的 Provider wire 协议。 */
export type ApiProtocol = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

/** 只由用户级受信配置声明的兼容预设。 */
export type CompatibilityPreset = "openai" | "deepseek" | "generic";

/** Responses 私有推理历史的有限回放策略。 */
export interface OpenAiResponsesProtocolProfile {
  apiProtocol: "openai-responses";
  reasoningReplay: "none" | "encrypted" | "content";
}

/** 用户级模型能力覆盖；省略表示沿用目录或保守缺省。 */
export interface ModelCapabilityDeclaration {
  supportedReasoningEfforts?: readonly import("../domain/model-ref").ReasoningEffort[];
  defaultReasoningEffort?: import("../domain/model-ref").ReasoningEffort;
  inputModalities?: readonly ("text" | "image")[];
  supportsToolCalls?: boolean;
  maxOutputTokens?: number;
}

/** Anthropic Messages 的封闭兼容 profile。 */
export interface AnthropicMessagesProtocolProfile {
  apiProtocol: "anthropic-messages";
}

/** OpenAI Chat Completions 的封闭兼容 profile。 */
export interface OpenAiChatCompletionsProtocolProfile {
  apiProtocol: "openai-chat-completions";
  assistantToolCallContent: "empty-string" | "null";
  supportsReasoningContent: boolean;
  supportsUsageInStreaming: boolean;
}

/** 已冻结或已解析的协议兼容差异。 */
export type ProtocolProfile = AnthropicMessagesProtocolProfile | OpenAiChatCompletionsProtocolProfile | OpenAiResponsesProtocolProfile;

/** 受信 Host route catalog 的单条 Provider 配置。 */
export interface ProviderRouteProfile {
  id: string;
  displayName?: string;
  apiProtocol: ApiProtocol;
  baseUrl: string;
  credentialRef: CredentialRef;
  protocolProfile?: ProtocolProfile;
  compatibilityPreset?: CompatibilityPreset;
  models: ReadonlyArray<{ id: string; protocolProfile?: ProtocolProfile; contextWindowTokens?: number; capabilities?: ModelCapabilityDeclaration }>;
}

/** 判断值是否为已支持的明确协议。 */
export function isApiProtocol(value: unknown): value is ApiProtocol {
  return value === "anthropic-messages" || value === "openai-chat-completions" || value === "openai-responses";
}

/** 判断 profile 是否与已冻结协议严格匹配。 */
export function isProtocolProfileForApiProtocol(profile: unknown, apiProtocol: ApiProtocol): profile is ProtocolProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const value = profile as Record<string, unknown>;
  if (apiProtocol === "anthropic-messages") {
    return hasExactKeys(value, ["apiProtocol"]) && value.apiProtocol === apiProtocol;
  }
  if (apiProtocol === "openai-responses") {
    return hasExactKeys(value, ["apiProtocol", "reasoningReplay"]) && value.apiProtocol === apiProtocol
      && (value.reasoningReplay === "none" || value.reasoningReplay === "encrypted" || value.reasoningReplay === "content");
  }
  return hasExactKeys(value, ["apiProtocol", "assistantToolCallContent", "supportsReasoningContent", "supportsUsageInStreaming"])
    && value.apiProtocol === apiProtocol
    && (value.assistantToolCallContent === "empty-string" || value.assistantToolCallContent === "null")
    && typeof value.supportsReasoningContent === "boolean"
    && typeof value.supportsUsageInStreaming === "boolean";
}

/** 验证 profile 只携带当前协议允许的封闭能力字段。 */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(function isExpectedKey(key) { return expected.includes(key); });
}
