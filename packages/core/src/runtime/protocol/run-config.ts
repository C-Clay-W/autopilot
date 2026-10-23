/**
 * runtime/protocol/run-config.ts — 运行配置与三层优先级解析
 *
 * RunConfig 是 Turn 级别的运行配置；可被 Project 默认值、Session 默认值或单次调用覆盖。
 * resolveRunConfig 是纯函数，按 Project → Session → Turn 三层优先级合并出 FrozenRunConfig。
 * Phase 3 起引入 modelRef / reasoningProfile / credentialRef 字段，与 SessionRunConfig 对齐。
 */

import type { ToolPermissionMode } from "../../internal/tools/types";
import type { RagCapability } from "../../internal/agent-runtime";
import type { AgentContextSnapshot } from "../../internal/agent-context";
import type { AgentSkillsCapability } from "../../internal/tools/builtins/skill-tool";
import type { AgentInputInboxCapability } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { ModelSamplerFactory } from "../provider/model-sampler-factory";
import type { McpCapability } from "./mcp-capability";
import type { WebCapability } from "./web-capability";
import type { WorkPreviewCapability } from "./work-preview-capability";
import type { SessionRunConfig } from "../domain/session-run-config";
import type { FrozenRunConfig } from "../domain/frozen-run-config";
import type { ModelRef } from "../domain/model-ref";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import type { CredentialRef } from "../domain";
import type { ApiProtocol, ProtocolProfile, ProviderRouteProfile } from "../provider/api-protocol";
import { resolveAgentRuntimeLimits, resolveAgentRuntimeSafetyLimits } from "../config/runtime-limits";
import { computeSandboxPolicyDigest, resolveSandboxMode, SANDBOX_POLICY_VERSION, type SandboxMode } from "../domain/sandbox-policy";
import type { DatabaseSearchCapability, DatabaseSearchPolicy, RagSourcePolicy } from "../../internal/database-search";
import type { RerankPolicy } from "../../internal/lib/rerank";

/** 运行时冻结前使用的通用 Provider 参数，不承载厂商专属 JSON schema。 */
export interface ProviderRuntimeSettings {
  /** 由受信 Host route catalog 显式解析的协议，不允许请求期猜测。 */
  apiProtocol?: ApiProtocol;
  /** 与 apiProtocol 一起冻结的封闭兼容 profile。 */
  protocolProfile?: ProtocolProfile;
  baseUrl?: string;
  credentialRef?: CredentialRef;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  /** CC settings 的自动压缩阈值；在新 Turn 开始时冻结。 */
  compactThresholdTokens?: number;
  /** CC settings 的 Provider 请求超时；在新 Turn 开始时冻结。 */
  timeoutMs?: number;
  /** CC settings 的子 Agent 模型选择；当前只冻结，不替换主 Agent。 */
  subagentModelId?: string;
  /** false 时不发送 thinking，但保留显式 effort。 */
  thinkingEnabled?: boolean;
}

/** 多 route 受信配置容器；浏览器 DTO 不得投影其字段。 */
export interface ProviderRuntimeRouteSettings {
  readonly routes?: Readonly<Record<string, ProviderRouteProfile>>;
}

/** 自动/Reactive compact 使用的共享策略；宿主只提供上下文预算。 */
export interface CompactPolicy {
  preserveRecentTurns: number;
  targetTokens: number;
}

/**
 * 一次 turn 的运行配置；可被 Session 默认值、Project 默认值或单次调用覆盖。
 * Phase 3 新增 modelRef / reasoningProfile / credentialRef 字段，与 SessionRunConfig 对齐。
 * modelSampler 保留为兼容字段，Step 7 起将由 modelSamplerFactory 替代。
 */
export interface RunConfig {
  /** 只提供工具名交集，不能声明产品模式或放宽 Session 权限。 */
  toolAllowlist?: readonly string[];
  /** 仅由 Runtime 宿主装配，Chat Turn override 不得替换此 loader。 */
  chatLoader?: (binding: import("./chat-capability").ChatCapabilityBinding) => Promise<import("./chat-capability").ChatCapability | undefined>;

  workspaceRoot?: string;
  /** 仅由宿主 bootstrap 注入的信任结论，不接受 Project/Session/Turn 配置覆盖。 */
  workspaceTrusted?: boolean;
  /** 模型引用；Phase 3 新增。 */
  modelRef?: ModelRef;
  /** 推理强度配置；Phase 3 新增，只定义类型不接入 sampler。 */
  reasoningProfile?: ReasoningProfile;
  /** 凭据引用；Phase 3 新增，真实 Key 不进入 Session、checkpoint 或事件。 */
  credentialRef?: CredentialRef;
  permissionMode?: ToolPermissionMode;
  /** @deprecated 仅兼容旧宿主类型；Runtime 会清除此能力，Chat 使用 chatLoader。 */
  rag?: RagCapability;
  /** Trust 后注入且只存在于进程内的公开网络能力，不进入 FrozenRunConfig。 */
  web?: WebCapability;
  /** 受信宿主在 start/continue 前重新解析 Web 配置；undefined 必须清除旧能力。 */
  webLoader?: () => Promise<WebCapability | undefined>;
  /** Trust 后由宿主 bootstrap 注入的 Work 预览能力；仅进程内存在，override 不可注入或替换。 */
  workPreview?: WorkPreviewCapability;
  /** 受信宿主在每个 Work Turn 开始前重新解析预览能力；undefined 必须清除旧能力。 */
  workPreviewLoader?: () => Promise<WorkPreviewCapability | undefined>;
  databaseSearch?: DatabaseSearchCapability;
  /** 仅控制 Work 当前 Turn 是否注册独立 database_search。 */
  databaseSearchPolicy?: DatabaseSearchPolicy;
  /** @deprecated 旧 Work 字段，仅兼容读取；新 Turn 不采用此来源。 */
  ragSourcePolicy?: RagSourcePolicy;
  /** @deprecated 旧 Work 字段；RAG 由 Chat 知识端口装配，Work 不采用此策略。 */
  rerankPolicy?: RerankPolicy;
  context?: AgentContextSnapshot;
  /** 每个新 Turn 按用户输入重新冻结 instructions/Memory 的共享能力。 */
  contextLoader?: (query: string) => Promise<AgentContextSnapshot> | AgentContextSnapshot;
  skills?: AgentSkillsCapability;
  inputInbox?: AgentInputInboxCapability;
  focusedPdfFileName?: string;
  maxSteps?: number;
  /** 单个安全可重试工具调用的最大重试次数；仅 Turn 开始时冻结。 */
  maxToolRetries?: number;
  /** 当前 Turn 的累计运行时长安全上限；仅 Turn 开始时冻结。 */
  maxDurationMs?: number;
  /** 当前 Turn 的累计 Provider token 安全上限；仅 Turn 开始时冻结。 */
  maxTotalTokens?: number;
  /** 测试/headless 场景可注入自定义模型采样器；生产宿主通常不传入。Phase 3 起由 modelSamplerFactory 替代，但保留兼容。 */
  modelSampler?: ModelSampler;
  /** 模型采样器工厂；Phase 3 新增。trust 后由 CapabilityLoader.loadProvider 返回。P0 才真正在 executeTurn 中消费。 */
  modelSamplerFactory?: ModelSamplerFactory;
  /** trust 后加载的 MCP 能力；Phase 2.5 只保存配置，不启动子进程。 */
  mcp?: McpCapability;
  /** Runtime 负责的上下文压缩策略；continue 时沿用 Turn 冻结值。 */
  compactPolicy?: CompactPolicy;
  /** 外部 settings 归一化后的通用 Provider 参数；仅在新 Turn 冻结为私有 execution snapshot。 */
  providerSettings?: ProviderRuntimeRouteSettings & { primary?: ProviderRuntimeSettings; vision?: ProviderRuntimeSettings; visionModelRef?: ModelRef };
  /** 宿主原子替换 settings 快照的读取点；仅在 start 时读取一次，continue 不读取。 */
  getRuntimeDefaults?: () => Partial<RunConfig>;
  /**
   * OS 沙箱模式（Talk-Plan0917 Stage 1）；仅 Runtime 宿主 bootstrap（runtimeDefault）可设置，
   * Project/Session/Turn 覆盖一律不生效，模型请求体不能放宽。缺省为 workspace-write。
   */
  sandboxMode?: SandboxMode;
  /** 宿主显式验证的受控临时目录；仅 runtimeDefault 可设置，缺失时不得回退环境 TEMP/TMP。 */
  sandboxTempRoot?: string;
}

/** resolveRunConfig 的输入参数。 */
export interface ResolveRunConfigInput {
  /** Project 级默认运行配置；优先级最低。 */
  projectDefault?: SessionRunConfig;
  /** Session 级默认运行配置；优先级高于 Project。 */
  sessionDefault?: SessionRunConfig;
  /** 单次 Turn 调用的覆盖配置；优先级最高。 */
  turnOverride?: Partial<RunConfig>;
  /** Runtime 级默认配置；提供 workspaceRoot 等运行时兜底值。 */
  runtimeDefault?: RunConfig;
}

/**
 * 按 Project → Session → Turn → Runtime 四层优先级合并出 FrozenRunConfig。
 * 每个字段独立解析：turnOverride > sessionDefault > projectDefault > runtimeDefault；maxSteps 全部缺省时保持 undefined。
 * runtimeDefault 提供 Runtime 级兜底值（如 defaultRunConfig 中的 permissionMode / 显式 maxSteps / workspaceRoot）。
 * 返回的 FrozenRunConfig 在 Turn 开始后不可变；continue 时强制使用此快照。
 */
export function resolveRunConfig(input: ResolveRunConfigInput): FrozenRunConfig {
  const { projectDefault, sessionDefault, turnOverride, runtimeDefault } = input;

  const modelRef = turnOverride?.modelRef ?? sessionDefault?.modelRef ?? projectDefault?.modelRef ?? runtimeDefault?.modelRef;
  const reasoningProfile = turnOverride?.reasoningProfile ?? sessionDefault?.reasoningProfile ?? projectDefault?.reasoningProfile ?? runtimeDefault?.reasoningProfile;
  const credentialRef = turnOverride?.credentialRef ?? sessionDefault?.credentialRef ?? projectDefault?.credentialRef ?? runtimeDefault?.credentialRef;
  const permissionMode = turnOverride?.permissionMode ?? sessionDefault?.permissionMode ?? projectDefault?.permissionMode ?? runtimeDefault?.permissionMode;
  const requestedMaxSteps = turnOverride?.maxSteps ?? sessionDefault?.maxSteps ?? projectDefault?.maxSteps ?? runtimeDefault?.maxSteps;
  const requestedMaxToolRetries = turnOverride?.maxToolRetries ?? sessionDefault?.maxToolRetries ?? projectDefault?.maxToolRetries ?? runtimeDefault?.maxToolRetries;
  const limits = resolveAgentRuntimeLimits({ maxSteps: requestedMaxSteps, maxToolRetries: requestedMaxToolRetries });
  const requestedMaxDurationMs = turnOverride?.maxDurationMs ?? sessionDefault?.maxDurationMs ?? projectDefault?.maxDurationMs ?? runtimeDefault?.maxDurationMs;
  const requestedMaxTotalTokens = turnOverride?.maxTotalTokens ?? sessionDefault?.maxTotalTokens ?? projectDefault?.maxTotalTokens ?? runtimeDefault?.maxTotalTokens;
  const safetyLimits = resolveAgentRuntimeSafetyLimits({ maxDurationMs: requestedMaxDurationMs, maxTotalTokens: requestedMaxTotalTokens });
  const workspaceRoot = turnOverride?.workspaceRoot ?? runtimeDefault?.workspaceRoot;
  const workspaceTrusted = runtimeDefault?.workspaceTrusted === true;
  const compactPolicy = turnOverride?.compactPolicy ?? runtimeDefault?.compactPolicy;
  const databaseSearchPolicy = { ...(turnOverride?.databaseSearchPolicy ?? runtimeDefault?.databaseSearchPolicy ?? { enabled: false }) };
  const ragSourcePolicy = turnOverride?.ragSourcePolicy ?? runtimeDefault?.ragSourcePolicy;
  const rerankPolicy = turnOverride?.rerankPolicy ?? runtimeDefault?.rerankPolicy;
  // 沙箱模式与受控 tempRoot 与 workspaceTrusted 同范式：只信宿主 runtimeDefault，
  // 不读取 Project/Session/Turn 覆盖；未知值 fail-closed 拒绝，缺省为 workspace-write。
  const sandboxMode = resolveSandboxMode(runtimeDefault?.sandboxMode ?? "workspace-write");
  const sandboxTempRoot = runtimeDefault?.sandboxTempRoot;

  return {
    modelRef,
    reasoningProfile,
    credentialRef,
    permissionMode,
    ...limits,
    ...safetyLimits,
    safetyBudgetVersion: 2,
    workspaceRoot,
    workspaceTrusted,
    // Work 预览能力开关只从受信宿主 runtimeDefault 计算；override 不可开启（Talk-Plan0908 §7.2）。
    workPreviewEnabled: runtimeDefault?.workPreview !== undefined,
    compactPolicy,
    databaseSearchPolicy,
    ragSourcePolicy: ragSourcePolicy ? { ...ragSourcePolicy } : undefined,
    rerankPolicy: rerankPolicy ? { ...rerankPolicy } : undefined,
    sandboxMode,
    ...(sandboxTempRoot !== undefined ? { sandboxTempRoot } : {}),
    sandboxPolicyDigest: computeSandboxPolicyDigest({ mode: sandboxMode, workspaceRoot, tempRoot: sandboxTempRoot }),
    sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
  };
}
