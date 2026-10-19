/**
 * runtime/provider/default-model-sampler-factory.ts — 默认模型采样器工厂
 *
 * 工厂只按冻结 apiProtocol 选择唯一 Adapter；ModelRef、端点和凭据均来自同一 Turn 的冻结配置。
 * 未配置 ModelRef 的 headless 回退仅供既有内部测试使用。
 */

import { createDefaultModelSampler } from "../../internal/kernel/model-sampler";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { ModelSampleOptions } from "../../internal/types";
import type { ModelSamplerFactory } from "./model-sampler-factory";
import type { ModelSamplerFactoryOptions } from "./model-sampler-factory";
import type { ProviderProtocolAdapter } from "./provider-protocol-adapter";
import { ProviderProtocolAdapterRegistry } from "./provider-protocol-adapter";
import { isApiProtocol } from "./api-protocol";
import { AgentRuntimeError } from "../protocol/error-code";
import { resolveFirstPartyModelSampleOptions, resolveModelSampleOptions } from "./model-sample-resolver";
import type { ModelBehaviorProfile } from "./model-behavior-profile";
import { createDefaultModelBehaviorProfile } from "./model-behavior-profile";
import { createAnthropicMessagesSampler } from "./anthropic-messages-adapter";
import { createOpenAiChatCompletionsSampler } from "./openai-chat-completions-adapter";

/**
 * 创建一个使用指定采样选项的 Chat Completions sampler（仅供旧内部调用路径）。
 * @param sampleOptions 已解析的 Chat Completions 采样选项
 * @returns 委托唯一 Chat Completions Adapter 的实例
 */
export function createConfiguredModelSampler(
  sampleOptions: ModelSampleOptions = {},
  behaviorProfile: ModelBehaviorProfile = createDefaultModelBehaviorProfile(),
): ModelSampler {
  return createOpenAiChatCompletionsSampler({
    sampleOptions,
    behaviorProfile,
  });
}

/**
 * 创建默认模型采样器工厂。
 * firstParty ModelRef 返回绑定冻结端点、凭据和模型的 Messages 采样器；未配置时只保留内部 headless 回退。
 * @returns ModelSamplerFactory 实例
 */
export function createDefaultModelSamplerFactory(options: ModelSamplerFactoryOptions = {}): ModelSamplerFactory {
  const registry = new ProviderProtocolAdapterRegistry();
  const adapters = options.adapters ?? createBaselineProtocolAdapters();
  for (const adapter of adapters) registry.register(adapter);
  return {
    create(input = {}): ModelSampler {
      const { ref, credential, providerConfig } = input;
      if (!ref) return createDefaultModelSampler();
      if (!providerConfig?.apiProtocol) {
        throw new AgentRuntimeError("PROVIDER_PROTOCOL_REQUIRED", "ModelRef 已配置时必须冻结 apiProtocol");
      }
      if (!isApiProtocol(providerConfig.apiProtocol)) {
        throw new AgentRuntimeError("UNSUPPORTED_API_PROTOCOL", "冻结的 apiProtocol 不受支持");
      }
      return registry.get(providerConfig.apiProtocol).createSampler({
        ref,
        credential,
        reasoningProfile: input.reasoningProfile,
        sampleOptions: input.sampleOptions,
        providerConfig,
      });
    },

    getSupportedProviders(): string[] {
      return ["firstParty", "default"];
    },
  };
}

/** 创建 Stage 2 registry 的基线 Adapter，保持现有两条 sampler 实现行为。 */
function createBaselineProtocolAdapters(): ProviderProtocolAdapter[] {
  return [
    {
      apiProtocol: "anthropic-messages",
      createSampler(input) {
        return createAnthropicMessagesSampler({
          baseUrl: input.providerConfig.baseUrl,
          apiKey: input.credential?.apiKey,
          authMode: input.providerConfig.credentialRef?.key === "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" ? "bearer" : "api_key",
          timeoutMs: input.providerConfig.timeoutMs,
          sampleOptions: input.providerConfig.sampleOptions ?? resolveFirstPartyModelSampleOptions(input.ref, input.reasoningProfile).sampleOptions,
        });
      },
    },
    {
      apiProtocol: "openai-chat-completions",
      createSampler(input) {
        const protocolProfile = input.providerConfig.protocolProfile;
        if (protocolProfile?.apiProtocol && protocolProfile.apiProtocol !== "openai-chat-completions") {
          throw new AgentRuntimeError("UNSUPPORTED_API_PROTOCOL", "OpenAI Chat Completions Adapter 收到不匹配的 protocolProfile");
        }
        return createOpenAiChatCompletionsSampler({
          baseUrl: input.providerConfig.baseUrl,
          apiKey: input.credential?.apiKey,
          timeoutMs: input.providerConfig.timeoutMs,
          sampleOptions: input.providerConfig.sampleOptions ?? input.sampleOptions ?? resolveModelSampleOptions(input.ref, input.reasoningProfile),
          protocolProfile,
        });
      },
    },
  ];
}
