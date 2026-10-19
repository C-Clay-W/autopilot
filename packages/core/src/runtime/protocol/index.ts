/**
 * runtime/protocol — Runtime 层公共协议
 *
 * 定义宿主（Web / CLI / Desktop）与 Core Runtime 之间的命令、事件、错误码和运行配置。
 * 本层不依赖任何 UI 框架或具体持久化实现。
 *
 * Phase 3 起 RunConfig / AgentEventEnvelope / AgentErrorCode 拆分到独立文件，
 * 便于单独测试与引用。
 */

import type { AgentMessage } from "../../internal/types/agent-message";
import type { AgentCheckpoint } from "../../internal/agent-runtime";
import type { RunConfig } from "./run-config";

// 抽离模块的 re-export
export type { RunConfig, ResolveRunConfigInput, CompactPolicy, ProviderRuntimeSettings, ProviderRuntimeRouteSettings } from "./run-config";
export { resolveRunConfig } from "./run-config";
export { AGENT_RUNTIME_LIMIT_DEFAULTS, AGENT_RUNTIME_LIMIT_HARD_LIMITS, AGENT_RUNTIME_SAFETY_DEFAULTS, AGENT_RUNTIME_SAFETY_HARD_LIMITS, resolveAgentRuntimeLimits, resolveAgentRuntimeSafetyLimits, resolveLimitConfig } from "../config/runtime-limits";
export type { AgentRuntimeSafetyLimits, LimitConfig, ResolvedAgentRuntimeLimits } from "../config/runtime-limits";
export type { AgentErrorCode } from "./error-code";
export { AgentRuntimeError } from "./error-code";
export type { AgentEvent, AgentEventEnvelope, CreateEventEnvelopeInput, PublicCheckpointView } from "./event-envelope";
export { createEventEnvelope } from "./event-envelope";
export type { McpCapability, McpServerConfig } from "./mcp-capability";
export { parseMcpConfig, getMcpServerConfigHash, getMcpServerGrantConstraint } from "./mcp-capability";
export { WebFetchCapabilityError, WebSearchCapabilityError } from "./web-capability";
export type { WebCapability, WebFetchCapability, WebFetchCapabilityErrorCode, WebFetchResult, WebSearchCapability, WebSearchCapabilityErrorCode, WebSearchResult, WebSearchSource } from "./web-capability";
export type { CompactTurnInput, CompactTurnResult } from "./compact-turn-input";
export type { AgentTerminationBudget, AgentTerminationReason, AgentTerminationView, RecoverableTurnStatus, RecoverableApprovalView, RecoverableTurnView } from "./recoverable-turn-view";
export { sanitizeAgentTerminationView } from "./recoverable-turn-view";
export type { FrozenRunConfigView } from "./frozen-run-config-view";
export { sanitizeCheckpoint, sanitizeEventForExternal } from "./sanitize-checkpoint";
export { sanitizeAgentMessagesForExternal } from "./sanitize-checkpoint";
export { migrateAgentMessages } from "./migrate-agent-messages";
export type { AgentMessageMigrationFailure, AgentMessageMigrationResult, AgentMessageMigrationSuccess } from "./migrate-agent-messages";
export type { AgentContentBlock, AgentJsonObject, AgentMessage, AgentMessageRole, AgentToolPairingScan } from "../../internal/types/agent-message";
export { CanonicalMessageError, isAgentToolPairingBalancedAt, isAgentToolPairingBalancedBefore, normalizeAgentMessages, scanAgentToolPairing, validateAgentMessages } from "../../internal/types/agent-message";
export type { AutopilotSettingsScope, AutopilotSettingsSource, RagConnectionRole, ResolvedAutopilotSettings, ResolvedFirstPartySettings, ResolvedRagConnectionSettings, ResolvedRagSettings, ResolvedSandboxSettings, ResolvedWebSearchSettings, SettingsDiagnostic } from "../config/autopilot-settings";
export type { ApiProtocol, ProtocolProfile, ProviderRouteProfile, AnthropicMessagesProtocolProfile, OpenAiChatCompletionsProtocolProfile } from "../provider/api-protocol";
export { isApiProtocol, isProtocolProfileForApiProtocol } from "../provider/api-protocol";
export { normalizeProviderBaseUrl, resolveAutopilotSettings } from "../config/autopilot-settings";

/** 启动新 turn 的输入。 */
export interface StartTurnInput {
  sessionId: string;
  /** 若调用方需要指定 turn ID（例如 Web 宿主已写入旧 session-store），可传入；否则 Runtime 自动生成。 */
  turnId?: string;
  /** 若提供 content，Runtime 会自动构造一条 user message。 */
  content?: string;
  /** 若调用方需要更复杂的初始 messages，可直接传入。 */
  messages?: AgentMessage[];
  /** 宿主已解析的首轮 Skill 身份；只保存 ID/hash，不携带 Skill 正文。 */
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  /** 声明本 Turn 从 claimed queue 连续启动；Core 将注入最近 Todo 快照，普通新 Turn 不设置。 */
  continuity?: { source: "claimed_queue" };
  runConfig?: Partial<RunConfig>;
  signal?: AbortSignal;
}

/** 继续运行已有 turn 的输入。runConfig 在 Phase 3 起被忽略，强制使用 Turn 冻结快照。 */
export interface ContinueTurnInput {
  sessionId: string;
  turnId: string;
  /** Phase 3 起此字段被忽略；continue 强制使用 TurnStore 中的 FrozenRunConfig。 */
  runConfig?: Partial<RunConfig>;
  /** 若本次 continue 携带审批决定，则注入 Kernel。 */
  approval?: { approvalId: string; decision: "allow" | "deny" };
  /** 从等待用户回答状态恢复时，指定已由 runtime.questions.submit() 持久化的请求。 */
  requestId?: string;
  signal?: AbortSignal;
}

/** 取消当前 turn 的输入。 */
export interface CancelTurnInput {
  sessionId: string;
  turnId: string;
}

/** 向运行中 turn 注入 steer 输入。 */
export interface SteerTurnInput {
  sessionId: string;
  turnId: string;
  content: string;
  /** 显式指定投递语义；未提供时保留 `/queue` 前缀兼容行为。 */
  delivery?: import("../domain/input-inbox").InboxDelivery;
  /** 宿主生成的幂等键。 */
  clientMessageId?: string;
  /** 附件引用；可选。 */
  attachments?: import("../domain/input-inbox").InboxAttachmentRef[];
  /** 已选择的 Skill 引用；可选。 */
  selectedSkills?: import("../domain/input-inbox").InboxSkillRef[];
}

// 复用内部既有类型作为稳定 DTO 公开，Phase 2 不新增序列化字段。
// AgentCheckpoint 保留给 CheckpointStore 等实现端口（签名需要完整 checkpoint）；宿主 UI/投影应使用 PublicCheckpointView。
export type { AgentCheckpoint };
