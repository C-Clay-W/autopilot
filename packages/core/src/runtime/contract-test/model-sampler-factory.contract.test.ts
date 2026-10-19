/**
 * runtime/contract-test/model-sampler-factory.contract.test.ts — ModelSamplerFactory 契约测试
 *
 * 验证 createDefaultModelSamplerFactory：
 * - create 返回有效 ModelSampler
 * - getSupportedProviders 至少返回一项
 * - 多次 create 返回独立实例
 */

import { describe, it, expect, vi } from "vitest";
import { createDefaultModelSamplerFactory } from "../provider/default-model-sampler-factory";
import type { ModelRef, ResolvedCredential } from "../domain";
import type { ProviderProtocolAdapter } from "../provider/provider-protocol-adapter";

/** 创建记录协议选择的最小测试 Adapter。 */
function createProtocolAdapter(apiProtocol: ProviderProtocolAdapter["apiProtocol"]): ProviderProtocolAdapter {
  return {
    apiProtocol,
    createSampler: vi.fn(function createSampler() {
      return { async sample() { return { content: "", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" as const }; } } as any;
    }),
  };
}

describe("ModelSamplerFactory contract test", function factoryContractSuite() {
  it("create 返回有效 ModelSampler", function createReturnsSampler() {
    const factory = createDefaultModelSamplerFactory();
    const sampler = factory.create();
    expect(sampler).toBeDefined();
    expect(typeof sampler.sample).toBe("function");
  });

  it("声明 CC firstParty 主链与缺失配置拒绝路径", function supportedProviders() {
    const factory = createDefaultModelSamplerFactory();
    const providers = factory.getSupportedProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("firstParty");
    expect(providers).toContain("default");
  });

  it("create 接受 firstParty ModelRef 与冻结凭据参数", function createWithArgs() {
    const factory = createDefaultModelSamplerFactory();
    const ref: ModelRef = { provider: "firstParty", modelId: "fixture-model" };
    const credential: ResolvedCredential = { apiKey: "test-key" };

    const sampler = factory.create({
      ref,
      credential,
      providerConfig: { provider: "firstParty", apiProtocol: "anthropic-messages", baseUrl: "https://stub.example/anthropic", credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_API_KEY" }, sampleOptions: { model: "fixture-model" } },
    });
    expect(sampler).toBeDefined();
    expect(typeof sampler.sample).toBe("function");
  });

  it("多次 create 返回独立实例", function independentInstances() {
    const factory = createDefaultModelSamplerFactory();
    const sampler1 = factory.create();
    const sampler2 = factory.create();
    expect(sampler1).not.toBe(sampler2);
  });

  it("只按冻结 apiProtocol 选择唯一 Adapter，不按 Provider 名猜测", function selectsFrozenProtocolOnly() {
    const anthropic = createProtocolAdapter("anthropic-messages");
    const openai = createProtocolAdapter("openai-chat-completions");
    const factory = createDefaultModelSamplerFactory({ adapters: [anthropic, openai] });

    factory.create({
      ref: { provider: "arbitrary-route", modelId: "fixture-model" },
      providerConfig: { provider: "arbitrary-route", apiProtocol: "openai-chat-completions" },
    });

    expect(openai.createSampler).toHaveBeenCalledTimes(1);
    expect(anthropic.createSampler).not.toHaveBeenCalled();
  });

  it("缺失、未知或重复 apiProtocol 均 fail closed", function rejectsInvalidProtocolRegistryState() {
    const factory = createDefaultModelSamplerFactory();
    let missingProtocolError: unknown;
    try {
      factory.create({ ref: { provider: "route", modelId: "fixture" }, providerConfig: { provider: "route" } });
    } catch (error) {
      missingProtocolError = error;
    }
    expect(missingProtocolError).toMatchObject({ code: "PROVIDER_PROTOCOL_REQUIRED" });
    let unknownProtocolError: unknown;
    try {
      factory.create({ ref: { provider: "route", modelId: "fixture" }, providerConfig: { provider: "route", apiProtocol: "unknown" as any } });
    } catch (error) {
      unknownProtocolError = error;
    }
    expect(unknownProtocolError).toMatchObject({ code: "UNSUPPORTED_API_PROTOCOL" });
    const adapter = createProtocolAdapter("anthropic-messages");
    let duplicateAdapterError: unknown;
    try {
      createDefaultModelSamplerFactory({ adapters: [adapter, adapter] });
    } catch (error) {
      duplicateAdapterError = error;
    }
    expect(duplicateAdapterError).toMatchObject({ code: "DUPLICATE_API_PROTOCOL_ADAPTER" });
  });
});
