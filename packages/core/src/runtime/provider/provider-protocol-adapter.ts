/**
 * runtime/provider/provider-protocol-adapter.ts — 冻结协议到采样器的 Adapter 端口与唯一 registry。
 *
 * Stage 2 只建立显式路由边界；具体 Anthropic/OpenAI wire 序列化仍由后续 Stage 收口。
 */

import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { ResolvedCredential } from "../domain";
import type { ModelRef } from "../domain/model-ref";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import { AgentRuntimeError } from "../protocol/error-code";
import type { ApiProtocol } from "./api-protocol";
import type { FrozenProviderConfig } from "./frozen-provider-config";
import type { ModelSampleOptions } from "../../internal/types";

/** Adapter 创建 sampler 时接收的全部冻结输入。 */
export interface ProviderProtocolAdapterInput {
  ref: ModelRef;
  credential?: ResolvedCredential;
  reasoningProfile?: ReasoningProfile;
  sampleOptions?: ModelSampleOptions;
  providerConfig: FrozenProviderConfig;
}

/** 单一 wire 协议对应的 Provider Adapter 端口。 */
export interface ProviderProtocolAdapter {
  readonly apiProtocol: ApiProtocol;
  createSampler(input: ProviderProtocolAdapterInput): ModelSampler;
}

/** 防止重复协议实现互相覆盖的最小 Adapter registry。 */
export class ProviderProtocolAdapterRegistry {
  private readonly adapters = new Map<ApiProtocol, ProviderProtocolAdapter>();

  /** 注册一个协议 Adapter；相同协议只能有唯一实现。 */
  register(adapter: ProviderProtocolAdapter): void {
    if (this.adapters.has(adapter.apiProtocol)) {
      throw new AgentRuntimeError("DUPLICATE_API_PROTOCOL_ADAPTER", `协议 ${adapter.apiProtocol} 已注册 Adapter`);
    }
    this.adapters.set(adapter.apiProtocol, adapter);
  }

  /** 按已冻结协议取得唯一 Adapter；未知协议绝不回退。 */
  get(apiProtocol: ApiProtocol): ProviderProtocolAdapter {
    const adapter = this.adapters.get(apiProtocol);
    if (!adapter) throw new AgentRuntimeError("UNSUPPORTED_API_PROTOCOL", `不支持的 API 协议: ${apiProtocol}`);
    return adapter;
  }

  /** 返回 registry 的稳定协议列表，供受信宿主诊断使用。 */
  getSupportedApiProtocols(): ApiProtocol[] {
    return [...this.adapters.keys()];
  }
}
