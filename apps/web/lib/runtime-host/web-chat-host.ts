/** Chat 宿主组合根：用现有 Core Runtime 和 Node Chat Ports 装配应用级会话，不经过 Workspace。 */
import type { RunConfig } from "@autopilot-agent/core";
import { createNodeChatStorage, createNodeChatCapabilityLoader, createNodeCapabilityLoader, createNodeRagRuntime, createNodeSettingsLoader, type CreateNodeChatStorageOptions, type NodeChatCapabilityLoaderOptions } from "@autopilot-agent/adapters";
import { createChatKnowledgeService } from "./chat-knowledge-service";
import { loadCore } from "../core-loader";
import { createSettingsRunConfig } from "../settings/runtime-settings";

/** 宿主/测试注入端口，绝不接受浏览器的 Runtime、路径或 loader 参数。 */
export interface WebChatHostOptions extends CreateNodeChatStorageOptions {
  homeDirectory?: string;
  modelSampler?: RunConfig["modelSampler"];
  capability?: Omit<NodeChatCapabilityLoaderOptions, "storage">;
  /** Search 的受信 HTTP 测试端口；生产复用 Adapter 的默认网络实现。 */
  webSearchFetch?: typeof fetch;
}

/** 只负责选择依赖和释放句柄；Session、Turn、取消、压缩仍由同一个 Core 实现负责。 */
export async function createWebChatHost(options: WebChatHostOptions = {}) {
  const core = loadCore();
  const settingsLoader = createNodeSettingsLoader({ homeDirectory: options.homeDirectory });
  let loaded = settingsLoader.loadUser();
  const storage = createNodeChatStorage({ ...options, userSettingsPath: loaded.paths.user, parseDocument: options.parseDocument ?? core.parseDocument });
  const controller = new AbortController();
  const env = options.env ?? process.env;
  /** 每次管理操作或新 RAG Turn 从同一 User 快照构造四角色连接。 */
  function loadRagOptions() { return createNodeRagRuntime({ settings: loaded.settings, userSettingsPath: loaded.paths.user, env }); }
  const knowledge = createChatKnowledgeService(storage, controller.signal, env, loadRagOptions);
  const webLoader = createNodeCapabilityLoader({ settingsLoader, env, webSearchFetch: options.webSearchFetch });
  /** 每个 Turn 从最新 User settings 继承主连接视觉角色；显式旧视觉 route 仅作迁移兼容。 */
  function createChatVisionAnalyzer() {
    if (options.capability?.visionAnalyzer) return options.capability.visionAnalyzer;
    if (loaded.settings.visionModelRef === false) return undefined;
    const ref = loaded.settings.visionModelRef ?? loaded.settings.modelRef;
    if (ref && ref.provider !== "firstParty") {
      const route = loaded.settings.providerRoutes[ref.provider];
      if (!route) return undefined;
      return core.createVisionAnalyzer({ ref, apiProtocol: route.apiProtocol, baseUrl: route.baseUrl, credentialRef: route.credentialRef }, async function resolveConfiguredCredential() { return storage.ports.credentialStore.resolve(route.credentialRef); });
    }
    if (ref && loaded.settings.firstParty.baseUrl && loaded.settings.firstParty.credentialRef) {
      const credentialRef = loaded.settings.firstParty.credentialRef;
      return core.createVisionAnalyzer({ ref, apiProtocol: "anthropic-messages", baseUrl: loaded.settings.firstParty.baseUrl, credentialRef }, async function resolveMainCredential() { return storage.ports.credentialStore.resolve(credentialRef); });
    }
    if (!env.LLM_MODEL || !env.LLM_BASE_URL || !env.TONGYI_API_KEY) return undefined;
    return core.createVisionAnalyzer({ ref: { provider: "environment", modelId: env.LLM_MODEL }, apiProtocol: "openai-chat-completions", baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ""), credentialRef: { provider: "environment", key: "TONGYI_API_KEY" } }, async function resolveEnvironmentCredential() { return env.TONGYI_API_KEY ? { apiKey: env.TONGYI_API_KEY } : undefined; });
  }
  const runtime = core.createAgentRuntime({
    ports: storage.ports,
    defaultRunConfig: {
      modelSampler: options.modelSampler,
      modelSamplerFactory: options.modelSampler ? undefined : core.createDefaultModelSamplerFactory(),
      async chatLoader(binding) {
        return createNodeChatCapabilityLoader({ loadKnowledge: knowledge.loadKnowledge, ...options.capability, visionAnalyzer: createChatVisionAnalyzer(), storage })(binding);
      },
      /** Core 仅在持久 web 身份下调用；每次重新解析 User 配置，不缓存旧搜索能力。 */
      webLoader: function loadChatWeb() { return webLoader.loadChatWeb({ retrievalMode: "web" }); },
      /** User settings 只影响下一 Turn，不读取项目配置或旧 Memory。 */
      getRuntimeDefaults() { return createSettingsRunConfig(loaded.settings); },
    },
  });
  let stopMaintenance: (() => void) | undefined;
  let stopSettings: (() => void) | undefined;
  try {
    // 恢复附件清理后再收敛中断的 Session 删除；任一失败都不宣称 Host 已就绪。
    stopMaintenance = await storage.attachments.startMaintenance(function reportCleanupFailure(code) { console.warn(code); }, controller.signal);
    for (const session of await runtime.sessions.list()) {
      if (storage.attachments.isSessionDeleting(session.id)) await runtime.sessions.delete(session.id);
    }
    stopSettings = settingsLoader.watchUser(function updateUserSettings(next) { loaded = next; });
  } catch (error) {
    controller.abort();
    stopMaintenance?.();
    throw error;
  }
  /** 释放宿主所有句柄；重复停止无副作用，不接管 Next 的退出流程。 */
  function stop(): void { controller.abort(); stopMaintenance?.(); stopSettings?.(); process.removeListener("exit", stop); }
  process.once("exit", stop);
  return {
    runtime,
    storage,
    knowledge,
    signal: controller.signal,
    /** 停止宿主会取消所属请求，释放 User watcher 和附件维护定时器。 */
    stop,
  };
}

export type WebChatHost = Awaited<ReturnType<typeof createWebChatHost>>;
const key = "__autopilotWebChatHost__";
type HostGlobal = typeof globalThis & { [key]?: Promise<WebChatHost> };

/** 和 Workspace Host 一样按进程缓存，热重载与并发请求复用同一宿主。 */
export function getWebChatHost(): Promise<WebChatHost> {
  const state = globalThis as HostGlobal;
  if (!state[key]) {
    const pending = createWebChatHost();
    state[key] = pending;
    /** 启动失败释放缓存，下一请求可以重试。 */
    void pending.catch(function releaseFailedHost() { if (state[key] === pending) delete state[key]; });
  }
  return state[key]!;
}

/** 服务器停止时释放 Chat 宿主，测试也复用此生命周期。 */
export async function stopWebChatHost(): Promise<void> {
  const state = globalThis as HostGlobal;
  const pending = state[key];
  delete state[key];
  (await pending)?.stop();
}
