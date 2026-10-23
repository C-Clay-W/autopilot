/**
 * runtime/domain — Runtime 层领域模型
 *
 * 定义 Session、Project、Turn、ModelRef、ReasoningProfile 等跨端业务实体。
 * Phase 3 起逐步丰富字段，支持三层 RunConfig 优先级与 Turn 冻结语义。
 */

export type { ProductMode, ChatRetrievalMode, CapabilityCeiling } from "./product-mode";

export type { ModelRef, ReasoningEffort } from "./model-ref";
export type { ReasoningProfile } from "./reasoning-profile";
export type { SessionRunConfig } from "./session-run-config";
export type { FrozenRunConfig } from "./frozen-run-config";
export type { SandboxMode, SandboxEnforcement, SandboxPolicy, SandboxCapabilityReport, SandboxExecutionRequest, SandboxPreparedCommand, SandboxErrorCode, ManagedExecutionControl, ManagedExecutionChannel } from "./sandbox-policy";
export type { ExternalExecutionTarget, ExternalExecutionApproval, ExternalExecutionAuthorization, ExternalWriteCapability } from "./external-execution";
export { SANDBOX_ERROR_CODES, SANDBOX_POLICY_VERSION, isSandboxPolicyDenialCode, isSandboxAvailabilityFailureCode, resolveSandboxMode, computeSandboxPolicyDigest } from "./sandbox-policy";
export type { Turn, TurnStatus } from "./turn";
export { JOB_RECORD_VERSION } from "./job";
export { normalizeJobServiceUrl, jobServicePort, sameServiceOrigin } from "./job-service-url";
export type { Job, JobStatus, JobOwner, JobOwnerLiveness, JobControlState, JobExecutionFacts, JobLastControl, JobView, JobListView, JobReadView, JobOutputSnapshot, JobSafeOutputSnapshot, JobSafeOutputStreamSnapshot, JobSafeOutputStreamView, JobOutputView, JobSandboxSummary, StartJobInput, PollJobInput, JobPollResult } from "./job";
export type { FileMutation, FileMutationOperation, FileMutationStatus, PrepareFileMutationInput, UndoTransaction } from "./file-mutation";
export type { Project, CreateProjectInput } from "./project";
export { EXTERNAL_FILE_CONSTRAINT_PREFIX, isExternalFileConstraint, externalFileConstraintTarget, formatExternalFileRule, parseExternalPermissionRule, isValidExternalPermissionRule, externalRuleCoversRule } from "./external-permissions";
export type { ExternalFileOperation, ParsedExternalPermissionRule, ExternalFileApproval } from "./external-permissions";
export type {
  ApprovalDecision,
  PersistentGrant,
  SubmitApprovalInput,
  FindPersistentGrantInput,
} from "./approval";
export type {
  UserQuestionOption,
  UserQuestionItem,
  UserQuestionAnswerItem,
  UserQuestionRequest,
  UserQuestionAnswer,
  StoredUserQuestion,
} from "./user-question";
export type {
  TodoStatus,
  TodoItem,
  TodoCounts,
  TodoSnapshot,
  TodoWriteResult,
} from "./todo";
export type {
  InboxInput,
  InboxDelivery,
  InboxStatus,
  InboxBoundary,
  InboxAttachmentRef,
  InboxSkillRef,
  PostInboxInput,
  DrainInboxInput,
  ClaimNextInboxInput,
  ConsumeInboxInput,
  ListInboxInput,
} from "./input-inbox";

/** Session 持久化模式。 */
export type SessionPersistenceMode = "durable" | "ephemeral";
export type {
  SessionPresentation,
  SessionPresentationCompaction,
  SessionPresentationMessage,
  SessionPresentationPinnedSkill,
} from "./session-presentation";

/** Session 运行状态。 */
export type SessionStatus = "idle" | "running" | "waiting_approval" | "waiting_user_input" | "interrupted" | "failed" | "completed";

/** Session 实体。 */
export interface Session {
  /** 仅新建 Work 会话由 Core 写入，旧记录不能由 save 升级来源。 */
  readonly workContextVersion?: 1;
  id: string;
  /** 新建会话必写；仅旧持久化记录允许缺省并按 Work 读取。 */
  readonly productMode?: import("./product-mode").ProductMode;
  /** Chat 创建即冻结；空白草稿不是已持久化 Session。 */
  readonly chatRetrievalMode?: import("./product-mode").ChatRetrievalMode;
  projectId?: string;
  persistenceMode: SessionPersistenceMode;
  status: SessionStatus;
  activeTurnId?: string;
  title?: string;
  /** Session 级默认运行配置；优先级高于 Project 默认值，低于 Turn 覆盖。 */
  defaultRunConfig?: import("./session-run-config").SessionRunConfig;
  /** 宿主展示投影；与 Core Session 同库持久化，不是独立会话状态源。 */
  presentation?: import("./session-presentation").SessionPresentation;
  createdAt: number;
  updatedAt: number;
  /** 持久化 schema 版本；Phase 3 起为 1。 */
  schemaVersion?: number;
}

/** 凭据引用；真实 Key 不进入 Session、checkpoint 或事件。 */
export interface CredentialRef {
  provider: string;
  key: string;
}

/** 解析后的短生命周期凭据。 */
export interface ResolvedCredential {
  apiKey: string;
  expiresAt?: number;
}
