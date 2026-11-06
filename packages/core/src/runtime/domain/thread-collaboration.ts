/** 会话协作的持久化领域类型；执行事实仍由 Session 和 Turn 持有。 */

/** 仅由受信宿主绑定的协作来源，不能由模型正文指定。 */
export type ThreadActor =
  | { kind: "human"; principalId: string }
  | { kind: "thread"; threadId: string; turnId: string };

/** 一个协作成员对应一个正常 Session。 */
export interface ThreadMember {
  /** 创建宿主冻结的执行档位；同类宿主重启可接管，其他档位不能执行。 */
  executionHost?: string;
  threadId: string;
  groupId: string;
  parentThreadId: string | null;
  title?: string;
  roleLabel?: string;
  createdAt: number;
}

/** 人类显式启用、绑定单一工作区和 Project 的协作范围。 */
export interface ThreadGroup {
  groupId: string;
  workspaceId: string;
  projectId: string;
  rootThreadId: string;
  enabled: boolean;
  createdAt: number;
  createdBy: ThreadActor;
  /** 可信宿主人类 principal；与 createdBy 分离，线程 Actor 建组时仍保留真实创建来源。 */
  ownerPrincipalId?: string;
  allowedTools: readonly string[];
}

/** 操作重试结果与规范化请求摘要。 */
export interface ThreadReceipt {
  actorKey: string;
  operation: string;
  requestId: string;
  payloadDigest: string;
  result: unknown;
}

/** 创建 Session 的可恢复意图，不能覆盖不相关 Session。 */
export interface ThreadCreateIntent {
  requestId: string;
  actorKey: string;
  from: ThreadActor;
  payloadDigest: string;
  threadId: string;
  parentThreadId: string;
  title?: string;
  roleLabel?: string;
  modelRef?: import("./model-ref").ModelRef;
  reasoningEffort?: import("./model-ref").ReasoningEffort;
  /** 新目标只继承创建时有效权限偏好，不复制任何批准/Trust/凭据。 */
  permissionMode?: import("./session-run-config").SessionRunConfig["permissionMode"];
  /** 创建意图先冻结宿主档位，重试不能改绑。 */
  executionHost?: string;
  status: "creating" | "created" | "recovery_required";
}

/** 交付失败/阻塞的稳定原因，只放安全枚举，不写入原始异常正文。 */
export type ThreadDeliveryReason =
  | "target_running"
  | "target_waiting_approval"
  | "target_waiting_user_input"
  | "target_interrupted"
  | "turn_failed"
  | "turn_interrupted"
  | "turn_not_running"
  | "start_failed"
  | "host_offline"
  | "recovery_required";

/** 交付事实：消息正文不可变，领取归属、预留 Turn 与真实执行结果单独记账。 */
export interface ThreadDelivery {
  /** 投递执行要求，不是领取owner；缺省兼容历史任务。 */
  executionHost?: string;
  messageId: string;
  threadId: string;
  deliverySeq: number;
  mode: "notify" | "run" | "steer";
  status: "pending" | "claimed" | "delivered" | "blocked" | "failed" | "cancelled";
  attempts: number;
  updatedAt: number;
  /** 领取时预留的稳定 Turn 身份；重放据此查询是否已启动过。 */
  reservedTurnId?: string;
  /** 已桥接到 Inbox/Turn 的真实身份。 */
  inputId?: string;
  turnId?: string;
  /** 领取该交付的本宿主实例；心跳超时只说明失联，不代表外部副作用已停止。 */
  ownerId?: string;
  ownerHeartbeatAt?: number;
  reason?: ThreadDeliveryReason;
}

/** 宿主控制意图；中断、interrupted恢复与已保存交互继续分别表达，接受不等于执行。 */
export interface ThreadControlIntent {
  controlId: string;
  kind: "interrupt" | "resume" | "continue_interaction";
  /** 人类已保存交互的精确身份，不复制决定或答案。 */
  approvalId?: string;
  requestId?: string;
  failureCode?: "BOUNDARY_CHANGED" | "CONTINUE_FAILED";
  /** 原意图上的安全失败事实；started只表示Runner观察到已持久化启动事件。 */
  failureDiagnostic?: { stage: "read_decision" | "continue" | "after_started"; category: "storage" | "runtime" | "os" | "unknown"; code: string; started: boolean; filePhase?: "lock" | "temporary_write" | "rename" | "cleanup" };
  /** 恢复请求绑定当时的暂停 checkpoint，迟到控制不能恢复新的执行段。 */
  checkpointDigest?: string;
  /** 交互控制绑定原暂停序号；旧中断恢复记录可缺省。 */
  pauseSeq?: number;
  threadId: string;
  expectedTurnId: string;
  status: "pending" | "applied" | "rejected" | "claimed" | "executing" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  ownerId?: string;
}

/**
 * 进展摘要类别：`progress` 是可合并、可在容量压力下淘汰的普通进度，
 * 其余是必须逐条保留的关键事实（结论、阻塞、完成、失败）。
 */
export type ThreadProgressKind = "progress" | "milestone" | "blocked" | "completed" | "failed";

/**
 * 目标会话回报的任务进展摘要：保留 run/Turn 归属和有界结论，不复制工具日志或完整原文。
 * 会话累计序号和任务独立序号并存，发起方按任务游标差量读取。
 */
export interface ThreadProgressEntry {
  /** 新记录绑定真实任务；升级前的会话进展保留缺省，不猜测或归入新任务。 */
  taskId?: string;
  turnId?: string;
  taskProgressSeq?: number;
  threadId: string;
  progressSeq: number;
  kind: ThreadProgressKind;
  summary: string;
  createdAt: number;
  /** 证据引用：子会话自己的 Turn 或本组已提交消息，不含路径或正文。 */
  evidence?: { turnId?: string; messageId?: string };
}

/** 组控制聚合只承载有界控制信息，不复制模型历史或审批。 */
export interface ThreadControl {
  group: ThreadGroup;
  revision: number;
  members: ThreadMember[];
  receipts: ThreadReceipt[];
  creates: ThreadCreateIntent[];
  sharedState: Record<string, unknown>;
  stateRevision: number;
  stateUpdatedAt: number;
  stateUpdatedBy: ThreadActor;
  nextGroupSeq: number;
  eventIntents: ThreadEvent[];
  nextDeliverySeq: Record<string, number>;
  messageIntents: Array<{ actorKey: string; payloadDigest: string; message: ThreadMessage; committed: boolean }>;
  /** 交付状态；与不可变消息记录分开，避免重写正文。 */
  deliveries: ThreadDelivery[];
  /** 跨进程控制意图队列。 */
  controls: ThreadControlIntent[];
  /** 有界进展摘要日志；旧状态根没有该字段时按空日志处理。 */
  progress?: ThreadProgressEntry[];
  /** 每目标下一个进展序号；与 nextDeliverySeq 同样按目标单调。 */
  nextProgressSeq?: Record<string, number>;
}

/** 显式交接输入：标题单行有界，摘要与目标 Prompt 使用同一份内容。 */
export interface ThreadHandoffInput {
  title: string;
  markdown: string;
}

/** 交接文档的安全引用；不含宿主绝对路径或文件正文。 */
export interface ThreadHandoffRef {
  handoffId: string;
  /** 工作区相对路径，供人类与目标会话核对。 */
  relativePath: string;
  /** 摘要文件校验和；回读时据此发现内容被改。 */
  sha256: string;
}

/** 持久消息与交付状态；不表示 Turn 执行成功。 */
export interface ThreadMessage {
  /** 仅受信Kernel可生成；旧消息缺省为普通协作输入。 */
  purpose?: { kind: "reporting_agreement"; taskId: string };
  messageId: string;
  requestId: string;
  groupId: string;
  from: ThreadActor;
  toThreadId: string;
  mode: "notify" | "run" | "steer";
  content: string;
  replyTo?: string;
  expectedTurnId?: string;
  /** 显式交接产生的文档引用；普通 send 不含此字段。 */
  handoff?: ThreadHandoffRef;
  /** 交接展示所需的受信快照，不从合成正文反向解析。 */
  handoffDisplay?: { title: string; instruction: string; summary: string };
  createdAt: number;
  deliverySeq: number;
  deliveryStatus: "accepted" | "pending" | "claimed" | "delivered" | "blocked" | "cancelled" | "failed";
  inputId?: string;
  turnId?: string;
}

/** 事件来源：宿主驱动的事件不冒充人类或某个会话。 */
export type ThreadEventActor = ThreadActor | { kind: "host"; hostId: string };

/** 可重放协作事件，仅含受信来源和安全引用。 */
export interface ThreadEvent {
  groupId: string;
  groupSeq: number;
  actor: ThreadEventActor;
  kind:
    | "member_created"
    | "group_enabled"
    | "group_disabled"
    | "message_accepted"
    | "message_delivered"
    | "message_blocked"
    | "shared_state_changed"
    | "turn_attention"
    | "turn_terminal"
    | "host_offline"
    | "recovery_required";
  createdAt: number;
  threadId?: string;
  messageId?: string;
  turnId?: string;
  stateRevision?: number;
}

/** 仅投影封闭错误码及确实观察到的阶段，不传播异常正文或附加字段。 */
export function sanitizeContinuationFailure(value: ThreadControlIntent["failureDiagnostic"]): ThreadControlIntent["failureDiagnostic"] {
  if (!value || !["read_decision", "continue", "after_started"].includes(value.stage) || typeof value.started !== "boolean") return undefined;
  const storage = ["STATE_STORAGE_UNAVAILABLE", "STATE_SESSION_CORRUPTED", "STATE_STORAGE_UNSAFE_PATH", "STATE_SCHEMA_BUSY", "STATE_SCHEMA_RECOVERY_REQUIRED"];
  const runtime = ["INTERACTION_DECISION_REQUIRED", "TURN_NOT_RESUMABLE", "TURN_ALREADY_RUNNING", "TURN_NOT_FOUND", "CHECKPOINT_NOT_FOUND", "THREAD_RECOVERY_REQUIRED", "TURN_FROZEN_MISMATCH", "APPROVAL_MISMATCH", "APPROVAL_NOT_FOUND", "CANONICAL_MESSAGE_INVALID", "INVALID_RUN_CONFIG", "MISSING_CREDENTIAL", "PROVIDER_UNAUTHORIZED"];
  const os = ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EBUSY", "EROFS", "ENOTDIR", "ETIMEDOUT"];
  const category = storage.includes(value.code) ? "storage" : runtime.includes(value.code) ? "runtime" : os.includes(value.code) ? "os" : "unknown";
  return { stage: value.stage, category, code: category === "unknown" ? "CONTINUE_UNKNOWN" : value.code, started: value.started, ...(value.filePhase && ["lock", "temporary_write", "rename", "cleanup"].includes(value.filePhase) ? { filePhase: value.filePhase } : {}) };
}
