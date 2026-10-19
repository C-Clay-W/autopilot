/** Presentation 的稳定视图模型；只保存可安全展示的事件事实与 Host 安全快照。 */
import type { ApprovalDisplayFacts, ToolDisplayDetail, ToolDisplayFacts, TodoCounts, TodoItem as CoreTodoItem, UserQuestionItem as CoreUserQuestionItem } from "@autopilot-agent/core";

export type ToolCategory = "read" | "search" | "command" | "write" | "edit" | "external" | "process" | "other";
export type ToolCallState = "running" | "awaiting_approval" | "completed" | "failed" | "denied" | "cancelled" | "timeout";
export type TurnState = "completed" | "failed" | "interrupted" | "limit_reached" | "awaiting_approval" | "paused";
export type TransportState = "connected" | "disconnected" | "reconnecting";
export type ToolMetrics = Record<string, string | number | boolean>;

export interface ThinkingItem {
  id: string;
  kind: "thinking";
  turnId: string;
  stepId: string;
  summary: string;
  state: "active" | "completed";
}

export interface ToolCallItem {
  id: string;
  kind: "tool_call";
  turnId: string;
  /** Runtime step 边界；仅用于将自动工具名摘要与真实调用对应。 */
  stepId?: string;
  callId: string;
  toolName: string;
  profileKey: string;
  category: ToolCategory;
  state: ToolCallState;
  titleKey: string;
  target?: string;
  resultSummary?: string;
  metrics?: ToolMetrics;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorCode?: string;
  /** Core 生成的工具专用明细；reducer 只原样投影，绝不回读 raw output 或按 toolName 重建。 */
  detail?: ToolDisplayDetail;
  /** Core 生成的后台 Job 安全引用事实。 */
  job?: ToolDisplayFacts["job"];
  diff?: ToolDisplayFacts["diff"];
  /** 进程类工具的实际执行方式；unisolated/unavailable 时展示层不得宣称隔离。 */
  executionMode?: ToolDisplayFacts["executionMode"];
  /** 沙箱不可用类拒绝的结构化脱敏诊断；Web/CLI 各出口共用。 */
  diagnostics?: string[];
}

export interface ToolGroupItem {
  id: string;
  kind: "tool_group";
  turnId: string;
  groupKey: "exploration";
  toolCallIds: string[];
  state: "running" | "completed";
}

export interface ApprovalItem {
  id: string;
  kind: "approval";
  turnId: string;
  approvalId: string;
  callId: string;
  toolName: string;
  state: "required" | "resolved";
  /** 冻结审批约束；沙箱降级卡（no-sandbox-exec:v1）据此展示无隔离警告。 */
  constraint?: string;
  display?: ApprovalDisplayFacts;
}

/** 已由 Core 事件白名单投影的结构化澄清问题；不保存用户补充正文或 Tool 原始数据。 */
export interface UserQuestionItem {
  id: string;
  kind: "user_question";
  turnId: string;
  requestId: string;
  callId: string;
  state: "required" | "answered" | "cancelled";
  questions: CoreUserQuestionItem[];
  answerSummary?: {
    questionCount: number;
    selectedLabels: string[];
    hasCustom: boolean;
  };
}

/** Session 任务链的当前 Todo 快照；latest-write-wins，turnId 归属最近一次成功更新的 Turn。 */
export interface TodoSnapshotItem {
  id: string;
  kind: "todo";
  turnId: string;
  todos: CoreTodoItem[];
  counts: TodoCounts;
}

export interface AssistantAnswerItem {
  id: string;
  kind: "assistant_answer";
  /** 过程回答可追溯但不作为最终正文；同一 Turn 最多只有一个 final 节点。 */
  channel: "process" | "final";
  turnId: string;
  stepId: string;
  content: string;
}

export interface InputNoticeItem {
  id: string;
  kind: "input_notice";
  turnId: string;
  inputId: string;
  delivery?: "steer" | "queue";
  state: "queued" | "joined" | "consumed";
  /** 宿主确认的用户原文；Runtime 事件本身不携带正文。 */
  content?: string;
  position?: PresentationInputPosition;
  cancelled?: boolean;
}

/** 页面本地提交边界或安全 History 消费边界，仅引用展示节点。 */
export interface PresentationInputPosition {
  turnId?: string;
  order?: number;
  items: Array<{ id: string; answerLength?: number }>;
}

export interface ContextNoticeItem {
  id: string;
  kind: "context_notice";
  turnId: string;
  state: "compacting" | "compacted" | "failed" | "circuit_open" | "overflow";
  trigger?: "auto" | "proactive" | "reactive";
  summary?: string;
}

export interface UndoItem {
  id: string;
  kind: "undo";
  turnId: string;
  transactionId: string;
  state: "completed" | "failed";
  restoredPaths: string[];
  compensatedPaths: string[];
  conflicts: string[];
}

export interface JobItem {
  id: string;
  kind: "job";
  jobId: string;
  sessionId: string;
  revision: number;
  state: "starting" | "running" | "stopping" | "completed" | "failed" | "stopped" | "interrupted";
  controlState: "owned" | "foreign_owner" | "owner_unknown" | "terminal";
  canStop: boolean;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  failureCode?: string;
  title?: string;
  summary?: string;
}

export interface CapabilityNoticeItem {
  id: string;
  kind: "capability_notice";
  scope: "transport" | "mcp" | "doctor" | "evidence" | "undo";
  state: string;
  summary?: string;
}

export interface TurnSummaryItem {
  id: string;
  kind: "turn_summary";
  turnId: string;
  state: TurnState;
  durationMs?: number;
  toolCount: number;
  modifiedFileCount?: number;
}

export type AgentPresentationItem = ThinkingItem | ToolCallItem | ApprovalItem | UserQuestionItem | TodoSnapshotItem | AssistantAnswerItem | InputNoticeItem | ContextNoticeItem | UndoItem | JobItem | CapabilityNoticeItem | TurnSummaryItem;

export interface ActiveOperation {
  kind: "thinking" | "tool" | "approval" | "question" | "context";
  id: string;
}

export interface AgentPresentationState {
  sessionId?: string;
  turnId?: string;
  items: AgentPresentationItem[];
  activeOperation?: ActiveOperation;
  turnSummary?: TurnSummaryItem;
  transport?: TransportState;
  appliedEventIds: string[];
  lastSeqByTurn: Record<string, number>;
  turnStartedAt: Record<string, string>;
  /** 最近一次已应用的 Todo 快照事件时间戳；跨 Turn 乱序回放时保证 latest-write-wins。 */
  todoLastUpdatedAt?: string;
  /** 各轮最后一次安全 Todo；Session latest selector 继续读取 items 单卡。 */
  todosByTurn?: Record<string, TodoSnapshotItem>;
}

/** 创建空白 Presentation 状态，供 Live 与 History 使用相同入口。 */
export function createPresentationState(): AgentPresentationState {
  return { items: [], appliedEventIds: [], lastSeqByTurn: {}, turnStartedAt: {} };
}
