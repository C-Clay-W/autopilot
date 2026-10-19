/**
 * Node capability loader Composition：统一装配 MCP、Context 和 Skill 的宿主实现。
 */

import type { AgentContextSnapshot, AgentSkillsCapability, ChatCapabilityBinding, McpCapability, WebCapability } from "@autopilot-agent/core";
import type { LoadedNodeUserSettings } from "./settings/node-settings-loader";
import { createContextBudget } from "./capabilities/context-budget";
import { discoverInstructions } from "./capabilities/instruction-store";
import { loadMcpConfigFromWorkspace } from "./capabilities/mcp-loader";
import { createSkillsCapability } from "./capabilities/skill-discovery";
import type { NodeCapabilityLoaderOptions } from "./types";
import { createNodeCredentialStore } from "./stores/node-credential-store";
import {
  createWebSearchProviderCapability,
  probeWebSearchProviderConnectivity,
  type WebSearchProviderConnectivity,
} from "./capabilities/web/web-search-provider";
import { createSafeWebFetchCapability } from "./capabilities/web/safe-web-fetch";

/** 只消费当前 Core 已校验的完整 Search 连接。 */
function resolveSearchConnection(loaded?: LoadedNodeUserSettings) {
  return loaded?.settings.webSearch;
}

/** Node capability loader 的宿主输出；Provider 仍由宿主按 trust 后策略注入。 */
export interface NodeCapabilityLoader {
  loadMcp(workspaceRoot: string): McpCapability | undefined;
  loadContext(workspaceRoot: string, query?: string): AgentContextSnapshot;
  loadSkills(workspaceRoot: string): AgentSkillsCapability | undefined;
  /** Trust 后从 User settings 与 CredentialStore 装配可用的公开网络子能力。 */
  loadWeb(workspaceRoot: string): Promise<WebCapability | undefined>;
  /** 仅 Chat web 读取 User settings 并解析 Search 凭据，none/rag 直接返回空。 */
  loadChatWeb(binding: ChatCapabilityBinding | Pick<ChatCapabilityBinding, "retrievalMode">): Promise<WebCapability | undefined>;
  /** 对用户已选的 Search provider 执行无凭据连通探测。 */
  probeWebSearchConnectivity(workspaceRoot: string, signal?: AbortSignal): Promise<WebSearchProviderConnectivity>;
}

/** 创建不包含 Provider 的 Node capability loader；Provider 仍由宿主按 trust 后策略注入。 */
export function createNodeCapabilityLoader(options: NodeCapabilityLoaderOptions = {}): NodeCapabilityLoader {
  const environment = options.env ?? process.env;
  const webFetch = createSafeWebFetchCapability();

  /** 两种宿主复用相同 Web Provider 装配，仅由入口决定允许读取的 settings 来源。 */
  async function loadWebSettings(loaded?: LoadedNodeUserSettings): Promise<WebCapability> {
    const configured = resolveSearchConnection(loaded) ?? (
      !loaded?.settings.webSearchDisabled
      && !loaded?.settings.diagnostics.some(function invalidSearch(item) { return item.field === "webSearch"; })
      && loaded?.settings.firstParty.baseUrl === "https://api.deepseek.com/anthropic"
      && loaded.settings.firstParty.credentialRef
        ? { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", credentialRef: { provider: "deepseek", key: loaded.settings.firstParty.credentialRef.key } }
        : undefined
    );
    if (!configured || !loaded) return { fetch: webFetch };
    const credentialStore = createNodeCredentialStore({ env: environment, userSettingsPath: loaded.paths.user, snapshot: true });
    try {
      await credentialStore.resolve(configured.credentialRef);
      const search = createWebSearchProviderCapability({ credentialRef: configured.credentialRef, credentialStore, baseUrl: configured.baseUrl, model: configured.model, fetch: options.webSearchFetch });
      return search ? { search, fetch: webFetch } : { fetch: webFetch };
    } catch { return { fetch: webFetch }; }
  }
  return {
    loadMcp(workspaceRoot: string) {
      return loadMcpConfigFromWorkspace(workspaceRoot);
    },

    loadContext(workspaceRoot: string, query?: string): AgentContextSnapshot {
      const discovery = discoverInstructions(workspaceRoot);
      const memories: AgentContextSnapshot["memories"] = [];
      const diagnostics = [...discovery.diagnostics];
      if (query?.trim()) diagnostics.push("LEGACY_MEMORY_REVIEW_REQUIRED");
      const budget = createContextBudget({ instructions: discovery.instructions.map((item) => item.content).join("\n"), memories: memories.map((item) => item.content).join("\n") }, options.env);
      return {
        instructions: discovery.instructions,
        memories,
        budget: { ...budget, diagnostics: [...diagnostics, ...budget.diagnostics] },
      };
    },

    loadSkills(workspaceRoot: string) {
      return createSkillsCapability(workspaceRoot, options);
    },

    /** Trust 后始终装配安全 Fetch；Search 仅在 User 配置与凭据都可用时加入。 */
    async loadWeb(workspaceRoot: string): Promise<WebCapability | undefined> {
      return loadWebSettings(options.settingsLoader?.load(workspaceRoot));
    },

    /** 在任何 settings/credential 读取前拒绝非 web Chat，不伪造工作区传给旧 loader。 */
    async loadChatWeb(binding): Promise<WebCapability | undefined> {
      if (binding.retrievalMode !== "web") return undefined;
      return loadWebSettings(options.settingsLoader?.loadUser?.());
    },

    /** 仅把 provider 选择交给内部注册边界，不在通用 loader 中感知 endpoint。 */
    async probeWebSearchConnectivity(workspaceRoot: string, signal?: AbortSignal): Promise<WebSearchProviderConnectivity> {
      if (!options.settingsLoader) return "unsupported";
      const configured = resolveSearchConnection(options.settingsLoader.load(workspaceRoot));
      if (!configured) return "unsupported";
      return probeWebSearchProviderConnectivity(
        configured.credentialRef.provider,
        configured.baseUrl,
        options.webSearchConnectivityFetch ?? globalThis.fetch,
        signal,
      );
    },
  };
}
