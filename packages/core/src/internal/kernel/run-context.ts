/**
 * Kernel 单次运行上下文：包含执行闭环所需的全部状态与依赖端口。
 * 调用方（如 createAgentRuntime facade）负责预组合 system messages、构造 ToolRegistry、注入 ModelSampler。
 */

import type { AgentMessage } from "../types/agent-message";
import type { AgentCheckpoint, AgentInputInboxCapability, AgentInjectedInput } from "../agent-runtime";
import type { AgentContextSnapshot } from "../agent-context";
import type { AgentSkillsCapability } from "../tools/builtins/skill-tool";
import type { ToolApprovalDecision, ToolEvent, ToolPermissionMode, ToolRisk } from "../tools/types";
import type { ToolRegistry } from "../tools/tool-registry";
import type { ModelSampler } from "./model-sampler";
import type { ModelSampleOptions } from "../types";
import type { CompletionPolicy } from "./completion-policy";
import type { AgentCompactionResult } from "../agent-runtime";
import type { AgentModelToolDefinition } from "../lib/llm";
import type { VisionAnalyzer } from "../../runtime/provider/vision-analyzer";
import type { FileMutationStore } from "../../runtime/ports";
import type { ContextUsageContribution } from "./context-budget";

/** Kernel 在安全点生成 ContextUsageView 所需的冻结窗口配置；与 auto compact 共用同一派生。 */
export interface ContextUsageProjectionConfig {
  /** 当前 Turn 冻结模型的安全展示引用；不得包含 endpoint 或 credential。 */
  modelRef: string;
  /** 当前 Turn 冻结模型的完整 context window。 */
  contextWindowTokens: number;
  /** 当前冻结 sampleOptions 为下一次输出保留的 token。 */
  outputReserveTokens: number;
  /** 与 auto compact 完全一致的 compact 触发阈值。 */
  compactTriggerTokens: number;
}

/** Kernel 在 before_sample 安全边界调用的上下文压缩管理器；Provider 配置与持久化仍归应用层所有。 */
export interface ContextCompactionManager {
  /** 根据当前投影、可信 usage anchor 与可见 tools 判断是否需要 auto compact。 */
  shouldCompact(input: {
    messages: AgentMessage[];
    usageAnchor: AgentCheckpoint["usageAnchor"];
    tools: AgentModelToolDefinition[];
  }): boolean;
  /** 复用应用层统一 compact 引擎；返回新投影或抛出稳定失败。 */
  compact(input: { messages: AgentMessage[]; signal: AbortSignal }): Promise<AgentCompactionResult>;
}

/** 工具权限上下文：模式、持久授权查询、审批校验。 */
export interface PermissionContext {
  externalExecutionAuthority?: import("../tools/types").ExternalExecutionAuthority;
  mode: ToolPermissionMode;
  /** 由宿主 bootstrap 注入的工作区信任结论；缺省按未信任处理。 */
  workspaceTrusted?: boolean;
  /** 查询已持久化的工具授权（allow_session / allow_workspace）。 */
  resolvePersistentGrant?: (request: { toolName: string; inputHash: string; input: unknown; constraint?: string; risk?: ToolRisk }) => Promise<boolean>;
  /** 校验审批决定的合法性。 */
  validateApproval?: (request: { approvalId: string; decision: ToolApprovalDecision; callId: string; toolName: string; inputHash: string; constraint?: string }) => Promise<boolean>;
  /** Talk-Plan1013 Stage5 R5：当前外部限制判定（allow/ask/deny）；唯一来源为 ApprovalService + projector 快照。 */
  resolveExternalRestriction?: (request: { workspaceRoot: string; toolName: string; constraint: string }) => Promise<"allow" | "ask" | "deny">;
}

/**
 * Kernel 运行上下文。
 * 注意：messages 进入 Kernel 前应由调用方完成 environment context、instruction、memory、skill catalog 等 system message 组合；
 * Kernel 内部不再读取 AGENTS.md、Memory 或 Skill 文件。
 */
export interface RunContext {
  hostMutationProtection?: import("../../runtime/ports/host-mutation-protection").HostMutationProtection;
  capabilityCeiling?: import("../../runtime/domain/product-mode").CapabilityCeiling;
  chat?: import("../tools/chat-tool-runtime").ChatToolRuntime;
  /** Session Runtime 分配的稳定 turn ID。 */
  turnId: string;
  /** 当前 Todo 任务链身份；普通新 Turn 创建新链，claimed queue 沿用上一链。 */
  todoChainId?: string;
  /** 当前上下文消息；首次运行已包含调用方组合好的 system messages。 */
  messages: AgentMessage[];
  /** 恢复时的可序列化状态；缺失表示新 turn。 */
  checkpoint?: AgentCheckpoint;
  /** 新 Turn 从上一 Turn 私有 checkpoint 继承的真实 usage anchor；仅当本 Turn 无 checkpoint 时生效。 */
  inheritedUsageAnchor?: AgentCheckpoint["usageAnchor"];
  /** 模型可见工具注册表，由调用方构造并注入。 */
  toolRegistry: ToolRegistry;
  /** 工具权限上下文。 */
  permissionContext: PermissionContext;
  /** 模型采样器端口；调用方可注入 mock 或自定义实现。 */
  modelSampler: ModelSampler;
  /** 当前模型绑定的完成策略；未注入时由 Kernel 使用默认写后验证策略。 */
  completionPolicy?: CompletionPolicy;
  /** 每次采样前的上下文管理器；未注入或无已知窗口时不触发 auto compact。 */
  contextCompaction?: ContextCompactionManager;
  /** 应用层冻结的 durable inbox；Kernel 只在安全边界 drain steer。 */
  inputInbox?: AgentInputInboxCapability;
  /** 应用层发现且校验后的 Skill capability。 */
  skills?: AgentSkillsCapability;
  /** 应用层冻结的指令和 Memory；仅用于 checkpoint 摘要，不读取文件。 */
  contextSnapshot?: AgentContextSnapshot;
  /** 文件与命令工具的 canonical 硬边界。 */
  workspaceRoot?: string;
  /** 首轮由宿主解析的受控 Skill ID/hash；后续 checkpoint 必须原样持久化。 */
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  /** 当前 Turn 已冻结的视觉调用能力；工具注册与执行共用此实例。 */
  visionAnalyzer?: VisionAnalyzer;
  /** 工具审计事件回调。 */
  onToolEvent?: (event: ToolEvent) => void;
  /** 当前 Turn 冻结的沙箱绑定（Talk-Plan0917 Stage 3）；Work 模式注入，run_command 经此隔离执行。 */
  sandbox?: import("../tools/types").SandboxExecutionBinding;
  /** Stage 15 私有 mutation store，由 Runtime 应用层绑定当前 Session/Turn。 */
  fileMutationStore?: FileMutationStore;
  sessionId?: string;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
  /** 本次运行允许的最大步数；缺省不启用总 step 闸门，显式值由统一限制层解析。 */
  maxSteps?: number;
  /** 当前输入是否已在 facade/Runtime 边界解析；Kernel 不得再次读取环境变量。 */
  runtimeLimitsResolved?: boolean;
  /** 当前 Turn 的累计运行时长安全上限；由冻结配置传入。 */
  maxDurationMs?: number;
  /** 当前 Turn 的累计 Provider token 安全上限；由冻结配置传入。 */
  maxTotalTokens?: number;
  /** 宿主时钟；测试与 durable Runtime 使用同一时间来源。 */
  clock?: () => number;
  /** 单个安全可重试工具调用的最大重试次数；缺省由统一限制层解析。 */
  maxToolRetries?: number;
  /** 已由 Provider resolver 解析的协议层采样选项（model/thinking/reasoningEffort）；Kernel 只透传，不猜 Provider。 */
  modelSampleOptions?: ModelSampleOptions;
  /** 从 awaitng_approval 恢复时传入的审批决定。 */
  approval?: { approvalId: string; decision: ToolApprovalDecision };
  /** 从 awaitng_user_input 恢复时注入的可信答案；不得由 Browser 直接构造。 */
  userQuestion?: { requestId: string; answer: import("../../runtime/domain").UserQuestionAnswer };
  /** 完整工具批次结束后的 durable checkpoint 回调；不得在工具执行中间调用。 */
  onSafeToolBatch?: (checkpoint: AgentCheckpoint) => Promise<void> | void;
  /** 当前 Turn 冻结窗口的 Context Usage 投影配置；未注入时 Kernel 不生成展示快照。 */
  contextUsageProjection?: ContextUsageProjectionConfig;
  /** 新 Turn 由 facade 在请求组装时生成的分类贡献账本，与 messages 一一对应；恢复 Turn 缺省。 */
  initialContextContributions?: ContextUsageContribution[][];
}

/** 重新导出应用层已校验输入类型，方便 Kernel 与 facade 共享签名。 */
export type { AgentInjectedInput };
