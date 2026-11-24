/**
 * CLI 宿主层的本地协议类型。
 *
 * 这些类型只描述 argv、slash action、事件投影和输出格式，不能替代 Core
 * Runtime 的领域类型，也不携带审批冻结凭证或完整 checkpoint。
 */

import type { AgentEvent, AgentRuntime, AgentTerminationView, ApprovalDisplayFacts, ContextUsageView, JobListView, JobReadView, JobView, RecoverableTurnView, TodoCounts, TodoItem, ToolDisplayFacts, TurnUsageSummaryView } from "@autopilot-agent/core";
import type { AgentPresentationState } from "@autopilot-agent/presentation";

/** CLI 当前支持的 Session 工具权限模式；与 Core 的公共枚举保持同值域。 */
export type CliPermissionMode = "ask" | "auto_approve" | "full_access";

/** CLI 输出模式；interactive 在 Step 5.4 才接入 Ink。 */
export type CliOutputFormat = "interactive" | "text" | "jsonl";

/** 协作投递模式；与 Core 冻结的三种模式同值域，必须显式声明。 */
export type CliThreadMode = "notify" | "run" | "steer";

/**
 * 协作命令语法树。
 *
 * 只保存不透明身份、模式与正文来源；正文、交接文档和共享板值在宿主边界读取，
 * 组归属、幂等、容量和交付事实都由 Core 判定。
 */
export type CliThreadCommand =
  | { type: "bind_host"; groupId: string; threadId: string; expectedRevision: number; executionHost: "cli-work-v1" | "web-work-v1" }
  | { type: "group_of"; threadId: string }
  | { type: "group_enable"; requestId: string; rootThreadId: string }
  | { type: "group_disable"; requestId: string; groupId: string }
  | { type: "create"; requestId: string; groupId: string; parentThreadId: string; title?: string; roleLabel?: string; modelRef?: { provider: string; modelId: string }; reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" }
  | { type: "associate"; groupId: string; threadId: string; requestId: string }
  | { type: "list"; groupId: string; cursor?: string; limit?: number }
  | { type: "read"; groupId: string; threadId: string; cursor?: string; limit?: number }
  | { type: "send"; requestId: string; groupId: string; threadId: string; mode: CliThreadMode; contentSource: { kind: "file"; path: string } | { kind: "stdin" }; replyTo?: string; expectedTurnId?: string; handoff?: { title: string; markdownFile: string } }
  | { type: "wait"; groupId: string; targets: Array<{ threadId: string; taskId?: string; cursor?: string }>; timeoutMs: number }
  | { type: "state_read"; groupId: string }
  | { type: "state_set"; requestId: string; groupId: string; expectedRevision: number; key: string; value: { kind: "inline"; json: string } | { kind: "file"; path: string } }
  | { type: "state_remove"; requestId: string; groupId: string; expectedRevision: number; key: string }
  | { type: "interrupt"; requestId: string; groupId: string; threadId: string; expectedTurnId: string }
  | { type: "watch"; groupId: string; cursor?: string; limit?: number };

/** CLI 命令语法树；命令本身不包含宿主状态根或 Runtime 实例。 */
export type CliCommand =
  | { type: "browser"; operation: import("@autopilot-agent/core").BrowserOperation; permit?: string }
  | { type: "project_open"; path?: string }
  | { type: "project_list" }
  | { type: "project_current" }
  | { type: "project_remove"; workspaceId: string }
  | { type: "trust_status" }
  | { type: "trust_revoke" }
  | { type: "session_list" }
  | { type: "session_rename"; sessionId: string; title: string }
  | { type: "session_delete"; sessionId: string; yes: boolean }
  | { type: "config_show"; scope: "user" | "project" | "local" }
  | { type: "config_get"; scope: "user" | "project" | "local"; key: string }
  | { type: "config_set"; scope: "user" | "project" | "local"; key: string; value: string }
  | { type: "mcp_list" }
  | { type: "mcp_approve"; serverName: string; yes: boolean }
  | { type: "mcp_revoke"; serverName: string }
  | { type: "job_list" }
  | { type: "job_show"; jobId: string }
  | { type: "job_output"; jobId: string }
  | { type: "job_kill"; jobId: string }
  | { type: "undo"; sessionId: string; yes: boolean }
  | { type: "doctor"; connectivity: boolean }
  | { type: "sandbox_status" }
  | { type: "sandbox_setup"; yes: boolean }
  | { type: "thread"; command: CliThreadCommand }
  | { type: "chat"; prompt?: string; sessionId?: string; output: CliOutputFormat }
  | { type: "resume"; sessionId?: string; output: CliOutputFormat };

/** CLI Action；审批 Action 只携带宿主决定，不携带冻结调用字段。 */
export type CliAction =
  /** delivery 只在已有活动 Turn 时生效；省略时与 Web 一致，默认 steer。 */
  | { type: "submit_prompt"; content: string; delivery?: "steer" | "queue"; images?: Array<{ name: string; mimeType: string; bytes: Uint8Array }> }
  | { type: "approve"; expected?: { sessionId: string; turnId: string; approvalId: string }; decision: "allow_once" | "allow_session" | "allow_workspace" | "deny" }
  | { type: "compact" }
  | { type: "show_context"; all: boolean }
  | { type: "select_skill"; skill: string }
  | { type: "toggle_skill"; skill: string }
  | { type: "list_skills" }
  | { type: "open_permissions" }
  | { type: "set_permission_mode"; mode: CliPermissionMode }
  /** 查看当前 Session/Workspace 可见的持久授权（Talk-Plan1013 Stage 4）。 */
  | { type: "list_permission_grants" }
  /** 按 toolName+constraint 精确撤销一条持久授权；constraint 由用户从列表复制，不做模糊匹配。 */
  | { type: "revoke_permission_grant"; constraint: string }
  | { type: "open_model_picker" }
  | { type: "set_model"; provider?: string; modelId: string }
  | { type: "open_effort_picker" }
  | { type: "set_effort"; effort: string }
  | { type: "list_jobs" }
  | { type: "show_job"; jobId: string }
  | { type: "read_job_output"; jobId: string }
  | { type: "stop_job"; jobId: string }
  | { type: "resume" }
  | { type: "cancel_turn" }
  | { type: "undo_preview" }
  | { type: "undo_confirm" }
  | { type: "exit" };

/** argv 中属于 Composition Root 的宿主配置；不进入 Core 领域输入。 */
export interface CliHostOptions {
  stateRoot?: string;
  trustRoot?: string;
  workspaceRoot?: string;
}

/** parser 的完整结果；host 配置与命令树分开，避免把状态根当作 prompt。 */
export interface CliInvocation {
  command: CliCommand;
  host: CliHostOptions;
}

/** argv parser 的确定性结果。 */
export type CliParseResult =
  | { kind: "help"; text: string }
  | { kind: "command"; invocation: CliInvocation }
  | { kind: "error"; message: string };

/** slash action parser 的确定性结果。 */
export type CliActionParseResult =
  | { kind: "action"; action: CliAction }
  | { kind: "error"; message: string };

/** 交互 TTY 中用于 slash 补全的安全命令摘要。 */
export interface CliSlashCommand {
  name: string;
  usage: string;
  description: string;
}

/** CLI 固定退出码。 */
export type CliExitCode = 0 | 1 | 2 | 130 | 143;

/** Controller 在宿主边界创建的本地事件信封。 */
export interface CliEventEnvelope {
  seq: number;
  sessionId?: string;
  turnId: string;
  timestamp: string;
  event: AgentEvent;
}

/** Controller 使用的最小 Core Runtime 依赖；不包含 Web 或 Core private 类型。inbox 用于 Turn 终态后领取遗留排队输入。 */
export type CliRuntime = Pick<AgentRuntime, "turns" | "projects" | "sessions" | "approvals" | "inbox" | "jobs" | "undo"> & Partial<Pick<AgentRuntime, "questions">>;

/** TUI/Plain 共用的当前 Session Job 安全视图；不携带命令、路径、PID 或 owner。 */
export type CliJobView =
  | { mode: "list"; list: JobListView }
  | { mode: "detail"; job: JobView; output?: JobReadView["output"] };

/** CLI Controller 可注入的宿主 Skill 解析器；只返回身份和内容哈希。 */
export type CliSkillResolver = (skill: string) => Promise<{ skillId: string; contentHash: string }>;

/** CLI 可展示的 Skill 安全摘要；正文和 allowedTools 不进入宿主视图。 */
export interface CliSkillSummary {
  qualifiedName: string;
  displayName: string;
  description: string;
  selected?: boolean;
}

/** CLI 权限 picker 的安全展示项；不携带工具调用或审批凭证。 */
export interface CliPermissionOption {
  mode: CliPermissionMode;
  label: string;
  description: string;
  selected: boolean;
}

/** CLI 模型 picker 的安全展示项；由已解析的 CC settings allowlist 生成。 */
export interface CliModelOption {
  provider: string;
  modelId: string;
  selected: boolean;
}

/** CLI 推理强度 picker 的安全展示项；只包含可向 firstParty 端点明确请求的 CC 值。 */
export interface CliEffortOption {
  effort: string;
  selected: boolean;
}

/** CLI 状态栏使用的脱敏 Session/Turn 配置视图。 */
export interface CliStatusView {
  model: string;
  effort: string;
  permissionMode: CliPermissionMode;
  workspaceRoot?: string;
  source: "runtime_default" | "session_default" | "turn_frozen";
  /** 当前执行段权限与人类已保存选择不同时，提示下次安全恢复或新回合值。 */
  nextPermissionMode?: CliPermissionMode;
  /** 活动 Turn 存在时显示已保存、但尚未冻结到当前 Turn 的下一轮模型。 */
  nextModel?: string;
  /** 活动 Turn 存在时显示已保存、但尚未冻结到当前 Turn 的下一轮推理强度。 */
  nextEffort?: string;
  /** 当前 Session 的上下文用量安全 DTO；null 表示无数据（unknown），省略表示无法查询（无 Runtime/Session）。 */
  contextUsage?: ContextUsageView | null;
  /** 最近 Turn 的累计用量安全 DTO（输入/输出/总量与执行段耗时）；null 表示无数据（unknown），省略表示无法查询。 */
  turnUsage?: TurnUsageSummaryView | null;
}

/** Composition Root 提供给 Controller 的热更新安全默认值；不携带 Provider 部署或凭据字段。 */
export interface CliRuntimeStatusDefaults {
  modelRef?: { provider: string; modelId: string };
  reasoningProfile?: { effort: string };
  permissionMode?: CliPermissionMode;
  modelCapabilities?: ReadonlyArray<{
    provider: string;
    modelId: string;
    requestableEfforts: readonly string[];
    defaultReasoningEffort?: string;
    reasoningCapabilityUnknown?: boolean;
    supportsToolCalls?: boolean;
  }>;
}

/** CLI Composition Root 提供的 Skill catalog 只读查询。 */
export type CliSkillCatalogLister = () => Promise<CliSkillSummary[]>;

/** Controller 将安全公开事件通知给 TUI 等宿主视图；回调只接收投影后的字段。 */
export type CliEventListener = (event: CliPublicEvent, projection: CliProjection) => void;

/** Controller 在自动启动 queue Turn 前通知 TUI；只携带可见 prompt 和新 Turn 身份。 */
export interface CliQueuedInputStarted {
  inputId: string;
  turnId: string;
  content: string;
  delivery: "queue";
}

/** 接收 queue 输入已被消费并将进入新 Turn 的宿主回调。 */
export type CliQueuedInputStartedListener = (input: CliQueuedInputStarted) => void;

/** CLI 恢复入口使用的 Core 脱敏 DTO 别名。 */
export type CliRecoverableTurnView = RecoverableTurnView;

/** Renderer 的纯输出接口；实现不能读取 Store、checkpoint 或 Runtime。 */
export interface CliRenderer {
  readonly format: "text" | "jsonl";
  render(event: CliPublicEvent): string;
}

/** Renderer 可见的安全事件联合类型。 */
export type CliPublicEvent =
  | { type: "thread_wait"; seq: number; turnId: string; phase: "waiting" | "processing" | "none"; pending: number; running: number; approvals: number }
  | { type: "turn_started"; seq: number; turnId: string; stepCount: number }
  | { type: "reasoning_summary"; seq: number; turnId: string; summary: string }
  | { type: "reasoning_hidden"; seq: number; turnId: string }
  | { type: "answer_delta"; seq: number; turnId: string; delta: string }
  | { type: "answer_reset"; seq: number; turnId: string }
  | { type: "tool_started"; seq: number; turnId: string; callId?: string; toolName: string; summary: string; display?: ToolDisplayFacts }
  | { type: "tool_progress"; seq: number; turnId: string; callId?: string; toolName: string; tail: string }
  | {
      type: "tool_result";
      seq: number;
      turnId: string;
      callId?: string;
      toolName: string;
      status: "success" | "approval_required" | "question_required" | "denied" | "error" | "cancelled" | "timeout";
      summary: string;
      errorCode?: string;
      /** 仅成功 edit_file 的最终 unified diff；来自 Core 已限长的公开事件。 */
      diff?: string;
      /** Core 生成的安全展示事实；Plain/JSONL 保留既有扁平字段。 */
      display?: ToolDisplayFacts;
    }
  | {
      type: "approval_required";
      seq: number;
      turnId: string;
      approvalId: string;
      callId?: string;
      toolName: string;
      reason: string;
      risk?: string;
      /** 冻结审批约束；Plain/JSONL 与历史行据此区分普通批准与无沙箱批准。 */
      constraint?: string;
      allowedDecisions?: Array<Extract<CliAction, { type: "approve" }> ["decision"]>;
      display?: ApprovalDisplayFacts;
    }
  | { type: "input_queued"; seq: number; turnId: string; inputId: string; delivery: "steer" | "queue" }
  | { type: "todo_updated"; seq: number; turnId: string; todos: TodoItem[]; counts: TodoCounts }
  | { type: "input_joined" | "input_consumed"; seq: number; turnId: string; inputId: string }
  | { type: "model_recovery"; seq: number; turnId: string; reason: string; attempt: number; maxAttempts: number }
  | { type: "context_overflow"; seq: number; turnId: string }
  | { type: "context_compact_started"; seq: number; turnId: string }
  | { type: "context_compacted"; seq: number; turnId: string; preTokens: number; postTokens: number }
  | { type: "context_compact_failed"; seq: number; turnId: string }
  | { type: "context_compact_circuit_open"; seq: number; turnId: string }
  | { type: "context_usage"; seq: number; turnId: string; usage: ContextUsageView | null }
  | { type: "active_skills"; seq: number; turnId: string; skills: Array<{ skillId: string; contentHash: string }> }
  | {
      type: "status";
      seq: number;
      turnId: string;
      status: "running" | "waiting_approval" | "waiting_user_input" | "interrupted" | "interrupted_recoverable" | "completed" | "failed" | "limit_reached";
      code?: string;
      reason?: string;
      feedbackId?: string;
      providerHttpStatus?: number;
      providerFailureDetail?: string;
      termination?: AgentTerminationView;
    };

/** CLI 投影中的安全生命周期状态。 */
export type CliTurnStatus = "idle" | "running" | "waiting_approval" | "waiting_user_input" | "interrupted" | "interrupted_recoverable" | "completed" | "failed" | "limit_reached";

/** 投影器的状态；seenKeys 仅供本地去重，不会交给 Renderer。 */
export interface CliProjection {
  turnId?: string;
  /** 当前历史问题的受信请求身份，输入在异步校验前冻结此值。 */
  questionRequestId?: string;
  status: CliTurnStatus;
  threadWait?: { phase: "waiting" | "processing"; pending: number; running: number; approvals: number };
  /** 只复制 Core RecoverableTurnView/终态投影确认的恢复布尔值。 */
  recoverable: boolean;
  answer: string;
  lastSeq?: number;
  pendingApproval?: {
    approvalId: string;
    callId?: string;
    toolName: string;
    reason: string;
    risk?: string;
    /** 冻结审批约束；沙箱降级卡（no-sandbox-exec:v1）据此展示无隔离警告。 */
    constraint?: string;
    allowedDecisions?: Array<Extract<CliAction, { type: "approve" }> ["decision"]>;
    display?: ApprovalDisplayFacts;
  };
  activeSkills: Array<{ skillId: string; contentHash: string }>;
  events: CliPublicEvent[];
  /** 最近一次 context_usage_updated 的安全 DTO；只作为状态栏刷新事实，不进入时间线。 */
  contextUsage?: ContextUsageView | null;
  /** 交互 TUI 的唯一 Runtime 事实来源；Plain/JSONL 继续消费 events。 */
  presentation: AgentPresentationState;
  seenKeys: Set<string>;
}
