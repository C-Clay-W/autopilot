/**
 * composition-root.ts — Web 宿主 Composition Root
 *
 * 负责选择并装配 Web 所需的 Adapter 与 Runtime；只包含依赖选择和生命周期绑定，
 * 不实现 Agent 业务规则。参考 Claude Code main.tsx 的组合根思想，但保持最小化。
 */

import path from "node:path";
import type {
  AgentRuntimeFacade,
  AgentContextSnapshot,
  AgentMessage,
  CapabilityLoader,
  CreateRuntimeBootstrapServiceOptions,
  RunConfig,
  RuntimeBootstrapService,
  SafeBootstrapConfig,
  WorkspaceTrustPolicy,
} from "@autopilot-agent/core";
import {
  createNodeCapabilityLoader,
  createNodeRuntimePorts,
  createNodeSettingsLoader,
  createNodeTrustPolicy,
  createNodeWorkspaceAdapter,
  initializeNodeStateRoot,
  resolveNodeStateRoot,
} from "@autopilot-agent/adapters";
import type { SessionImageAttachment } from "@/lib/session-attachment-store";
import type { SessionPinnedSkill } from "@/lib/session-store";
import { createSettingsRunConfig } from "./settings/runtime-settings";
import { createWorkPreviewService, type WebWorkPreviewService } from "./workspace-host/work-preview-service";
import { extractWorkPreviewToolFacts } from "./workspace-host/work-preview-facts";
import { loadCore } from "./core-loader";
import { getWorkspaceRequestContext } from "./workspace-host/web-workspace-session";

/** 将已有通义凭据显式接为 Web 的可选视觉角色，未配置时绝不注册视觉工具。 */
function createDashScopeVisionFallback(): Partial<RunConfig> {
  const modelId = process.env.LLM_MODEL?.trim();
  if (!process.env.TONGYI_API_KEY || !modelId) return {};
  return {
    providerSettings: {
      vision: {
        apiProtocol: "openai-chat-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        credentialRef: { provider: "ali", key: "TONGYI_API_KEY" },
      },
      visionModelRef: { provider: "ali", modelId },
    },
  };
}

/** 合并宿主、可选 DashScope 及用户 settings 的 Runtime 默认值，后者只影响下一 Turn。 */
function mergeRuntimeDefaults(
  base: Partial<RunConfig>,
  fallback: Partial<RunConfig>,
  settings: Partial<RunConfig>,
): Partial<RunConfig> {
  const { providerSettings: baseProviderSettings, ...baseFields } = base;
  const { providerSettings: fallbackProviderSettings, ...fallbackFields } = fallback;
  const { providerSettings: settingsProviderSettings, ...settingsFields } = settings;
  const routes = {
    ...baseProviderSettings?.routes,
    ...fallbackProviderSettings?.routes,
    ...settingsProviderSettings?.routes,
  };
  const providerSettings = {
    ...baseProviderSettings,
    ...fallbackProviderSettings,
    ...settingsProviderSettings,
    ...(Object.keys(routes).length ? { routes } : {}),
  };
  return {
    ...baseFields,
    ...fallbackFields,
    ...settingsFields,
    ...(Object.keys(providerSettings).length ? { providerSettings } : {}),
  };
}

/** 浏览器提交的 canonical Skill 选择；正文和路径永远不由浏览器提供。 */
export interface WebSelectedSkillInput {
  skillRef: string;
  arguments?: string;
  pinned?: boolean;
}

/** Trust 后从受控 catalog 冻结的 Skill 结果。 */
export interface WebResolvedSelectedSkill extends WebSelectedSkillInput {
  skillId: string;
  contentHash: string;
  content: string;
}

/** Web Composition Root 创建选项。 */
export interface CreateWebCompositionRootOptions {
  /** 安全启动配置；未传时从环境变量构建。 */
  config?: SafeBootstrapConfig;

  /** 可选外部信任策略；未传时使用 Web 默认信任存储。 */
  trustPolicy?: WorkspaceTrustPolicy;

  /** 可选能力加载器；未传时使用 Web 默认实现。 */
  capabilityLoader?: CapabilityLoader;

  /** 默认 RunConfig。 */
  defaultRunConfig?: CreateRuntimeBootstrapServiceOptions["defaultRunConfig"];

  /** Web 与 CLI 可共享的 durable Runtime 状态根；未传时由共享 resolver 按 workspace identity 解析。 */
  stateRoot?: string;

  /** 信任记录根；未传时兼容 stateRoot 相邻的 `.local/agent` 布局。 */
  trustRoot?: string;

  /** Web Search 请求的 fake HTTP 测试 seam；生产默认使用平台原生 fetch。 */
  webSearchFetch?: typeof fetch;

}

/** Web 快路径入口；这些操作不创建完整 Runtime。 */
export interface WebFastPaths {
  /** 解析 canonical workspaceRoot。 */
  resolveWorkspaceRoot(): string;

  /** 检查当前工作区是否已受信任。 */
  isTrusted(workspaceRoot?: string): Promise<boolean>;
}

/** Web 宿主 Composition Root。 */
export interface WebCompositionRoot {
  /** 快路径能力。 */
  fastPaths: WebFastPaths;

  /** 完整 bootstrap 并返回 Runtime。 */
  bootstrap(): Promise<AgentRuntimeFacade>;

  /** 返回未启动的 RuntimeBootstrapService（用于分阶段测试）。 */
  getBootstrapService(): RuntimeBootstrapService;

  /** 当前 Workspace Context 的 Work 预览服务；工具能力与受限 Route 共用同一实例。 */
  workPreview: WebWorkPreviewService;

  /** Trust 后从 capability catalog 冻结本轮显式选择的 Skill。 */
  resolveSelectedSkills(selectedSkills: WebSelectedSkillInput[], pinnedSkills: SessionPinnedSkill[]): Promise<{
    skills: WebResolvedSelectedSkill[];
    pinnedSkills: SessionPinnedSkill[];
    diagnostics: string[];
  }>;

  /** Trust 后预检本轮 Context；项目指令超过硬上限时拒绝启动。 */
  prepareTurnContext(content: string): Promise<AgentContextSnapshot | undefined>;

  /** 将已验证的 Web 图片引用转换为给 Runtime 使用的附加上下文。 */
  createAttachmentInstruction(attachments: SessionImageAttachment[]): AgentMessage | undefined;

  /** 将用户显式选择的受控 Skill 正文转换为本轮附加上下文。 */
  createSelectedSkillsInstruction(skills: WebResolvedSelectedSkill[]): AgentMessage | undefined;


}

/** Work Route 只复用已选工作区的组合根，绝不从 cwd 创建默认任务。 */
export function getDefaultWebCompositionRoot(): WebCompositionRoot {
  const context = getWorkspaceRequestContext();
  if (!context) throw new (loadCore().AgentRuntimeError)("WORKSPACE_REQUIRED", "请先选择工作区");
  return context.compositionRoot;
}

/** 复用当前已通过 Registry/Trust 检查的 Runtime。 */
export async function getSharedWebRuntime(): Promise<AgentRuntimeFacade> {
  const context = getWorkspaceRequestContext();
  if (!context) throw new (loadCore().AgentRuntimeError)("WORKSPACE_REQUIRED", "请先选择工作区");
  return context.runtime;
}

/** 收集 Agent 自身监听端口的回环 authority；预览目标策略据此拒绝把管理 API/页面嵌入预览。 */
function previewAgentAuthorities(): string[] {
  const rawPort = process.env.PORT?.trim();
  const port = rawPort && /^\d+$/.test(rawPort) ? rawPort : "3000";
  return ["127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port];
}

/** 创建 Web Composition Root。 */
export function createWebCompositionRoot(
  options: CreateWebCompositionRootOptions = {},
): WebCompositionRoot {
  const requestContext = getWorkspaceRequestContext();
  if (requestContext) return requestContext.compositionRoot;
  const core = loadCore();
  const config = options.config ?? core.createSafeBootstrapConfig({ host: "web" });
  const workspaceRoot = config.workspaceRoot;
  if (!workspaceRoot) throw new core.AgentRuntimeError("WORKSPACE_REQUIRED", "Work 必须显式选择工作区");
  const stateRoot = resolveNodeStateRoot({ stateRoot: options.stateRoot, workspaceRoot });
  const workspaceAdapter = createNodeWorkspaceAdapter({ workspaceRoot: config.workspaceRoot });
  const trustPolicy = options.trustPolicy ?? createNodeTrustPolicy({ stateRoot, trustRoot: options.trustRoot });
  const settingsLoader = createNodeSettingsLoader();
  const nodeCapabilityLoader = createNodeCapabilityLoader({ stateRoot, settingsLoader, webSearchFetch: options.webSearchFetch });
  let trustedSettingsWorkspaceRoot: string | undefined;

  const defaultCapabilityLoader: CapabilityLoader = {
    ...nodeCapabilityLoader,

    loadProvider() {
      return core.createDefaultModelSamplerFactory();
    },

    loadDatabaseSearch() {
      try {
        const snapshot = core.createDatabaseSnapshot({ databaseName: core.getDefaultDatabaseSource().database, snapshotRoot: path.join(stateRoot, "database-snapshots") }).getReadCapability();
        return core.createDatabaseSearchCapability(snapshot);
      } catch {
        return undefined;
      }
    },
  };

  const capabilityLoader = options.capabilityLoader ?? defaultCapabilityLoader;
  // Work 内置预览：每 Workspace Context 单例；Job 与权威工具事实都延迟取自同一 Runtime，bootstrap 前不触达。
  let runtimeFacade: AgentRuntimeFacade | undefined;
  const workPreview = createWorkPreviewService({
    workspaceRoot,
    agentAuthorities: previewAgentAuthorities(),
    jobsOf: function scopedJobs(sessionId) {
      if (!runtimeFacade) throw new Error("预览服务尚未完成 bootstrap，无法访问后台任务");
      return runtimeFacade.jobs.forSession({ workspaceId: workspaceRoot, sessionId });
    },
    factsOf: async function sessionPreviewFacts(sessionId) {
      if (!runtimeFacade) throw new Error("预览服务尚未完成 bootstrap，无法读取会话事实");
      const state = await runtimeFacade.turns.getState({ sessionId });
      return extractWorkPreviewToolFacts(state.events);
    },
  });
  const capabilityLoaderWithPreview: CapabilityLoader = {
    ...capabilityLoader,
    loadWorkPreview() {
      return workPreview;
    },
  };
  const bootstrapOptions: CreateRuntimeBootstrapServiceOptions = {
    config,
    enableUserQuestions: true,
    workspaceAdapter,
    trustPolicy,
    capabilityLoader: capabilityLoaderWithPreview,
    createPorts: (trustedWorkspace) => {
      // 只有 trust 建立后才创建 manifest；不在未信任 workspace 的快路径写状态根。
      const loadedSettings = settingsLoader.load(trustedWorkspace);
      trustedSettingsWorkspaceRoot = trustedWorkspace;
      initializeNodeStateRoot(stateRoot);
      return createNodeRuntimePorts({ stateRoot, trustRoot: options.trustRoot, workspaceRoot: trustedWorkspace, userSettingsPath: loadedSettings.paths.user });
    },
    defaultRunConfig: {
      ...options.defaultRunConfig,
      getRuntimeDefaults: function getRuntimeDefaults(): Partial<RunConfig> {
        const staticDefaults: Partial<RunConfig> = { ...options.defaultRunConfig };
        delete staticDefaults.getRuntimeDefaults;
        const base = {
          ...staticDefaults,
          ...(options.defaultRunConfig?.getRuntimeDefaults?.() ?? {}),
        };
        if (!trustedSettingsWorkspaceRoot) return mergeRuntimeDefaults(base, createDashScopeVisionFallback(), {});
        const settings = settingsLoader.load(trustedSettingsWorkspaceRoot).settings;
        const fallback = base.providerSettings?.visionModelRef ? {} : createDashScopeVisionFallback();
        return mergeRuntimeDefaults(base, fallback, createSettingsRunConfig(settings));
      },
    },
  };

  const bootstrapService = core.createRuntimeBootstrapService(bootstrapOptions);
  let trustedWorkspaceRoot: string | undefined;

  /** 确认调用方已经经过 bootstrap，避免任何能力解析绕过 workspace Trust。 */
  function requireTrustedWorkspaceRoot(): string {
    if (!trustedWorkspaceRoot) throw new Error("Web capability 必须在 Runtime bootstrap 建立 Trust 后使用");
    return trustedWorkspaceRoot;
  }

  /** Trust 后解析显式选择与固定 Skill，冻结 identity，正文只来自受控 catalog。 */
  async function resolveSelectedSkills(selectedSkills: WebSelectedSkillInput[], pinnedSkills: SessionPinnedSkill[]) {
    const workspace = requireTrustedWorkspaceRoot();
    const capability = nodeCapabilityLoader.loadSkills(workspace);
    if (!capability && (selectedSkills.length || pinnedSkills.length)) throw new core.AgentRuntimeError("INVALID_INPUT", "当前工作区没有可用的 Skill catalog");
    const selectedByRef = new Map(selectedSkills.map((skill) => [skill.skillRef, skill]));
    const retainedPins = pinnedSkills.filter((skill) => selectedByRef.get(skill.skillRef)?.pinned !== false);
    const references = [...new Set([...retainedPins.map((skill) => skill.skillRef), ...selectedSkills.map((skill) => skill.skillRef)])];
    if (references.length > 5) throw new core.AgentRuntimeError("INVALID_INPUT", "本轮选择与固定 Skill 合计不能超过 5 个");
    const diagnostics: string[] = [];
    const skills: WebResolvedSelectedSkill[] = [];
    for (const skillRef of references) {
      const catalogSkill = capability?.catalog.find((item) => item.qualifiedName === skillRef);
      const persisted = retainedPins.find((item) => item.skillRef === skillRef);
      if (!catalogSkill) {
        if (persisted) {
          diagnostics.push(`Pinned Skill '${skillRef}' 已从工作区移除，本轮不会加载。`);
          continue;
        }
        throw new core.AgentRuntimeError("INVALID_INPUT", "未知或未启用的 Skill");
      }
      const loadedSkill = await capability!.loadSkill({ skill: skillRef });
      if (persisted && persisted.contentHash !== loadedSkill.contentHash) diagnostics.push(`Pinned Skill '${skillRef}' 已更新，本轮已加载新版指令。`);
      const selection = selectedByRef.get(skillRef);
      skills.push({ skillRef, arguments: selection?.arguments, pinned: selection?.pinned ?? Boolean(persisted), skillId: loadedSkill.skillId, contentHash: loadedSkill.contentHash, content: loadedSkill.content });
    }
    const nextPinned = retainedPins.filter((skill) => !selectedByRef.has(skill.skillRef));
    for (const skill of skills.filter((item) => item.pinned)) nextPinned.push({ skillRef: skill.skillRef, skillId: skill.skillId, contentHash: skill.contentHash, pinnedAt: Date.now() });
    return { skills, pinnedSkills: nextPinned, diagnostics };
  }

  /** 在 route 创建 Turn 前读取冻结 Context，保留项目指令超限的硬拒绝语义。 */
  async function prepareTurnContext(content: string): Promise<AgentContextSnapshot | undefined> {
    const workspace = requireTrustedWorkspaceRoot();
    if (!capabilityLoader.loadContext) return undefined;
    const context = await capabilityLoader.loadContext(workspace, content);
    assertWebContextWithinBudget(context);
    return context;
  }

  return {
    fastPaths: {
      resolveWorkspaceRoot: () => workspaceAdapter.resolveWorkspaceRoot() as string,
      isTrusted: async (workspaceRoot?: string) => {
        const candidate = workspaceRoot ?? workspaceAdapter.resolveWorkspaceRoot();
        const root = workspaceAdapter.canonicalizeWorkspaceRoot(candidate as string) as string;
        const entry = await trustPolicy.getTrustStatus(root);
        return entry.status === "trusted";
      },
    },

    bootstrap: async () => {
      const runtime = await bootstrapService.bootstrap();
      runtimeFacade = runtime;
      trustedWorkspaceRoot = await workspaceAdapter.canonicalizeWorkspaceRoot(await workspaceAdapter.resolveWorkspaceRoot());
      return runtime;
    },

    getBootstrapService: () => bootstrapService,

    workPreview,

    resolveSelectedSkills,

    prepareTurnContext,

    createAttachmentInstruction: (attachments) => {
      if (!attachments.length) return undefined;
      const paths = attachments.map((attachment) => `- ${attachment.name}: ${attachment.relativePath}`).join("\n");
      return { role: "system", content: [{ type: "text", text: `当前任务附有以下会话图片。仅在需要视觉理解时调用 vision_analyze，并且只能使用下列受控相对路径：\n${paths}` }] };
    },

    createSelectedSkillsInstruction: (skills) => {
      if (!skills.length) return undefined;
      const content = skills.map((skill) => `【用户显式选择 Skill：${skill.skillRef}】\n${skill.arguments ? `用户补充：${skill.arguments}\n` : ""}${skill.content}`).join("\n\n");
      return { role: "system", content: [{ type: "text", text: `以下 Skill 已由用户显式选择；本轮必须遵循其指令。Skill 的工具权限仍须遵循现有审批流程。\n\n${content}` }] };
    },

  };
}

/** 拒绝会超出单轮硬上限的项目指令，禁止把诊断误当作可继续执行的告警。 */
export function assertWebContextWithinBudget(context: AgentContextSnapshot): void {
  const overflow = context.budget.diagnostics.find((diagnostic) => diagnostic.startsWith("AGENTS.md 指令超过单轮预算"));
  if (overflow) throw new Error(overflow);
}
