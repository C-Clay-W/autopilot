/**
 * runtime/provider/model-sampler-factory.ts — 模型采样器工厂端口
 *
 * Phase 3 引入；将 ModelSampler 的创建从 CapabilityLoader 解耦。
 * Factory 按 ModelRef + ResolvedCredential 动态创建 ModelSampler，支持多 Provider。
 * 真实多 Provider Factory（OpenAI / Anthropic / 本地 LM Studio）留给 P0。
 */

import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { ModelRef } from "../domain/model-ref";
import type { ResolvedCredential } from "../domain";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import type { ModelSampleOptions } from "../../internal/types";
import type { FrozenProviderConfig } from "./frozen-provider-config";
import type { ProviderProtocolAdapter } from "./provider-protocol-adapter";

/** 创建采样器时一次性传入的已冻结依赖，避免继续扩张位置参数。 */
export interface CreateModelSamplerInput {
  ref?: ModelRef;
  credential?: ResolvedCredential;
  reasoningProfile?: ReasoningProfile;
  sampleOptions?: ModelSampleOptions;
  providerConfig?: FrozenProviderConfig;
}

/** Factory 注入的受信协议实现；测试可据此验证重复注册与唯一选择。 */
export interface ModelSamplerFactoryOptions {
  adapters?: readonly ProviderProtocolAdapter[];
}

/**
 * 模型采样器工厂端口。
 * 实现者负责根据 ModelRef 与凭据创建具体的 ModelSampler 实例。
 */
export interface ModelSamplerFactory {
  /**
   * 根据模型引用与凭据创建 ModelSampler。
   * @param ref 模型引用；可能为 undefined（表示使用 Runtime 默认模型）
   * @param credential 解析后的短生命周期凭据；可能为 undefined（表示无需凭据）
   * @returns 具体的 ModelSampler 实例
   */
  create(input?: CreateModelSamplerInput): ModelSampler;

  /** 返回工厂支持的 Provider 标识列表（如 ["deepseek", "openai"]）。 */
  getSupportedProviders(): string[];
}
