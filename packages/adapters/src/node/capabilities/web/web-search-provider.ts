/**
 * Node Web Search Provider 选择边界：把中性宿主配置路由到具体协议适配器。
 * 厂商注册表是唯一扩展点：新增受支持厂商只需在表中加一行；
 * 只有当厂商使用全新 wire 协议时才需要新增适配器文件。
 */

import type { CredentialRef, CredentialStore, WebSearchCapability } from "@autopilot-agent/core";
import { createResponsesWebSearchCapability, probeResponsesWebSearchConnectivity } from "./deepseek-responses-search";
import { createXiaomiMiMoChatWebSearchCapability, probeXiaomiMiMoChatSearchConnectivity } from "./xiaomi-mimo-chat-search";
import { createAnthropicWebSearchCapability, probeAnthropicWebSearchConnectivity } from "./anthropic-web-search";

/** Provider 连通探测只返回宿主可安全展示的状态。 */
export type WebSearchProviderConnectivity = "reachable" | "server_error" | "unsupported";

/** 创建 Search Provider 能力所需的中性依赖。 */
export interface CreateWebSearchProviderCapabilityOptions {
  credentialRef: CredentialRef;
  credentialStore: CredentialStore;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}

/** 一个受支持厂商的协议适配器绑定：create 装配能力，probe 做无凭据连通探测。 */
interface SearchProviderAdapter {
  create(options: CreateWebSearchProviderCapabilityOptions): WebSearchCapability;
  probe(baseUrl: string, fetchImplementation: typeof fetch, signal?: AbortSignal): Promise<WebSearchProviderConnectivity>;
}

/** 受支持厂商 → 协议适配器注册表；未登记的 provider 一律 fail closed。 */
const SEARCH_PROVIDER_ADAPTERS: Readonly<Record<string, SearchProviderAdapter>> = {
  // DeepSeek 官方搜索走 Anthropic 兼容 /messages 的 web_search server tool（Responses 端点内置 web_search 已被上游忽略）。
  deepseek: { create: createAnthropicWebSearchCapability, probe: probeAnthropicWebSearchConnectivity },
  // OpenAI Responses-compatible 供应商共享 Responses 内置 web_search 适配器。
  "openai-compatible": { create: createResponsesWebSearchCapability, probe: probeResponsesWebSearchConnectivity },
  // 小米 MiMo 只在 Chat Completions 提供内置 web_search 工具。
  "xiaomi-mimo": { create: createXiaomiMiMoChatWebSearchCapability, probe: probeXiaomiMiMoChatSearchConnectivity },
};

/** 按 CredentialRef 中的 provider 查注册表并装配唯一协议适配器，不支持时 fail closed。 */
export function createWebSearchProviderCapability(options: CreateWebSearchProviderCapabilityOptions): WebSearchCapability | undefined {
  return SEARCH_PROVIDER_ADAPTERS[options.credentialRef.provider]?.create(options);
}

/** 按 provider 查注册表并调用具体协议的无凭据连通探测，未登记 provider 不发网络请求。 */
export async function probeWebSearchProviderConnectivity(provider: string, baseUrl: string, fetchImplementation: typeof fetch, signal?: AbortSignal): Promise<WebSearchProviderConnectivity> {
  const adapter = SEARCH_PROVIDER_ADAPTERS[provider];
  return adapter ? adapter.probe(baseUrl, fetchImplementation, signal) : "unsupported";
}
