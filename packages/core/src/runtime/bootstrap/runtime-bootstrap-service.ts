/**
 * runtime/bootstrap/runtime-bootstrap-service.ts — Runtime 启动服务
 *
 * 将 Runtime 创建拆分为三个阶段：
 * 1. safeBootstrap：读取 SafeBootstrapConfig（不接触工作区可执行配置）。
 * 2. establishTrust：解析 workspaceRoot 并通过 WorkspaceTrustPolicy 确认信任。
 * 3. runtimeBootstrap：信任建立后，加载 Provider、MCP、Skill、Memory 等能力，最后装配 AgentRuntime。
 *
 * 参考 Claude Code 的 init.ts / setup.ts / main.tsx 分层思想，但只保留与本项目结构匹配的边界。
 */

import type { AgentRuntime } from "../public";
import type { CreateAgentRuntimeOptions } from "../public/create-agent-runtime";
import type { RuntimePorts } from "../ports";
import type { WorkspaceAdapter } from "../ports/workspace-adapter";
import type { RunConfig, McpCapability, WebCapability } from "../protocol";
import type { AgentContextSnapshot } from "../../internal/agent-context";
import type { AgentSkillsCapability } from "../../internal/tools/builtins/skill-tool";
import type { AgentInputInboxCapability } from "../../internal/agent-runtime";
import type { ModelSamplerFactory } from "../provider/model-sampler-factory";
import type { DatabaseSearchCapability } from "../../internal/database-search";
import type { SafeBootstrapConfig } from "./safe-bootstrap-config";
import type { WorkspaceTrustPolicy, WorkspaceTrustEntry } from "./workspace-trust-policy";
import { WorkspaceTrustError } from "./workspace-trust-policy";

/** 能力加载器；trust 建立后由 RuntimeBootstrapService 调用。 */
export interface CapabilityLoader {
  /** 加载 Provider 工厂；trust 后创建，避免提前读取环境凭据。Phase 3 起返回 ModelSamplerFactory。 */
  loadProvider?(workspaceRoot: string): Promise<ModelSamplerFactory> | ModelSamplerFactory;

  /** 加载 MCP 能力；trust 后读取工作区 .autopilot/mcp.json 等配置。 */
  loadMcp?(workspaceRoot: string): Promise<McpCapability | undefined> | McpCapability | undefined;

  /** 加载公开网络能力；只有 Trust 与用户级启用条件满足时才返回对应子能力。 */
  loadWeb?(workspaceRoot: string): Promise<WebCapability | undefined> | WebCapability | undefined;

  /** 加载独立只读数据库能力；Trust 前不得读取数据源配置。 */
  loadDatabaseSearch?(workspaceRoot: string): Promise<DatabaseSearchCapability | undefined> | DatabaseSearchCapability | undefined;

  /** 加载 Skill capability；会扫描工作区 .autopilot/skills。 */
  loadSkills?(workspaceRoot: string): Promise<AgentSkillsCapability | undefined> | AgentSkillsCapability | undefined;

  /** 加载冻结上下文（AGENTS.md / Memory）。 */
  loadContext?(workspaceRoot: string, query?: string): Promise<AgentContextSnapshot> | AgentContextSnapshot;

  /** 加载 durable inbox capability。 */
  loadInputInbox?(workspaceRoot: string): Promise<AgentInputInboxCapability> | AgentInputInboxCapability;
}

/** Bootstrap 阶段事件，供宿主观察启动进度。 */
export interface BootstrapEvent {
  phase: "safe" | "trust" | "runtime" | "ready" | "error";
  message: string;
  workspaceRoot?: string;
  trustEntry?: WorkspaceTrustEntry;
}

/** RuntimeBootstrapService 创建参数。 */
export interface CreateRuntimeBootstrapServiceOptions {
  /** 安全启动配置。 */
  config: SafeBootstrapConfig;

  /** WorkspaceAdapter：解析并返回 workspaceRoot。 */
  workspaceAdapter: WorkspaceAdapter;

  /** 信任策略；trust 建立前不加载能力。 */
  trustPolicy: WorkspaceTrustPolicy;

  /** 能力加载器；在 trust 之后按顺序调用。 */
  capabilityLoader?: CapabilityLoader;

  /** Runtime 所需的 Port 工厂；在 trust 之后创建。 */
  createPorts: (workspaceRoot: string) => RuntimePorts | Promise<RuntimePorts>;

  /** 默认 RunConfig。 */
  defaultRunConfig?: RunConfig;

  /** 仅具备结构化回答入口的宿主启用 AskUserQuestion；CLI 保持关闭。 */
  enableUserQuestions?: boolean;

  /** 事件观察者。 */
  onEvent?: (event: BootstrapEvent) => void;
}

/** RuntimeBootstrapService 接口。 */
export interface RuntimeBootstrapService {
  /** 执行完整 bootstrap 并返回装配好的 Runtime。 */
  bootstrap(): Promise<AgentRuntime>;

  /** 仅执行 safe 阶段。 */
  safeBootstrap(): Promise<SafeBootstrapConfig>;

  /** 执行 safe + trust 阶段，返回 workspaceRoot 与信任记录。 */
  establishTrust(): Promise<{ workspaceRoot: string; trustEntry: WorkspaceTrustEntry }>;

  /** 在 trust 已建立的前提下，创建 Runtime（可用于 headless 或测试）。 */
  createRuntime(workspaceRoot: string): Promise<AgentRuntime>;
}

/** 创建 RuntimeBootstrapService。 */
export function createRuntimeBootstrapService(
  options: CreateRuntimeBootstrapServiceOptions,
): RuntimeBootstrapService {
  const { config, workspaceAdapter, trustPolicy, capabilityLoader, createPorts, defaultRunConfig, enableUserQuestions = false, onEvent } = options;

  function emit(event: BootstrapEvent): void {
    onEvent?.(event);
  }

  async function safeBootstrap(): Promise<SafeBootstrapConfig> {
    emit({ phase: "safe", message: "读取安全启动配置" });
    return config;
  }

  async function establishTrust(): Promise<{ workspaceRoot: string; trustEntry: WorkspaceTrustEntry }> {
    const safeConfig = await safeBootstrap();
    emit({ phase: "trust", message: "解析工作区并确认信任" });

    const workspaceRoot = safeConfig.workspaceRoot ?? (await workspaceAdapter.resolveWorkspaceRoot());
    if (!workspaceRoot) {
      throw new WorkspaceTrustError("", "denied", "无法解析工作区根目录");
    }

    const canonicalRoot = await workspaceAdapter.canonicalizeWorkspaceRoot(workspaceRoot);
    const trustEntry = await trustPolicy.getTrustStatus(canonicalRoot);

    if (safeConfig.skipTrustCheck) {
      emit({ phase: "trust", message: "跳过信任检查（测试模式）", workspaceRoot: canonicalRoot, trustEntry });
      return { workspaceRoot: canonicalRoot, trustEntry };
    }

    if (trustEntry.status !== "trusted") {
      throw new WorkspaceTrustError(canonicalRoot, trustEntry.status, `工作区 ${canonicalRoot} 尚未获得信任（状态：${trustEntry.status}）`);
    }

    emit({ phase: "trust", message: "工作区已受信任", workspaceRoot: canonicalRoot, trustEntry });
    return { workspaceRoot: canonicalRoot, trustEntry };
  }

  async function createRuntime(workspaceRoot: string): Promise<AgentRuntime> {
    const trustEntry = await trustPolicy.getTrustStatus(workspaceRoot);
    if (!config.skipTrustCheck && trustEntry.status !== "trusted") {
      throw new WorkspaceTrustError(workspaceRoot, trustEntry.status, `工作区 ${workspaceRoot} 尚未获得信任（状态：${trustEntry.status}）`);
    }
    emit({ phase: "runtime", message: "加载 Runtime 依赖与能力", workspaceRoot });

    // trust 建立后才能加载 Provider / MCP / Skill / Context 等能力。
    const [ports, provider, mcp, web, databaseSearch, skills, context, inputInbox] = await Promise.all([
      Promise.resolve(createPorts(workspaceRoot)),
      capabilityLoader?.loadProvider ? Promise.resolve(capabilityLoader.loadProvider(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadMcp ? Promise.resolve(capabilityLoader.loadMcp(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadWeb ? Promise.resolve(capabilityLoader.loadWeb(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadDatabaseSearch ? Promise.resolve(capabilityLoader.loadDatabaseSearch(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadSkills ? Promise.resolve(capabilityLoader.loadSkills(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadContext ? Promise.resolve(capabilityLoader.loadContext(workspaceRoot)) : Promise.resolve(undefined),
      capabilityLoader?.loadInputInbox ? Promise.resolve(capabilityLoader.loadInputInbox(workspaceRoot)) : Promise.resolve(undefined),
    ]);

    const runtimeOptions: CreateAgentRuntimeOptions = {
      ports,
      enableUserQuestions,
      defaultRunConfig: {
        ...defaultRunConfig,
        workspaceRoot,
        workspaceTrusted: trustEntry.status === "trusted",
        // Phase 3: Provider 改为 ModelSamplerFactory；注入到 modelSamplerFactory 字段。
        // modelSampler 兼容字段保留，供未接入 Factory 的调用方兜底。
        modelSamplerFactory: provider ?? defaultRunConfig?.modelSamplerFactory,
        mcp: mcp ?? defaultRunConfig?.mcp,
        rag: undefined,
        web,
        webLoader: capabilityLoader?.loadWeb
          ? async function reloadTrustedWeb() {
              const currentTrust = await trustPolicy.getTrustStatus(workspaceRoot);
              if (!config.skipTrustCheck && currentTrust.status !== "trusted") {
                throw new WorkspaceTrustError(workspaceRoot, currentTrust.status, "工作区信任已失效");
              }
              return capabilityLoader.loadWeb!(workspaceRoot);
            }
          : defaultRunConfig?.webLoader,
        databaseSearch,
        skills,
        context,
        contextLoader: capabilityLoader?.loadContext
          ? async (query: string) => capabilityLoader.loadContext!(workspaceRoot, query)
          : undefined,
        inputInbox,
      },
    };

    const { createAgentRuntime } = await import("../public");
    const runtime = createAgentRuntime(runtimeOptions);
    emit({ phase: "ready", message: "Runtime 装配完成", workspaceRoot });
    return runtime;
  }

  async function bootstrap(): Promise<AgentRuntime> {
    const { workspaceRoot } = await establishTrust();
    return createRuntime(workspaceRoot);
  }

  return {
    bootstrap,
    safeBootstrap,
    establishTrust,
    createRuntime,
  };
}
