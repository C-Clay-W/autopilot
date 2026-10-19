/**
 * runtime/ports/approval-store.ts — 审批决策与持久授权存储端口
 *
 * Phase 4 新增：把审批状态从 Web `permission-store.ts` 提升为跨端 Port。
 * Core 只定义读写契约，真实存储格式由 Node / Memory / Keychain Adapter 实现。
 */

import type { ToolRisk } from "../../internal/tools/types";
import type { ApprovalDecision, PersistentGrant, TaskFileTarget } from "../domain/approval";
import type { ExternalExecutionApproval, ExternalExecutionTarget } from "../domain/external-execution";
import type { ExternalFileApproval } from "../domain/external-permissions";
import type { SandboxDegradeApproval } from "../domain/sandbox-policy";

/** 查询审批决策的输入。 */
export interface GetApprovalDecisionInput {
  sessionId: string;
  turnId: string;
  approvalId: string;
}

/** 查询持久授权的输入。 */
export interface GetPersistentGrantInput {
  /** 工作区根目录。 */
  workspaceRoot: string;
  /** 当前 session ID。 */
  sessionId: string;
  /** 工具名称。 */
  toolName: string;
  /** 约束字符串；由宿主根据 toolName + input 生成。 */
  constraint: string;
}

/** 保存持久授权的输入。 */
export interface SavePersistentGrantInput {
  scope: "allow_session" | "allow_workspace";
  workspaceRoot?: string;
  sessionId?: string;
  toolName: string;
  constraint: string;
  risk?: ToolRisk;
  /** Talk-Plan1013 Stage 2：外部修改授权对应的投影规则字符串。 */
  externalRule?: string;
  executionTarget?: ExternalExecutionTarget;
  /** 任务文件集合授权：批准所属的 Turn；集合只在该 Turn 内命中。 */
  turnId?: string;
  /** 任务文件集合授权：已批准的文件与操作清单。 */
  taskFiles?: TaskFileTarget[];
  /** 投影状态：先 grant（pending）后投影，成功后 synced。 */
  projection?: "synced" | "pending";
}

/** 审批与持久授权存储端口。 */
export interface ApprovalStore {
  /** 私有冻结记录复用授权存储；旧实现缺失时新能力 fail-closed。 */
  saveExecutionApproval?(request: ExternalExecutionApproval): Promise<boolean>;
  getExecutionApproval?(input: GetApprovalDecisionInput): Promise<ExternalExecutionApproval | null>;
  /** 在批准存储锁内核验真实 decision 并一次消费；跨进程不能重放。 */
  consumeExecutionApproval?(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean>;
  /** Talk-Plan1013 Stage5 R2：外部文件审批冻结记录；与 execution 记录共用存储底座、独立 recordType。 */
  saveFileApproval?(request: ExternalFileApproval): Promise<boolean>;
  getFileApproval?(input: GetApprovalDecisionInput): Promise<ExternalFileApproval | null>;
  /** 在批准存储锁内核验真实 decision、constraint、callId、normalizedInputHash、TTL 与未消费状态后原子标记一次消费；跨进程只成功一次。 */
  consumeFileApproval?(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean>;
  /** R1：沙箱降级审批冻结记录；与 execution/file 记录共用存储底座、独立 recordType。 */
  saveDegradeApproval?(request: SandboxDegradeApproval): Promise<boolean>;
  /** R1：在批准存储锁内核验真实 decision、constraint、callId、normalizedInputHash、TTL 与未消费状态后原子标记一次消费；跨进程只成功一次。 */
  consumeDegradeApproval?(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean>;
  /** 读取指定审批决策。 */
  getDecision(input: GetApprovalDecisionInput): Promise<ApprovalDecision | null>;

  /** 原子保存审批决策；同一 session/turn/approval 已存在时返回 false。 */
  saveDecision(decision: ApprovalDecision): Promise<boolean>;

  /** 读取匹配约束的持久授权。 */
  getPersistentGrant(input: GetPersistentGrantInput): Promise<PersistentGrant | null>;

  /** 保存持久授权。 */
  savePersistentGrant(input: SavePersistentGrantInput & { createdAt: string }): Promise<PersistentGrant>;

  /** 删除当前精确约束的持久授权；不得影响同工作区的其他授权。 */
  deletePersistentGrant(input: GetPersistentGrantInput): Promise<boolean>;

  /** 删除 Session 的审批决定及仅限该 Session 的持久授权，不影响 workspace 授权。 */
  deleteBySession(sessionId: string): Promise<void>;

  /** Talk-Plan1013 Stage 2：列出持久授权（可按 workspace/session 过滤），供最小列出/撤销 facade 使用。 */
  listPersistentGrants(input: { workspaceRoot?: string; sessionId?: string }): Promise<PersistentGrant[]>;

  /** Talk-Plan1013 Stage 2：更新授权的投影状态（记住成功→synced / 记住失败保持 pending）。 */
  setGrantProjection(input: GetPersistentGrantInput & { projection: "synced" | "pending" }): Promise<PersistentGrant | null>;
}
