/** Chat 页面拆分出的本地共享类型：作为 page 装配层与 components/ UI 组件的唯一类型来源，不包含任何运行逻辑。 */
import type { ProcessStep } from "./components/process-step";
import type { KnowledgeIngestItem } from "./components/KnowledgeIngestCard";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import type { AgentTerminationView, ChatRetrievalMode, ContextUsageView, TurnUsageSummaryView } from "@autopilot-agent/core";
import type { WebTurnFailure } from "@/lib/runtime-host/web-turn-failure";
import type {
  WebSessionDto as SessionMeta,
  WebSessionMessageDto as SessionMessage,
} from "@/lib/runtime-host/web-ui-dto";
import type { SessionTaskTerminalSnapshot } from "./session-task-controller";
import type { ProvisionalSessionIdentity } from "./session-chat-host";

export interface SelectedFile {
  name: string;
  size: number;
  file: File;
}

/** Composer 对外只暴露提交时需要的最小受控动作，输入字符不回流页面装配层。 */
export interface ComposerInputActions {
  setInput(value: string): void;
}

export interface SessionImageAttachment {
  id: string;
  name: string;
  mimeType: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  failure?: WebTurnFailure;
  termination?: AgentTerminationView;
  files?: SelectedFile[];
  attachments?: SessionImageAttachment[];
  sources?: SourceItem[];
  processSteps?: ProcessStep[];
  activity?: "answer" | "ingest";
  turnId?: string;
  diagnostics?: string[];
  knowledgeIngestItems?: KnowledgeIngestItem[];
  knowledgeFiles?: Array<{ name: string; size: number }>;
  clientRecordId?: string;
  /** 受信来源：thread 来源 Prompt 由宿主写入，UI 据此显示固定标签；正文无法伪造。 */
  origin?: { kind: "thread"; threadId: string };
  /** 仅由受信交付链生成的交接展示快照。 */
  handoffDisplay?: { title: string; instruction: string; summary: string };
  createdAt?: number;
  /** 任务达到最大执行步骤时为 true，UI 会渲染“继续执行”按钮 */
  canContinue?: boolean;
  /** 已保存问题的原请求身份，恢复时不重复提交答案。 */
  questionRequestId?: string;
  /** 继续请求本身失败的结构化原因；只在当前消息内展示，不隐藏可恢复入口。 */
  recoveryError?: string;
  /** 停止请求与权威确认分开呈现，待确认保留再次停止入口。 */
  stopState?: "requesting" | "pending" | "stopped";
  /** 本地实时请求尚未被 History 持久化投影确认。 */
  optimistic?: boolean;
}

export interface SourceItem {
  metadata?: {
    fileName?: string;
    pageNumber?: number;
    title?: string;
    imageFileName?: string;
    [key: string]: unknown;
  };
}

export interface SkillCatalogEntry {
  skillId: string;
  qualifiedName: string;
  name: string;
  description: string;
  source: string;
  allowedTools?: string[];
  displayName?: string;
  modelInvocable?: boolean;
  argumentHint?: string;
}

export interface SelectedSkill {
  skillRef: string;
  arguments?: string;
  pinned?: boolean;
}

export interface SessionAgentState {
  requestId?: string;
  continuation?: { controlId: string; state: string; failureCode?: string };
  turnId: string;
  approvalId?: string;
  status: "awaiting_approval" | "awaiting_user_input" | "interrupted_recoverable" | "limit_reached" | "failed";
  recoverable: boolean;
  termination?: AgentTerminationView;
  execution?: "active" | "inactive" | "unconfirmed" | "lost";
  interactionState?: "pending" | "decided" | "expired" | "unconfirmed";
  warning?: "summary_lag";
}

export interface PendingAgentInput {
  inputId: string;
  clientMessageId: string;
  delivery: "steer" | "queue";
  status: "pending" | "claimed";
  content: string;
  attachmentCount: number;
  skillCount: number;
  createdAt: number;
}

/** Session History 接口返回的完整安全投影，可由普通加载或 SSE 终态校准复用。 */
export interface SessionHistoryPayload extends SessionTaskTerminalSnapshot {
  meta: SessionMeta;
  messages: SessionMessage[];
  presentation?: AgentPresentationState;
  agent?: SessionAgentState;
  canAutoStartNext?: boolean;
  pendingInputs?: PendingAgentInput[];
  turnId?: string;
  readOnlyReason?: "WORK_HISTORY_READ_ONLY";
  attachments?: ChatAttachmentView[];
  /** Core 最新安全 Context Usage 快照；null/缺失表示当前无可用展示事实。 */
  contextUsage?: ContextUsageView | null;
  /** Core 最近 Turn 的累计用量汇总（输入/输出/总量与执行段耗时）；null/缺失表示当前无可用展示事实。 */
  turnUsage?: TurnUsageSummaryView | null;
}

/** Chat 临时附件只展示安全标识与有效期，不包含存储路径。 */
export interface ChatAttachmentView {
  ref: string;
  displayName: string;
  mimeType: string;
  expiresAt: number;
}

/** 可在 URL 切换后继续存活的草稿槽；首次发送后同一槽位绑定真实 Session。 */
export interface DraftSessionSlot extends ProvisionalSessionIdentity {
  slotId: string;
  retrievalMode?: ChatRetrievalMode;
  draftId?: string;
  pending?: boolean;
}

export interface InputDeliveryNotice {
  delivery: "steer" | "queue";
  content: string;
  status: "accepted" | "started";
}

/** Session Context Usage 顶栏展示直接消费 Core 安全 DTO；Web 不再定义本地预算形状。 */
export type { ContextUsageView, TurnUsageSummaryView };
