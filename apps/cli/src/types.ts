/**
 * CLI 宿主层的本地协议类型。
 *
 * 这些类型只描述 argv、slash action、事件投影和输出格式，不能替代 Core
 * Runtime 的领域类型，也不携带审批冻结凭证或完整 checkpoint。
 */

import type { AgentEvent, AgentRuntime, AgentTerminationView, ApprovalDisplayFacts, ContextUsageView, JobListView, JobReadView, JobView, RecoverableTurnView, TodoCounts, TodoItem, ToolDisplayFacts } from "@autopilot-agent/core";
import type { AgentPresentationState } from "@autopilot-agent/presentation";

/** CLI 当前支持的 Session 工具权限模式；与 Core 的公共枚举保持同值域。 */
export type CliPermissionMode = "ask" | "auto_approve" | "full_access";

/** CLI 输出模式；interactive 在 Step 5.4 才接入 Ink。 */
export type CliOutputFormat = "interactive" | "text" | "jsonl";

/** CLI 命令语法树；命令本身不包含宿主状态根或 Runtime 实例。 */
export type CliCommand =
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
  | { type: "chat"; prompt?: string; sessionId?: string; output: CliOutputFormat }
  | { type: "resume"; sessionId?: string; output: CliOutputFormat };

/** CLI Action；审批 Action 只携带宿主决定，不携带冻结调用字段。 */
export type CliAction =
  /** delivery 只在已有活动 Turn 时生效；省略时与 Web 一致，默认 steer。 */
  | { type: "submit_prompt"; content: string; delivery?: "steer" | "queue" }
  | { type: "approve"; decision: "allow_once" | "allow_session" | "allow_workspace" | "deny" }
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
export type CliRuntime = Pick<AgentRuntime, "turns" | "projects" | "sessions" | "approvals" | "inbox" | "jobs" | "undo">;

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
  /** 活动 Turn 存在时，Session 默认权限若不同则提示下轮值。 */
  nextPermissionMode?: CliPermissionMode;
  /** 活动 Turn 存在时显示已保存、但尚未冻结到当前 Turn 的下一轮模型。 */
  nextModel?: string;
  /** 活动 Turn 存在时显示已保存、但尚未冻结到当前 Turn 的下一轮推理强度。 */
  nextEffort?: string;
  /** 当前 Session 的上下文用量安全 DTO；null 表示无数据（unknown），省略表示无法查询（无 Runtime/Session）。 */
  contextUsage?: ContextUsageView | null;
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
      termination?: AgentTerminationView;
    };

/** CLI 投影中的安全生命周期状态。 */
export type CliTurnStatus = "idle" | "running" | "waiting_approval" | "waiting_user_input" | "interrupted" | "interrupted_recoverable" | "completed" | "failed" | "limit_reached";

/** 投影器的状态；seenKeys 仅供本地去重，不会交给 Renderer。 */
export interface CliProjection {
  turnId?: string;
  status: CliTurnStatus;
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
