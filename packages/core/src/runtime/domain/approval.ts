/**
 * runtime/domain/approval.ts — 审批与持久授权领域模型
 *
 * Phase 4 引入：把 Web `permission-store.ts` 中的审批决策与持久授权
 * 提升为跨端领域模型，供 ApprovalService 与 ToolExecutor 使用。
 */

import type { ToolApprovalDecision, ToolRisk } from "../../internal/tools/types";
import type { ExternalExecutionTarget } from "./external-execution";

/** 用户对一次工具调用审批请求的决定。 */
export interface ApprovalDecision {
  /** 审批请求唯一标识。 */
  approvalId: string;
  /** 所属 turn。 */
  turnId: string;
  /** 所属 session。 */
  sessionId: string;
  /** 工具调用 ID。 */
  callId: string;
  /** 工具名称。 */
  toolName: string;
  /** 归一化输入哈希；用于跨请求校验审批是否匹配同一工具调用。 */
  normalizedInputHash: string;
  /** 新版外部执行批准的摘要和 TTL；不包含 canonical 目标。 */
  constraint?: string;
  expiresAt?: string;
  /** 用户决策。 */
  decision: ToolApprovalDecision;
  /** Talk-Plan1013 Stage 2：allow_workspace 外部授权的记住状态，供宿主区分"批准成功"与"记住失败"。 */
  projection?: "synced" | "pending";
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}

/** 任务文件集合审批的单个目标；path 为工作区相对路径，operation 为声明的修改方式。 */
export interface TaskFileTarget {
  path: string;
  operation: "create" | "edit";
}

/** 任务文件集合审批的稳定约束；todo_write 声明清单时由本地 facts 生成，模型不可构造其他语义。 */
export const TASK_FILE_SET_CONSTRAINT = "task-files:v1";

/**
 * 外部文件集合审批的稳定约束（2.4 第 4 项"额外外部集合一次确认"）：与工作区集合分卡审批，
 * 成员为 canonical 绝对路径；授权同样只绑定当前 Turn，不隐式授予父目录或递归权限。
 */
export const TASK_EXTERNAL_FILE_SET_CONSTRAINT = "task-ext-files:v1";

/** 判断约束是否为任务文件集合审批约束。 */
export function isTaskFileSetConstraint(constraint: string | undefined): boolean {
  return constraint === TASK_FILE_SET_CONSTRAINT;
}

/** 判断约束是否为外部文件集合审批约束。 */
export function isExternalTaskFileSetConstraint(constraint: string | undefined): boolean {
  return constraint === TASK_EXTERNAL_FILE_SET_CONSTRAINT;
}

/** 集合声明类约束（工作区或外部）：PolicyEngine 据此收窄决定范围并禁止旧集合 grant 放行新声明。 */
export function isTaskFileSetDeclarationConstraint(constraint: string | undefined): boolean {
  return isTaskFileSetConstraint(constraint) || isExternalTaskFileSetConstraint(constraint);
}

/** 持久化授权（allow_session / allow_workspace）。 */
export interface PersistentGrant {
  /** 授权范围。 */
  scope: "allow_session" | "allow_workspace";
  /** 工作区根目录；allow_workspace 时必填。 */
  workspaceRoot?: string;
  /** session ID；allow_session 时必填。 */
  sessionId?: string;
  /** 工具名称。 */
  toolName: string;
  /** 持久授权的稳定约束，例如 path:相对路径 或 program:程序名。 */
  constraint: string;
  /** 风险等级。 */
  risk?: ToolRisk;
  /** Talk-Plan1013 Stage 2：外部修改授权对应的投影规则字符串（Write|Edit(<canonicalTarget>)）。 */
  externalRule?: string;
  /** 仅授权状态内部保存的外部命令身份；公开列表投影不得回显。 */
  executionTarget?: ExternalExecutionTarget;
  /** 投影状态：synced=local 规则已写入；pending=记住失败，双边不一致时不自动放行。 */
  projection?: "synced" | "pending";
  /** 任务文件集合授权：批准所属的 Turn；集合只在该 Turn 内命中。 */
  turnId?: string;
  /** 任务文件集合授权：已批准的文件与操作清单；write/edit 逐调用核对成员。 */
  taskFiles?: TaskFileTarget[];
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}

/** ApprovalService.submit 的输入。 */
export interface SubmitApprovalInput {
  sessionId: string;
  turnId: string;
  approvalId: string;
  decision: ToolApprovalDecision;
}

/** 查询持久授权时的输入。 */
export interface FindPersistentGrantInput {
  /** 工作区根目录。 */
  workspaceRoot: string;
  /** 当前 session ID。 */
  sessionId: string;
  /** 工具名称。 */
  toolName: string;
  /** 约束字符串。 */
  constraint: string;
}
