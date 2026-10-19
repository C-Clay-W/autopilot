/**
 * runtime/provider — Provider 抽象统一出口
 *
 * Phase 3 引入 ModelSamplerFactory，将 ModelSampler 创建与 CapabilityLoader 解耦。
 * Talk-Plan0805 准备工作：新增通用 model-sample-resolver 与按 ModelRef 配置的采样器工厂。
 */

export type { ModelSamplerFactory, CreateModelSamplerInput, ModelSamplerFactoryOptions } from "./model-sampler-factory";
export { createDefaultModelSamplerFactory, createConfiguredModelSampler } from "./default-model-sampler-factory";
export { createOpenAiChatCompletionsMessages, createOpenAiChatCompletionsRequest, createOpenAiChatCompletionsSampler } from "./openai-chat-completions-adapter";
export type { CreateOpenAiChatCompletionsSamplerInput, OpenAiChatCompletionsRequestInput } from "./openai-chat-completions-adapter";
export type { ApiProtocol, ProtocolProfile, ProviderRouteProfile, AnthropicMessagesProtocolProfile, OpenAiChatCompletionsProtocolProfile } from "./api-protocol";
export { isApiProtocol, isProtocolProfileForApiProtocol } from "./api-protocol";
export type { ProviderProtocolAdapter, ProviderProtocolAdapterInput } from "./provider-protocol-adapter";
export { ProviderProtocolAdapterRegistry } from "./provider-protocol-adapter";
export { createFirstPartyModelSampler } from "./first-party-model-sampler";
export type { CreateFirstPartyModelSamplerInput } from "./first-party-model-sampler";
export { resolveFirstPartyModelSampleOptions, resolveModelSampleOptions } from "./model-sample-resolver";
export { listModelCapabilities, getModelCapability } from "./model-capability-catalog";
export { createVisionAnalyzer } from "./vision-analyzer";
export type { FrozenProviderConfig } from "./frozen-provider-config";
export type { ModelCapability } from "./model-capability-catalog";
export type { VisionAnalyzer } from "./vision-analyzer";
export type { FirstPartyEffortSource, ResolvedFirstPartyModelSample } from "./model-sample-resolver";
export { createDefaultModelBehaviorProfile } from "./model-behavior-profile";
export type { ModelBehaviorProfile } from "./model-behavior-profile";
