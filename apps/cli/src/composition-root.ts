/**
 * CLI Composition Root。
 *
 * 负责选择 Core 默认 Runtime、共享 Node Adapter、canonical workspaceRoot、
 * trust policy 和显式 stateRoot；不负责命令解析、事件投影或 Runtime 状态机。
 */

import { WEB_SEARCH_DATA_FLOW_NOTICE } from "@autopilot-agent/presentation";
import {
  createDefaultModelSamplerFactory,
  createRuntimeBootstrapService,
  createSafeBootstrapConfig,
  WorkspaceTrustError,
  type AgentRuntime,
  type AgentSkillsCapability,
  type CapabilityLoader,
  type CreateRuntimeBootstrapServiceOptions,
  type RuntimeBootstrapService,
  type ResolvedAutopilotSettings,
  type SafeBootstrapConfig,
  type SandboxCapabilityReport,
  type SandboxPort,
  type WorkspaceTrustEntry,
  type WorkspaceTrustPolicy,
  getMcpServerGrantConstraint,
  type McpServerConfig,
  type ModelSamplerFactory,
} from "@autopilot-agent/core";
import type { CliRuntimeStatusDefaults, CliSkillSummary } from "./types.js";
import {
  createNodeCredentialStore,
  createNodeCapabilityLoader,
  createNodeHostExecutionSandboxPort,
  createNodeSandboxPort,
  createNodeSettingsLoader,
  createNodeSettingsWriter,
  ensureUserConfigDirectory,
  createNodeRuntimePorts,
  createNodeTrustPolicy,
  createNodeWorkspaceRegistry,
  createNodeWorkspaceAdapter,
  createNodeWorkspaceId,
  getNodeStateCorruptionDiagnostics,
  getNodeStatePaths,
  getNodeStateSchemaDiagnostic,
  initializeNodeStateRoot,
  resolveNodeSettingsPaths,
  resolveNodeStateRoot,
  assertNodeStateSchema,
  type WorkspaceRegistryEntry,
  type LoadedNodeSettings,
  type NodeCapabilityLoader,
  type NodeSettingsLoader,
} from "@autopilot-agent/adapters";
import fs from "node:fs";
import path from "node:path";
import type { AutopilotSettingsScope } from "@autopilot-agent/core";

/** Doctor 单项结果；只含状态和脱敏摘要，绝不包含路径、凭据或 Provider 正文。 */
export interface CliDoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL" | "SKIP";
  detail: string;
}

/** CLI Composition Root 的装配选项。 */
export interface CreateCliCompositionRootOptions {
  config?: SafeBootstrapConfig;
  stateRoot?: string;
  trustRoot?: string;
  workspaceRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  trustPolicy?: WorkspaceTrustPolicy;
  capabilityLoader?: CliCapabilityLoader;
  defaultRunConfig?: CreateRuntimeBootstrapServiceOptions["defaultRunConfig"];
  /** 已信任 settings Loader 的测试 seam；生产默认创建 Node Loader。 */
  settingsLoader?: NodeSettingsLoader;
  /** Doctor 连通性探测的测试 seam；生产默认使用全局 fetch。 */
  connectivityFetch?: typeof fetch;
  /** Web Search 请求的 fake HTTP 测试 seam；生产默认使用平台原生 fetch。 */
  webSearchFetch?: typeof fetch;
}

/** CLI 能力加载器：沿用 Node 的开发能力，但禁止 RAG loader 进入 CLI 装配边界。 */
export type CliCapabilityLoader = CapabilityLoader
  & Partial<Pick<NodeCapabilityLoader, "probeWebSearchConnectivity">>;

/** CLI 专用模型行为补充：无结构化 answerer 时以普通正文完成最少必要澄清。 */
const CLI_TEXT_CLARIFICATION_INSTRUCTIONS = `当前宿主是 CLI，未提供 ask_user_question 或其他结构化用户回答能力。仅在完成任务确实缺少方向性信息、且不能从当前用户输入、会话历史或工作区安全获得时，才在普通助手正文中用最少必要的简短问题向用户澄清；提出问题后正常结束当前 Turn，等待用户下一条 prompt 作为同一 Session 的新 Turn 继续。不要臆造或调用 ask_user_question，不要把澄清伪装成审批，也不要在等待澄清时猜测并执行写入或命令工具。用户下一条 prompt 与任何 Other/custom 文本都不授予 Trust、权限或审批；后续工具调用仍必须遵守既有 Policy 与 Approval 约束。Agent 自身的临时脚本、截图裁剪和中间文件必须写入项目根目录的 .autopilot/tmp，不得写入 node_modules 或随意污染业务目录；用户明确指定的目标路径除外。`;

/** CLI Composition Root 对外暴露的启动边界。 */
export interface CliCompositionRoot {
  readonly stateRoot: string;
  /** 仅由已解析的业务命令调用，保障当前用户配置根存在且安全。 */
  ensureUserConfigDirectory(): void;
  /** Trust 成功后创建当前项目的 .autopilot 与临时文件目录，不生成 settings 文件。 */
  ensureProjectAutopilotDirectory(workspaceRoot: string): void;
  establishTrust(): Promise<{ workspaceRoot: string; trustEntry: WorkspaceTrustEntry }>;
  /** Trust 前解析 canonical 工作区并读取信任状态；未信任时返回记录而不抛 WorkspaceTrustError。 */
  resolveTrust(): Promise<{ workspaceRoot: string; trustEntry: WorkspaceTrustEntry }>;
  /** 授予精确 canonical 工作区信任并返回持久化后的记录。 */
  grantTrust(workspaceRoot: string): Promise<WorkspaceTrustEntry>;
  /** 读取指定工作区的当前信任状态。 */
  getTrustStatus(workspaceRoot: string): Promise<WorkspaceTrustEntry>;
  /** 撤销当前 canonical workspace 的 Trust；调用后不得继续创建 Runtime。 */
  revokeTrust(workspaceRoot: string): Promise<WorkspaceTrustEntry>;
  /** 读取宿主级工作区索引；不会扫描磁盘或创建状态根。 */
  listWorkspaceRegistry(): WorkspaceRegistryEntry[];
  /** 仅注销 Registry 索引条目，不删除任何工作区数据。 */
  removeWorkspaceRegistry(workspaceId: string): boolean;
  /** 读取显式 scope 的脱敏 settings。 */
  showConfig(scope: AutopilotSettingsScope, workspaceRoot: string): Record<string, unknown>;
  /** 读取显式 scope 下允许公开的单个 settings 值。 */
  getConfig(scope: AutopilotSettingsScope, key: string, workspaceRoot: string): unknown;
  /** 写入显式 scope 下允许公开的单个 settings 值。 */
  setConfig(scope: AutopilotSettingsScope, key: string, value: string, workspaceRoot: string): Record<string, unknown>;
  /** 执行默认离线或显式受限连通性 Doctor 检查。 */
  doctor(workspaceRoot: string, connectivity: boolean): Promise<CliDoctorCheck[]>;
  /** 读取当前平台沙箱能力报告（脱敏）；绑定传入的 canonical workspace。 */
  sandboxStatus(workspaceRoot: string): Promise<SandboxCapabilityReport>;
  /** 显式触发沙箱 setup（Windows UAC 安装；macOS 仅返回当前能力报告）。 */
  sandboxSetup(workspaceRoot: string): Promise<SandboxCapabilityReport>;
  createRuntime(workspaceRoot: string): Promise<AgentRuntime>;
  bootstrap(): Promise<AgentRuntime>;
  getBootstrapService(): RuntimeBootstrapService;
  /** 只向 Controller 暴露可安全显示的已热更新 settings 默认值。 */
  getRuntimeStatusDefaults(): CliRuntimeStatusDefaults;
  /** 返回不含凭据的首次运行配置诊断；undefined 表示可继续启动。 */
  getStartupConfigurationError(): string | undefined;
  listSkills(): Promise<CliSkillSummary[]>;
  resolveSkill(skill: string): Promise<{ skillId: string; contentHash: string }>;
  /** 返回不含环境变量的 MCP server 审批摘要与执行隔离事实。 */
  listMcp(workspaceRoot: string): Promise<Array<{ serverName: string; program: string; args: string[]; cwd: string; approved: boolean; executionMode: "sandbox" | "host"; isolation: "sandboxed" | "unisolated" }>>;
  /** 保存精确 configHash 绑定的 workspace grant；调用方必须已完成 CLI 确认。 */
  approveMcp(workspaceRoot: string, serverName: string): Promise<{ serverName: string }>;
  /** 删除 server 当前 configHash 对应的 workspace grant。 */
  revokeMcp(workspaceRoot: string, serverName: string): Promise<boolean>;
}

/** 创建项目级 Agent 运行目录；拒绝链接/文件替代目录，避免临时文件逃逸工作区。 */
function ensureProjectAutopilotDirectory(workspaceRoot: string): void {
  try {
    const projectRoot = fs.realpathSync.native(path.resolve(workspaceRoot));
    const autopilotRoot = path.join(projectRoot, ".autopilot");
    const temporaryRoot = path.join(autopilotRoot, "tmp");
    for (const directory of [autopilotRoot, temporaryRoot]) {
      let entry: fs.Stats | undefined;
      try {
        entry = fs.lstatSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (entry?.isSymbolicLink() || entry && !entry.isDirectory()) throw new Error("unsafe project autopilot directory");
      if (!entry) fs.mkdirSync(directory, { recursive: true });
      const canonicalDirectory = fs.realpathSync.native(directory);
      const relative = path.relative(projectRoot, canonicalDirectory);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("project autopilot directory escaped workspace");
    }
  } catch {
    throw new Error("AUTOPILOT_PROJECT_DIRECTORY_UNAVAILABLE");
  }
}

/** 删除外部自定义 loader 中的 RAG 字段，防止 CLI 透传或触发 loadRag。 */
function omitCliRagCapabilityLoader(loader: CapabilityLoader | CliCapabilityLoader): CliCapabilityLoader {
  const safeLoader = { ...loader } as CliCapabilityLoader & { loadRag?: unknown };
  delete safeLoader.loadRag;
  return safeLoader;
}

/** 为任意 CLI Provider 工厂叠加宿主澄清指令，保留原采样和完成策略。 */
function withCliTextClarificationBehavior(factory: ModelSamplerFactory): ModelSamplerFactory {
  return {
    create(input) {
      const sampler = factory.create(input);
      const profile = sampler.behaviorProfile;
      return {
        ...sampler,
        behaviorProfile: {
          id: `${profile?.id ?? "cli"}-text-clarification`,
          instructions: [profile?.instructions, CLI_TEXT_CLARIFICATION_INSTRUCTIONS].filter(Boolean).join("\n\n"),
          completionPolicy: profile?.completionPolicy,
        },
      };
    },
    getSupportedProviders() {
      return factory.getSupportedProviders();
    },
  };
}

/** 创建 CLI Composition Root；只有 Runtime bootstrap 的 trust 成功阶段才初始化状态 manifest。 */
export function createCliCompositionRoot(options: CreateCliCompositionRootOptions = {}): CliCompositionRoot {
  const env = options.env ?? process.env;
  // CLI 工作区候选优先级：显式 --workspace-root → AGENT_WORKSPACE_ROOT → 启动 cwd。
  // 候选只在 CLI 层解析；Node WorkspaceAdapter 负责 canonicalize，不再向上探测 monorepo 根。
  const workspaceCandidate = options.workspaceRoot ?? env.AGENT_WORKSPACE_ROOT ?? options.cwd ?? process.cwd();
  const config = options.config ?? createSafeBootstrapConfig({
    host: "cli",
    workspaceRoot: workspaceCandidate,
  });
  const stateRoot = resolveNodeStateRoot({ stateRoot: options.stateRoot, workspaceRoot: workspaceCandidate, cwd: options.cwd });
  const workspaceAdapter = createNodeWorkspaceAdapter({
    workspaceRoot: config.workspaceRoot ?? workspaceCandidate,
    cwd: options.cwd,
    env,
  });
  const trustPolicy = options.trustPolicy ?? createNodeTrustPolicy({
    stateRoot,
    trustRoot: options.trustRoot,
  });
  const settingsLoader = options.settingsLoader ?? createNodeSettingsLoader();
  const nodeCapabilityLoader = createNodeCapabilityLoader({
    env,
    stateRoot,
    settingsLoader,
    webSearchFetch: options.webSearchFetch,
    webSearchConnectivityFetch: options.connectivityFetch,
  });
  const settingsWriter = createNodeSettingsWriter();
  const workspaceRegistry = createNodeWorkspaceRegistry({ cwd: options.cwd });
  let resolvedSettings: ResolvedAutopilotSettings | undefined;
  let userSettingsPath: string | undefined;
  let stopSettingsWatch: (() => void) | undefined;
  /** 最近一次 createRuntime 的 canonical workspaceRoot；tempRoot 注入以其为准。 */
  let activeWorkspaceRoot: string | undefined;
  /** 返回当前 settings 选中模型对应的 route；firstParty 使用 CC 主配置。 */
  function getSelectedProviderSettings(settings: ResolvedAutopilotSettings) {
    const selectedRoute = settings.modelRef && settings.modelRef.provider !== "firstParty"
      ? settings.providerRoutes[settings.modelRef.provider]
      : undefined;
    if (selectedRoute) {
      return {
        apiProtocol: selectedRoute.apiProtocol,
        protocolProfile: selectedRoute.protocolProfile,
        baseUrl: selectedRoute.baseUrl,
        credentialRef: selectedRoute.credentialRef,
        maxOutputTokens: settings.firstParty.maxOutputTokens,
      };
    }
    if (settings.modelRef && settings.modelRef.provider !== "firstParty") return undefined;
    return {
      apiProtocol: "anthropic-messages" as const,
      baseUrl: settings.firstParty.baseUrl,
      credentialRef: settings.firstParty.credentialRef,
      maxOutputTokens: settings.firstParty.maxOutputTokens,
      compactThresholdTokens: settings.firstParty.compactWindow,
      timeoutMs: settings.firstParty.timeoutMs,
      subagentModelId: settings.firstParty.subagentModelId,
      thinkingEnabled: settings.firstParty.thinkingEnabled,
    };
  }
  /** trust 后读取并监听 settings；每次回调只替换下一 Turn 的默认快照。 */
  function activateSettings(workspaceRoot: string): void {
    const loaded = settingsLoader.load(workspaceRoot);
    resolvedSettings = loaded.settings;
    userSettingsPath = loaded.paths.user;
    stopSettingsWatch?.();
    stopSettingsWatch = settingsLoader.watch(workspaceRoot, function replaceSettings(next: LoadedNodeSettings) {
      resolvedSettings = next.settings;
    });
  }
  /** 只检查 Agent 主模型最小配置；不读取或显示任何真实 Key。 */
  function getStartupConfigurationError(): string | undefined {
    const settingsPath = userSettingsPath ?? resolveNodeSettingsPaths(config.workspaceRoot ?? workspaceCandidate).user;
    const selectedProvider = resolvedSettings ? getSelectedProviderSettings(resolvedSettings) : undefined;
    const hasPrimaryCredential = Boolean(selectedProvider?.credentialRef);
    if (resolvedSettings?.modelRef && hasPrimaryCredential) return undefined;
    const missing: string[] = [];
    if (!resolvedSettings?.modelRef) missing.push("model or env.ANTHROPIC_MODEL");
    if (!hasPrimaryCredential) {
      missing.push(selectedProvider ? "selected provider credential" : "selected provider route and credential");
    }
    return `AUTOPILOT_CONFIGURATION_REQUIRED: ${settingsPath}; missing ${missing.join(", ")}`;
  }
  /** 从当前 CC settings 生成可切换模型目录；不按模型名猜测供应商能力。 */
  function getModelCapabilities() {
    if (!resolvedSettings) return [];
    const capabilities: Array<{ provider: string; modelId: string; requestableEfforts: readonly string[] }> = [];
    const seen = new Set<string>();
    const firstPartyEfforts = ["none", "low", "medium", "high", "max"] as const;
    function getRouteRequestableEfforts(route: NonNullable<ResolvedAutopilotSettings["providerRoutes"][string]>, modelId: string): readonly string[] {
      const model = route.models.find(function findModel(candidate) { return candidate.id === modelId; });
      const profile = model?.protocolProfile ?? route.protocolProfile;
      return route.apiProtocol === "openai-chat-completions"
        && (profile?.apiProtocol !== "openai-chat-completions" || !profile.supportsReasoningContent) ? ["none"] as const : firstPartyEfforts;
    }
    function addCapability(provider: string, modelId: string, requestableEfforts: readonly string[]): void {
      const key = `${provider}/${modelId}`;
      if (!modelId || seen.has(key)) return;
      seen.add(key);
      capabilities.push({ provider, modelId, requestableEfforts });
    }
    // 开发态 CLI 可能仍链接上一轮 Core 产物；回退 availableModels 以保持 settings 热更新兼容。
    const configuredModels = resolvedSettings.modelCandidates.length > 0
      ? resolvedSettings.modelCandidates
      : resolvedSettings.availableModels;
    for (const candidate of configuredModels) {
      const separator = candidate.indexOf("/");
      if (separator > 0 && separator < candidate.length - 1) {
        const provider = candidate.slice(0, separator);
        const modelId = candidate.slice(separator + 1);
        const route = resolvedSettings.providerRoutes[provider];
        if (route?.models.some(function hasModel(model) { return model.id === modelId; })) addCapability(provider, modelId, getRouteRequestableEfforts(route, modelId));
        continue;
      }
      addCapability("firstParty", candidate, firstPartyEfforts);
    }
    // Route 模型目录不能因 availableModels 是否声明而丢失，始终与 firstParty 目录合并。
    for (const [provider, route] of Object.entries(resolvedSettings.providerRoutes)) {
      for (const model of route.models) addCapability(provider, model.id, getRouteRequestableEfforts(route, model.id));
    }
    if (resolvedSettings.modelRef) {
      const provider = resolvedSettings.modelRef.provider;
      const modelId = resolvedSettings.modelRef.modelId;
      const route = resolvedSettings.providerRoutes[provider];
      if (provider === "firstParty") addCapability(provider, modelId, firstPartyEfforts);
      else if (route?.models.some(function hasModel(model) { return model.id === modelId; })) addCapability(provider, modelId, getRouteRequestableEfforts(route, modelId));
    }
    return capabilities;
  }
  /** 检查一个已存在状态根的可读写性，Doctor 不创建缺失目录。 */
  function getExistingStateRootAccess(): "PASS" | "WARN" | "FAIL" {
    const statePaths = getNodeStatePaths(stateRoot);
    if (!fs.existsSync(statePaths.root)) return "WARN";
    try {
      fs.accessSync(statePaths.root, fs.constants.R_OK | fs.constants.W_OK);
      return "PASS";
    } catch {
      return "FAIL";
    }
  }

  /** 惰性创建的沙箱查询端口；绑定当前 canonical workspaceRoot，同一 root 复用实例。 */
  let sandboxPort: SandboxPort | undefined;
  let sandboxPortRoot: string | undefined;
  function getSandboxPort(workspaceRoot: string): SandboxPort {
    // Talk-Plan1022 S1：Windows 宿主执行模式——status/setup/doctor 只报告停用事实，
    // 不加载 SRT、不触发 UAC provision；macOS 装配保持不变。
    if (process.platform === "win32") {
      if (!sandboxPort || sandboxPortRoot !== workspaceRoot) {
        sandboxPort = createNodeHostExecutionSandboxPort();
        sandboxPortRoot = workspaceRoot;
      }
      return sandboxPort;
    }
    if (!sandboxPort || sandboxPortRoot !== workspaceRoot) {
      sandboxPort = createNodeSandboxPort({
        workspaceRoot,
        stateRoot,
        tempRoot: path.join(workspaceRoot, ".autopilot", "tmp"),
      });
      sandboxPortRoot = workspaceRoot;
    }
    return sandboxPort;
  }
  /** 显式 Doctor 连通性探测仅验证端点可达性，不发送凭据、模型或请求正文。 */
  async function checkConnectivity(workspaceRoot: string): Promise<CliDoctorCheck> {
    activateSettings(workspaceRoot);
    const selectedProvider = resolvedSettings ? getSelectedProviderSettings(resolvedSettings) : undefined;
    if (!resolvedSettings?.modelRef || !selectedProvider?.credentialRef || !selectedProvider.baseUrl && resolvedSettings.modelRef.provider !== "firstParty") {
      return { name: "provider_connectivity", status: "WARN", detail: "provider configuration incomplete" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(function abortConnectivityProbe() { controller.abort(); }, 5_000);
    try {
      const response = await (options.connectivityFetch ?? globalThis.fetch)(
        selectedProvider.baseUrl ?? "https://api.anthropic.com",
        { method: "HEAD", redirect: "manual", signal: controller.signal },
      );
      return response.status >= 500
        ? { name: "provider_connectivity", status: "WARN", detail: "endpoint responded with server error" }
        : { name: "provider_connectivity", status: "PASS", detail: "endpoint reachable" };
    } catch (error) {
      return {
        name: "provider_connectivity",
        status: "FAIL",
        detail: error instanceof Error && error.name === "AbortError" ? "connection timed out" : "connection failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 检查 Search 凭据引用能否解析，真实 Key 只在局部变量中短暂存在且不进入结果。 */
  async function hasWebSearchCredential(loaded: LoadedNodeSettings): Promise<boolean> {
    const configured = loaded.settings.webSearch;
    if (!configured) return false;
    const credentialStore = createNodeCredentialStore({ env, userSettingsPath: loaded.paths.user });
    try {
      await credentialStore.resolve(configured.credentialRef);
      return true;
    } catch {
      return false;
    }
  }

  /** 显式 Doctor 通过 Provider 边界执行无凭据、无正文连通探测。 */
  async function checkWebSearchConnectivity(workspaceRoot: string, credentialAvailable: boolean): Promise<CliDoctorCheck> {
    if (!credentialAvailable) return { name: "web_search_connectivity", status: "SKIP", detail: "credential unavailable" };
    if (!safeBaseCapabilityLoader.probeWebSearchConnectivity) {
      return { name: "web_search_connectivity", status: "WARN", detail: "probe unavailable" };
    }
    const controller = new AbortController();
    /** 到达 Doctor 固定等待上限时终止无正文探测。 */
    function abortWebSearchConnectivityProbe(): void {
      controller.abort();
    }
    const timeout = setTimeout(abortWebSearchConnectivityProbe, 5_000);
    try {
      const status = await safeBaseCapabilityLoader.probeWebSearchConnectivity(workspaceRoot, controller.signal);
      if (status === "unsupported") {
        return { name: "web_search_connectivity", status: "WARN", detail: "provider unsupported" };
      }
      return status === "server_error"
        ? { name: "web_search_connectivity", status: "WARN", detail: "endpoint responded with server error" }
        : { name: "web_search_connectivity", status: "PASS", detail: "endpoint reachable" };
    } catch (error) {
      return {
        name: "web_search_connectivity",
        status: "FAIL",
        detail: error instanceof Error && error.name === "AbortError" ? "connection timed out" : "connection failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  const defaultCapabilityLoader: CliCapabilityLoader = {
    ...nodeCapabilityLoader,
    loadProvider() {
      return createDefaultModelSamplerFactory();
    },
  };
  const baseCapabilityLoader = options.capabilityLoader ?? defaultCapabilityLoader;
  const safeBaseCapabilityLoader = omitCliRagCapabilityLoader(baseCapabilityLoader);
  let loadedSkills: AgentSkillsCapability | undefined;
  const capabilityLoader: CapabilityLoader = {
    ...safeBaseCapabilityLoader,
    ...(safeBaseCapabilityLoader.loadProvider ? {
      async loadProvider(workspaceRoot: string) {
        return withCliTextClarificationBehavior(await safeBaseCapabilityLoader.loadProvider!(workspaceRoot));
      },
    } : {}),
    async loadSkills(workspaceRoot: string) {
      activateSettings(workspaceRoot);
      const skills = safeBaseCapabilityLoader.loadSkills
        ? await safeBaseCapabilityLoader.loadSkills(workspaceRoot)
        : undefined;
      loadedSkills = skills;
      return skills;
    },
  };

  const bootstrapService = createRuntimeBootstrapService({
    config,
    workspaceAdapter,
    trustPolicy,
    capabilityLoader,
    createPorts(workspaceRoot: string) {
      initializeNodeStateRoot(stateRoot);
      return createNodeRuntimePorts({
        stateRoot,
        trustRoot: options.trustRoot,
        workspaceRoot,
        env,
        userSettingsPath: resolveNodeSettingsPaths(workspaceRoot).user,
        // Talk-Plan0917：CLI 沙箱 tempRoot 精确指向 Trust 后项目内 .autopilot/tmp
        //（目录由 ensureProjectAutopilotDirectory 创建并验证），不继承 ambient temp。
        sandboxTempRoot: path.join(workspaceRoot, ".autopilot", "tmp"),
      });
    },
    defaultRunConfig: {
      ...options.defaultRunConfig,
      getRuntimeDefaults() {
        if (!resolvedSettings) return {};
        const selectedProvider = getSelectedProviderSettings(resolvedSettings);
        const visionRef = resolvedSettings.visionModelRef === false ? undefined : resolvedSettings.visionModelRef ?? resolvedSettings.modelRef;
        const visionRoute = visionRef && resolvedSettings.providerRoutes[visionRef.provider];
        return {
          ...(resolvedSettings.maxTurns !== undefined ? { maxSteps: resolvedSettings.maxTurns } : {}),
          ...(resolvedSettings.modelRef ? { modelRef: resolvedSettings.modelRef } : {}),
          ...(resolvedSettings.reasoningProfile ? { reasoningProfile: resolvedSettings.reasoningProfile } : {}),
          ...(selectedProvider?.credentialRef ? { credentialRef: selectedProvider.credentialRef } : {}),
          // Talk-Plan0917 Stage 2：settings 只允许声明 read-only/workspace-write；
          // tempRoot 固定指向当前 Runtime 工作区内的受控 .autopilot/tmp。
          ...(resolvedSettings.sandbox.mode ? { sandboxMode: resolvedSettings.sandbox.mode } : {}),
          ...(activeWorkspaceRoot ? { sandboxTempRoot: path.join(activeWorkspaceRoot, ".autopilot", "tmp") } : {}),
          providerSettings: {
            ...(selectedProvider ? { primary: selectedProvider } : {}),
            routes: resolvedSettings.providerRoutes,
            ...(visionRef ? { visionModelRef: visionRef, vision: visionRoute
              ? { apiProtocol: visionRoute.apiProtocol, baseUrl: visionRoute.baseUrl, credentialRef: visionRoute.credentialRef }
              : selectedProvider } : {}),
          },
        };
      },
    },
  });

  /** 读取当前受信任 workspace 的受控 MCP 配置；缺失或未知名称稳定返回 undefined。 */
  async function findMcpServer(workspaceRoot: string, serverName: string): Promise<McpServerConfig | undefined> {
    const capability = safeBaseCapabilityLoader.loadMcp ? await safeBaseCapabilityLoader.loadMcp(workspaceRoot) : undefined;
    return capability?.servers.find(function matchServer(server) { return server.name === serverName; });
  }

  /** 为 MCP 管理命令创建同一 stateRoot 下的 ApprovalStore，不装配模型或启动 MCP。 */
  function createMcpApprovalStore(workspaceRoot: string) {
    initializeNodeStateRoot(stateRoot);
    return createNodeRuntimePorts({ stateRoot, workspaceRoot, env, userSettingsPath: resolveNodeSettingsPaths(workspaceRoot).user }).approvalStore;
  }

  return {
    stateRoot,
    ensureUserConfigDirectory: function ensureConfigDirectory() {
      ensureUserConfigDirectory();
    },
    ensureProjectAutopilotDirectory,
    establishTrust: function establishTrust() {
      return bootstrapService.establishTrust();
    },
    resolveTrust: async function resolveTrust() {
      const candidate = config.workspaceRoot ?? (await workspaceAdapter.resolveWorkspaceRoot());
      if (!candidate) throw new WorkspaceTrustError("", "denied", "无法解析工作区根目录");
      const canonicalRoot = await workspaceAdapter.canonicalizeWorkspaceRoot(candidate);
      const trustEntry = await trustPolicy.getTrustStatus(canonicalRoot);
      return { workspaceRoot: canonicalRoot, trustEntry };
    },
    grantTrust: function grantTrust(workspaceRoot: string) {
      return trustPolicy.grantTrust(workspaceRoot);
    },
    getTrustStatus: function getTrustStatus(workspaceRoot: string) {
      return trustPolicy.getTrustStatus(workspaceRoot);
    },
    revokeTrust: function revokeTrust(workspaceRoot: string) {
      return trustPolicy.revokeTrust(workspaceRoot);
    },
    listWorkspaceRegistry: function listWorkspaceRegistry() {
      return workspaceRegistry.list();
    },
    removeWorkspaceRegistry: function removeWorkspaceRegistry(workspaceId: string) {
      return workspaceRegistry.remove(workspaceId);
    },
    showConfig: function showConfig(scope: AutopilotSettingsScope, workspaceRoot: string) {
      return settingsWriter.show(scope, workspaceRoot);
    },
    getConfig: function getConfig(scope: AutopilotSettingsScope, key: string, workspaceRoot: string) {
      return settingsWriter.get(scope, key, workspaceRoot);
    },
    setConfig: function setConfig(scope: AutopilotSettingsScope, key: string, value: string, workspaceRoot: string) {
      return settingsWriter.set(scope, key, value, workspaceRoot);
    },
    doctor: async function doctor(workspaceRoot: string, connectivity: boolean) {
      const checks: CliDoctorCheck[] = [{ name: "node", status: "PASS", detail: process.version }];
      const workspaceId = createNodeWorkspaceId(workspaceRoot);
      checks.push({ name: "workspace", status: "PASS", detail: `id=${workspaceId}` });
      // 沙箱能力检查不依赖 Trust；报告只含 backend 与 enforcement，不含路径或命令明细。
      try {
        const sandbox = await getSandboxPort(workspaceRoot).status();
        checks.push({ name: "sandbox", status: sandbox.enforcement === "full" ? "PASS" : "WARN", detail: `${sandbox.backend} enforcement=${sandbox.enforcement}` });
      } catch {
        checks.push({ name: "sandbox", status: "WARN", detail: "sandbox status unavailable" });
      }
      const trust = await trustPolicy.getTrustStatus(workspaceRoot);
      checks.push({ name: "trust", status: trust.status === "trusted" ? "PASS" : "WARN", detail: trust.status });
      const rootAccess = getExistingStateRootAccess();
      checks.push({ name: "state_root", status: rootAccess, detail: rootAccess === "WARN" ? "not initialized" : rootAccess === "PASS" ? "read/write" : "not accessible" });
      if (rootAccess === "PASS") {
        try {
          assertNodeStateSchema(stateRoot);
          const migration = getNodeStateSchemaDiagnostic(stateRoot);
          checks.push({ name: "state_schema", status: "PASS", detail: migration ? migration.code : "compatible" });
        } catch {
          checks.push({ name: "state_schema", status: "FAIL", detail: "schema invalid" });
        }
        const corruption = getNodeStateCorruptionDiagnostics(stateRoot);
        checks.push({ name: "durable_jsonl", status: corruption.length > 0 ? "WARN" : "PASS", detail: corruption.length > 0 ? `${corruption.length} corrupted record(s)` : "clean" });
      } else {
        checks.push({ name: "state_schema", status: "SKIP", detail: "state root unavailable" });
        checks.push({ name: "durable_jsonl", status: "SKIP", detail: "state root unavailable" });
      }
      if (trust.status !== "trusted") {
        checks.push({ name: "settings", status: "SKIP", detail: "workspace not trusted" });
        checks.push({ name: "web_search", status: "SKIP", detail: "workspace not trusted" });
        checks.push({ name: "skills", status: "SKIP", detail: "workspace not trusted" });
        checks.push({ name: "mcp", status: "SKIP", detail: "workspace not trusted" });
        checks.push({ name: "provider_connectivity", status: "SKIP", detail: "workspace not trusted" });
        checks.push({ name: "web_search_connectivity", status: "SKIP", detail: "workspace not trusted" });
        return checks;
      }
      const loaded = settingsLoader.load(workspaceRoot);
      const selectedProvider = getSelectedProviderSettings(loaded.settings);
      const hasCredential = Boolean(selectedProvider?.credentialRef);
      checks.push({ name: "settings", status: loaded.settings.diagnostics.length > 0 ? "WARN" : "PASS", detail: loaded.settings.diagnostics.length > 0 ? `${loaded.settings.diagnostics.length} diagnostic(s)` : "valid" });
      checks.push({ name: "model", status: loaded.settings.modelRef ? "PASS" : "WARN", detail: loaded.settings.modelRef ? "configured" : "not configured" });
      checks.push({ name: "credential", status: hasCredential ? "PASS" : "WARN", detail: hasCredential ? "configured" : "not configured" });
      const webSearchCredentialAvailable = await hasWebSearchCredential(loaded);
      checks.push({
        name: "web_search",
        status: !loaded.settings.webSearch ? "WARN" : webSearchCredentialAvailable ? "PASS" : "FAIL",
        detail: `${!loaded.settings.webSearch ? "not configured" : webSearchCredentialAvailable ? "configured" : "credential unavailable"}; ${WEB_SEARCH_DATA_FLOW_NOTICE}`,
      });
      try {
        const skills = nodeCapabilityLoader.loadSkills(workspaceRoot);
        checks.push({ name: "skills", status: "PASS", detail: `${skills?.catalog.length ?? 0} discovered` });
      } catch {
        checks.push({ name: "skills", status: "WARN", detail: "configuration unavailable" });
      }
      try {
        const mcp = nodeCapabilityLoader.loadMcp(workspaceRoot);
        checks.push({ name: "mcp", status: "PASS", detail: `${mcp?.servers.length ?? 0} configured` });
      } catch {
        checks.push({ name: "mcp", status: "WARN", detail: "configuration unavailable" });
      }
      checks.push(connectivity ? await checkConnectivity(workspaceRoot) : { name: "provider_connectivity", status: "SKIP", detail: "use --connectivity" });
      checks.push(!loaded.settings.webSearch
        ? { name: "web_search_connectivity", status: "SKIP", detail: "not configured" }
        : connectivity
          ? await checkWebSearchConnectivity(workspaceRoot, webSearchCredentialAvailable)
          : { name: "web_search_connectivity", status: "SKIP", detail: "use --connectivity" });
      return checks;
    },
    sandboxStatus: async function sandboxStatus(workspaceRoot: string) {
      return getSandboxPort(workspaceRoot).status();
    },
    sandboxSetup: async function sandboxSetup(workspaceRoot: string) {
      return getSandboxPort(workspaceRoot).setup();
    },
    createRuntime: async function createRuntime(workspaceRoot: string) {
      activateSettings(workspaceRoot);
      activeWorkspaceRoot = workspaceRoot;
      const runtime = await bootstrapService.createRuntime(workspaceRoot);
      workspaceRegistry.register(workspaceRoot);
      return runtime;
    },
    bootstrap: async function bootstrap() {
      const trusted = await bootstrapService.establishTrust();
      return bootstrapService.createRuntime(trusted.workspaceRoot);
    },
    getBootstrapService: function getBootstrapService() {
      return bootstrapService;
    },
    getRuntimeStatusDefaults: function getRuntimeStatusDefaults() {
      const modelRef = resolvedSettings?.modelRef;
      return {
        ...(modelRef ? { modelRef } : {}),
        ...(resolvedSettings?.reasoningProfile ? { reasoningProfile: resolvedSettings.reasoningProfile } : {}),
        modelCapabilities: getModelCapabilities(),
      };
    },
    getStartupConfigurationError,
    listSkills: async function listSkills() {
      if (!loadedSkills) throw new Error("CLI_SKILL_CAPABILITY_UNAVAILABLE");
      return loadedSkills.catalog.filter(function isUserInvocable(entry) {
        return entry.userInvocable !== false;
      }).map(function summarizeSkill(entry) {
        return {
          qualifiedName: entry.qualifiedName,
          displayName: entry.displayName ?? entry.name,
          description: entry.description,
        };
      }).sort(function sortByCanonicalName(left, right) { return left.qualifiedName.localeCompare(right.qualifiedName); });
    },
    resolveSkill: async function resolveSkill(skill: string) {
      if (!loadedSkills) throw new Error("CLI_SKILL_CAPABILITY_UNAVAILABLE");
      const matches = loadedSkills.catalog.filter(function matchSkill(entry) {
        return entry.qualifiedName === skill && entry.userInvocable !== false;
      });
      if (matches.length !== 1) throw new Error("CLI_SKILL_NOT_FOUND");
      const entry = matches[0];
      const loaded = await loadedSkills.loadSkill({ skill: entry.qualifiedName });
      if (loaded.skillId !== entry.skillId) throw new Error("CLI_SKILL_ID_MISMATCH");
      return { skillId: loaded.skillId, contentHash: loaded.contentHash };
    },
    listMcp: async function listMcp(workspaceRoot: string) {
      const store = createMcpApprovalStore(workspaceRoot);
      const capability = safeBaseCapabilityLoader.loadMcp ? await safeBaseCapabilityLoader.loadMcp(workspaceRoot) : undefined;
      return Promise.all((capability?.servers ?? []).filter(function enabled(server) { return server.enabled !== false; }).map(async function summarize(server) {
        const approved = await store.getPersistentGrant({ workspaceRoot, sessionId: "", toolName: "mcp_server_start", constraint: getMcpServerGrantConstraint(server) });
        const executionMode = server.execution === "host" ? "host" : "sandbox";
        return { serverName: server.name, program: server.command, args: server.args ?? [], cwd: server.cwd ?? ".", approved: Boolean(approved), executionMode, isolation: executionMode === "host" ? "unisolated" : "sandboxed" };
      }));
    },
    approveMcp: async function approveMcp(workspaceRoot: string, serverName: string) {
      const server = await findMcpServer(workspaceRoot, serverName);
      if (!server) throw new Error("MCP_SERVER_NOT_FOUND");
      await createMcpApprovalStore(workspaceRoot).savePersistentGrant({
        scope: "allow_workspace",
        workspaceRoot,
        toolName: "mcp_server_start",
        constraint: getMcpServerGrantConstraint(server),
        risk: "unknown",
        createdAt: new Date().toISOString(),
      });
      return { serverName: server.name };
    },
    revokeMcp: async function revokeMcp(workspaceRoot: string, serverName: string) {
      const server = await findMcpServer(workspaceRoot, serverName);
      if (!server) throw new Error("MCP_SERVER_NOT_FOUND");
      return createMcpApprovalStore(workspaceRoot).deletePersistentGrant({ workspaceRoot, sessionId: "", toolName: "mcp_server_start", constraint: getMcpServerGrantConstraint(server) });
    },
  };
}
