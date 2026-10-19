/**
 * runtime/adapters/memory/memory-approval-store.ts — 内存版审批与持久授权存储
 */

import type { ToolRisk } from "../../../internal/tools/types";
import type {
  ApprovalStore,
  GetApprovalDecisionInput,
  GetPersistentGrantInput,
} from "../../ports/approval-store";
import type { ApprovalDecision, PersistentGrant } from "../../domain/approval";
import { AgentRuntimeError } from "../../protocol";
import type { ExternalExecutionApproval } from "../../domain/external-execution";
import type { ExternalFileApproval } from "../../domain/external-permissions";
import type { SandboxDegradeApproval } from "../../domain/sandbox-policy";

export class MemoryApprovalStore implements ApprovalStore {
  private decisions = new Map<string, ApprovalDecision>();
  private grants = new Map<string, PersistentGrant>();
  private executionApprovals = new Map<string, ExternalExecutionApproval>();
  private consumedExecutions = new Set<string>();
  private fileApprovals = new Map<string, ExternalFileApproval>();
  private consumedFiles = new Set<string>();
  private degradeApprovals = new Map<string, SandboxDegradeApproval>();
  private consumedDegrades = new Set<string>();

  /** 冻结目标仅存私有授权状态，不形成批准。 */
  async saveExecutionApproval(request: ExternalExecutionApproval): Promise<boolean> {
    const key = this.decisionKey(request);
    if (this.executionApprovals.has(key)) return false;
    this.executionApprovals.set(key, structuredClone(request));
    return true;
  }

  /** 读取私有冻结记录的副本，避免调用者改变已冻结身份。 */
  async getExecutionApproval(input: GetApprovalDecisionInput): Promise<ExternalExecutionApproval | null> {
    const request = this.executionApprovals.get(this.decisionKey(input));
    return request ? structuredClone(request) : null;
  }

  /** 同步临界段核验批准与 TTL，再永久标记一次消费。 */
  async consumeExecutionApproval(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean> {
    const key = this.decisionKey(input);
    const request = this.executionApprovals.get(key);
    const decision = this.decisions.get(key);
    if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
    if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || this.consumedExecutions.has(key) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
    this.consumedExecutions.add(key);
    return true;
  }

  /** Talk-Plan1013 Stage5 R2：文件审批冻结记录只存私有授权状态，不形成批准。 */
  async saveFileApproval(request: ExternalFileApproval): Promise<boolean> {
    const key = this.decisionKey(request);
    if (this.fileApprovals.has(key)) return false;
    this.fileApprovals.set(key, structuredClone(request));
    return true;
  }

  /** 读取文件审批冻结记录的副本，避免调用者改变已冻结身份。 */
  async getFileApproval(input: GetApprovalDecisionInput): Promise<ExternalFileApproval | null> {
    const request = this.fileApprovals.get(this.decisionKey(input));
    return request ? structuredClone(request) : null;
  }

  /** 同步临界段核验真实批准、当前约束与 TTL，再永久标记一次消费；重复消费返回 false。 */
  async consumeFileApproval(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean> {
    const key = this.decisionKey(input);
    const request = this.fileApprovals.get(key);
    const decision = this.decisions.get(key);
    if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
    if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || this.consumedFiles.has(key) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
    this.consumedFiles.add(key);
    return true;
  }

  /** R1：降级审批冻结记录只存私有授权状态，不形成批准。 */
  async saveDegradeApproval(request: SandboxDegradeApproval): Promise<boolean> {
    const key = this.decisionKey(request);
    if (this.degradeApprovals.has(key)) return false;
    this.degradeApprovals.set(key, structuredClone(request));
    return true;
  }

  /** R1：同步临界段核验真实批准、当前约束与 TTL，再永久标记一次消费；重复消费返回 false。 */
  async consumeDegradeApproval(input: GetApprovalDecisionInput & { constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean> {
    const key = this.decisionKey(input);
    const request = this.degradeApprovals.get(key);
    const decision = this.decisions.get(key);
    if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
    if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || this.consumedDegrades.has(key) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
    this.consumedDegrades.add(key);
    return true;
  }

  async getDecision(input: GetApprovalDecisionInput): Promise<ApprovalDecision | null> {
    return this.decisions.get(this.decisionKey(input)) ?? null;
  }

  /** 原子保存审批决策；重复审批键不覆盖第一次决定。 */
  async saveDecision(decision: ApprovalDecision): Promise<boolean> {
    const key = this.decisionKey(decision);
    if (this.decisions.has(key)) return false;
    this.decisions.set(key, decision);
    return true;
  }

  async getPersistentGrant(input: GetPersistentGrantInput): Promise<PersistentGrant | null> {
    // 先查 workspace 级（不区分 session），再查 session 级。
    const workspaceKey = this.grantKey({ scope: "allow_workspace", workspaceRoot: input.workspaceRoot, sessionId: undefined, toolName: input.toolName, constraint: input.constraint });
    const workspaceGrant = this.grants.get(workspaceKey);
    if (workspaceGrant) return workspaceGrant;
    const sessionKey = this.grantKey({ scope: "allow_session", workspaceRoot: undefined, sessionId: input.sessionId, toolName: input.toolName, constraint: input.constraint });
    return this.grants.get(sessionKey) ?? null;
  }

  async savePersistentGrant(
    input: Omit<PersistentGrant, "createdAt"> & { createdAt: string },
  ): Promise<PersistentGrant> {
    if (input.scope !== "allow_session" && input.scope !== "allow_workspace") {
      throw new AgentRuntimeError("INVALID_INPUT", `PersistentGrant scope 只能是 allow_session 或 allow_workspace，收到 ${input.scope}`);
    }
    const grant: PersistentGrant = { ...input };
    this.grants.set(this.grantKey(grant), grant);
    return grant;
  }

  /** 删除精确 workspace/session grant，供 MCP revoke 等管理命令使用。 */
  async deletePersistentGrant(input: GetPersistentGrantInput): Promise<boolean> {
    const workspaceKey = this.grantKey({ scope: "allow_workspace", workspaceRoot: input.workspaceRoot, sessionId: undefined, toolName: input.toolName, constraint: input.constraint });
    const sessionKey = this.grantKey({ scope: "allow_session", workspaceRoot: undefined, sessionId: input.sessionId, toolName: input.toolName, constraint: input.constraint });
    return this.grants.delete(workspaceKey) || this.grants.delete(sessionKey);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [key, request] of this.executionApprovals) {
      if (request.sessionId === sessionId) { this.executionApprovals.delete(key); this.consumedExecutions.delete(key); }
    }
    for (const [key, request] of this.fileApprovals) {
      if (request.sessionId === sessionId) { this.fileApprovals.delete(key); this.consumedFiles.delete(key); }
    }
    for (const [key, request] of this.degradeApprovals) {
      if (request.sessionId === sessionId) { this.degradeApprovals.delete(key); this.consumedDegrades.delete(key); }
    }
    for (const [key, decision] of this.decisions) {
      if (decision.sessionId === sessionId) this.decisions.delete(key);
    }
    for (const [key, grant] of this.grants) {
      if (grant.scope === "allow_session" && grant.sessionId === sessionId) this.grants.delete(key);
    }
  }

  /** Talk-Plan1013 Stage 2：按 workspace/session 过滤列出授权，与 Node store 契约一致。 */
  async listPersistentGrants(input: { workspaceRoot?: string; sessionId?: string }): Promise<PersistentGrant[]> {
    return [...this.grants.values()].filter((grant) => {
      if (input.workspaceRoot !== undefined && grant.workspaceRoot !== input.workspaceRoot) return false;
      if (input.sessionId !== undefined && grant.sessionId !== input.sessionId) return false;
      return true;
    });
  }

  /** Talk-Plan1013 Stage 2：更新授权投影状态；未命中返回 null，与 Node store 契约一致。 */
  async setGrantProjection(input: GetPersistentGrantInput & { projection: "synced" | "pending" }): Promise<PersistentGrant | null> {
    const grant = await this.getPersistentGrant(input);
    if (!grant) return null;
    const updated: PersistentGrant = { ...grant, projection: input.projection };
    this.grants.set(this.grantKey(updated), updated);
    return updated;
  }

  private decisionKey(input: GetApprovalDecisionInput | ApprovalDecision): string {
    return `${input.sessionId}:${input.turnId}:${input.approvalId}`;
  }

  private grantKey(grant: {
    scope: PersistentGrant["scope"];
    workspaceRoot?: string;
    sessionId?: string;
    toolName: string;
    constraint: string;
  }): string {
    return `${grant.scope}:${grant.workspaceRoot ?? ""}:${grant.sessionId ?? ""}:${grant.toolName}:${grant.constraint}`;
  }
}
