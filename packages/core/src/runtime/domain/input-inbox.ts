/**
 * runtime/domain/input-inbox.ts — 持续输入收件箱领域模型
 *
 * Phase 4 引入：把 Web `agent_input` durable inbox 提升为跨端 Port，
 * 支持 steer（绑定当前 running turn）与 queue（等待下一条 start/continue）两种投递语义。
 */

/** 投递语义。 */
export type InboxDelivery = "steer" | "queue";

/** 输入状态。 */
export type InboxStatus = "pending" | "claimed" | "consumed" | "cancelled";

/** 安全边界；与 AgentInputInboxCapability 对齐。 */
export type InboxBoundary = "before_sample" | "after_sample" | "after_tools" | "before_complete";

/**
 * 输入的受信来源；缺省表示当前用户。
 * 另一会话消息只保留稳定身份，不能携带审批、路径或自报权限。
 */
export type InboxOrigin = { kind: "human"; principalId?: string } | { kind: "thread"; threadId: string; turnId?: string; purpose?: "reporting_agreement" };

/** 来源比较键：缺省按当前用户处理，另一会话保留稳定身份。 */
export function inboxOriginKey(origin?: InboxOrigin): string {
  return origin === undefined || origin.kind === "human" ? "human" : JSON.stringify(["thread", origin.threadId, origin.turnId ?? null, origin.purpose ?? null]);
}

/** 一条收件箱输入。 */
export interface InboxInput {
  /** 输入唯一标识。 */
  inputId: string;
  /** 所属 session。 */
  sessionId: string;
  /** 绑定 turn；steer 时必填，queue 时可空。 */
  turnId?: string;
  /** 投递语义。 */
  delivery: InboxDelivery;
  /** 当前状态。 */
  status: InboxStatus;
  /** 用户输入内容。 */
  content: string;
  /** 宿主生成的幂等键；用于 start_next 重放时保持原有消息身份。 */
  clientMessageId?: string;
  /** 附件引用；由宿主在写入前校验并冻结。 */
  attachments: InboxAttachmentRef[];
  /** 已选择的 Skill 引用；正文不进入 inbox。 */
  selectedSkills: InboxSkillRef[];
  /** 由受信宿主绑定的来源；缺省按当前用户处理。 */
  origin?: InboxOrigin;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}

/** 已由服务端校验并冻结的附件引用。 */
export interface InboxAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  relativePath?: string;
  /** 发送副本的不可变身份；旧收件箱记录可缺省。 */
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/** 已由服务端 catalog 解析的 Skill 引用；正文不进入 inbox。 */
export interface InboxSkillRef {
  skillRef: string;
  skillId: string;
  contentHash: string;
  arguments?: string;
  pinned?: boolean;
}

/** InboxService.post 的输入。 */
export interface PostInboxInput {
  sessionId: string;
  /** 宿主生成的幂等键；同一会话重复提交时由宿主负责去重。 */
  clientMessageId?: string;
  /** steer 时必须提供当前 running turnId；queue 时可空。 */
  turnId?: string;
  delivery: InboxDelivery;
  content: string;
  attachments?: InboxAttachmentRef[];
  selectedSkills?: InboxSkillRef[];
  /** 只能由受信宿主填写；普通正文不能伪造人类批准或其他来源。 */
  origin?: InboxOrigin;
}

/** InboxService.drain 的查询条件。 */
export interface DrainInboxInput {
  sessionId: string;
  turnId: string;
  /** 最大投递语义；drain 只返回小于等于该级别的输入。 */
  maxDelivery: InboxDelivery;
  /** 当前安全边界。 */
  boundary: InboxBoundary;
}

/** start_next 从同一 Session 按 steer 优先、同类 FIFO 领取一条输入。 */
export interface ClaimNextInboxInput {
  sessionId: string;
}

/** 将已领取的输入绑定到实际启动的新 turn 并标记为 consumed。 */
export interface ConsumeInboxInput {
  sessionId: string;
  inputId: string;
  turnId: string;
}

/** 查询指定 Session 的全部 Inbox 输入，不改变任何输入状态。 */
export interface ListInboxInput {
  sessionId: string;
}
