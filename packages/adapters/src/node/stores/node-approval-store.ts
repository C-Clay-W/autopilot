/**
 * Node ApprovalStore：在显式 stateRoot/approvals 下持久化审批决定与稳定范围授权。
 */

import fs from "node:fs";
import type { ApprovalDecision, ApprovalStore, PersistentGrant } from "@autopilot-agent/core";
import type { ExternalExecutionApproval, ExternalFileApproval, SandboxDegradeApproval } from "@autopilot-agent/core";
import { AgentRuntimeError } from "@autopilot-agent/core";
import { appendJsonLine, appendUniqueJsonLine, atomicReplace, readJsonLines, withFileLock } from "../file-utils";
import { canonicalizeNodePath, ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 ApprovalStore。 */
export function createNodeApprovalStore(options: NodeStoreOptions): ApprovalStore {
  const paths = getNodeStatePaths(options.stateRoot);
  const decisionsFile = `${paths.approvalsDir}/decisions.jsonl`;
  const grantsFile = `${paths.approvalsDir}/grants.jsonl`;

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.approvalsDir, { recursive: true });
  }

  return {
    /** 待审批私有身份复用 decisions.jsonl；记录类型不与真实 decision 混淆。 */
    async saveExecutionApproval(request: ExternalExecutionApproval): Promise<boolean> {
      ensureDir();
      return withFileLock(decisionsFile, function freezeRequest() {
        const records = readJsonLines<ExternalExecutionApproval>(decisionsFile).values;
        if (records.some(function sameRequest(record) { return record.recordType === "external_execution_request" && record.sessionId === request.sessionId && record.turnId === request.turnId && record.approvalId === request.approvalId; })) return false;
        appendJsonLine(decisionsFile, JSON.stringify(request));
        return true;
      });
    },

    /** 仅读取当前审批键的私有冻结请求，不经 transcript 公开目标。 */
    async getExecutionApproval(input) {
      ensureDir();
      return withFileLock(decisionsFile, function readRequest() {
        const records = readJsonLines<ExternalExecutionApproval>(decisionsFile).values;
        return records.find(function sameRequest(record) { return record.recordType === "external_execution_request" && record.sessionId === input.sessionId && record.turnId === input.turnId && record.approvalId === input.approvalId; }) ?? null;
      });
    },

    /** 同一文件锁内核验真实批准、当前约束、TTL及未消费状态，跨进程只成功一次。 */
    async consumeExecutionApproval(input) {
      ensureDir();
      return withFileLock(decisionsFile, function consumeRequest() {
        const records = readJsonLines<ApprovalDecision | ExternalExecutionApproval | { recordType: "external_execution_consumed"; sessionId: string; turnId: string; approvalId: string }>(decisionsFile).values;
        const matching = records.filter(function sameKey(record) { return record.sessionId === input.sessionId && record.turnId === input.turnId && record.approvalId === input.approvalId; });
        if (matching.some(function consumed(record) { return "recordType" in record && record.recordType === "external_execution_consumed"; })) return false;
        const request = matching.find(function frozen(record): record is ExternalExecutionApproval { return "recordType" in record && record.recordType === "external_execution_request"; });
        const decision = matching.find(function approved(record): record is ApprovalDecision { return !("recordType" in record); });
        if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
        if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
        appendJsonLine(decisionsFile, JSON.stringify({ recordType: "external_execution_consumed", sessionId: input.sessionId, turnId: input.turnId, approvalId: input.approvalId }));
        return true;
      });
    },

    /** Talk-Plan1013 Stage5 R2：文件审批冻结记录复用 decisions.jsonl；recordType 与 execution 记录区分。 */
    async saveFileApproval(request: ExternalFileApproval): Promise<boolean> {
      ensureDir();
      return withFileLock(decisionsFile, function freezeFileRequest() {
        const records = readJsonLines<ExternalFileApproval>(decisionsFile).values;
        if (records.some(function sameRequest(record) { return record.recordType === "external_file_request" && record.sessionId === request.sessionId && record.turnId === request.turnId && record.approvalId === request.approvalId; })) return false;
        appendJsonLine(decisionsFile, JSON.stringify(request));
        return true;
      });
    },

    /** 仅读取当前审批键的文件冻结记录，不与真实 decision 混淆。 */
    async getFileApproval(input) {
      ensureDir();
      return withFileLock(decisionsFile, function readFileRequest() {
        const records = readJsonLines<ExternalFileApproval>(decisionsFile).values;
        return records.find(function sameRequest(record) { return record.recordType === "external_file_request" && record.sessionId === input.sessionId && record.turnId === input.turnId && record.approvalId === input.approvalId; }) ?? null;
      });
    },

    /** 同一文件锁内核验真实批准、当前约束、TTL及未消费状态，跨进程只成功一次。 */
    async consumeFileApproval(input) {
      ensureDir();
      return withFileLock(decisionsFile, function consumeFileRequest() {
        const records = readJsonLines<ApprovalDecision | ExternalExecutionApproval | ExternalFileApproval | { recordType: "external_execution_consumed" | "external_file_consumed"; sessionId: string; turnId: string; approvalId: string }>(decisionsFile).values;
        const matching = records.filter(function sameKey(record) { return record.sessionId === input.sessionId && record.turnId === input.turnId && record.approvalId === input.approvalId; });
        if (matching.some(function consumed(record) { return "recordType" in record && record.recordType === "external_file_consumed"; })) return false;
        const request = matching.find(function frozen(record): record is ExternalFileApproval { return "recordType" in record && record.recordType === "external_file_request"; });
        const decision = matching.find(function approved(record): record is ApprovalDecision { return !("recordType" in record); });
        if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
        if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
        appendJsonLine(decisionsFile, JSON.stringify({ recordType: "external_file_consumed", sessionId: input.sessionId, turnId: input.turnId, approvalId: input.approvalId }));
        return true;
      });
    },

    /** R1：降级审批冻结记录复用 decisions.jsonl；recordType 与 execution/file 记录区分。 */
    async saveDegradeApproval(request: SandboxDegradeApproval): Promise<boolean> {
      ensureDir();
      return withFileLock(decisionsFile, function freezeDegradeRequest() {
        const records = readJsonLines<SandboxDegradeApproval>(decisionsFile).values;
        if (records.some(function sameRequest(record) { return record.recordType === "sandbox_degrade_request" && record.sessionId === request.sessionId && record.turnId === request.turnId && record.approvalId === request.approvalId; })) return false;
        appendJsonLine(decisionsFile, JSON.stringify(request));
        return true;
      });
    },

    /** R1：同一文件锁内核验真实批准、当前约束、TTL及未消费状态，跨进程只成功一次。 */
    async consumeDegradeApproval(input) {
      ensureDir();
      return withFileLock(decisionsFile, function consumeDegradeRequest() {
        const records = readJsonLines<ApprovalDecision | SandboxDegradeApproval | { recordType: "external_execution_consumed" | "external_file_consumed" | "sandbox_degrade_consumed"; sessionId: string; turnId: string; approvalId: string }>(decisionsFile).values;
        const matching = records.filter(function sameKey(record) { return record.sessionId === input.sessionId && record.turnId === input.turnId && record.approvalId === input.approvalId; });
        if (matching.some(function consumed(record) { return "recordType" in record && record.recordType === "sandbox_degrade_consumed"; })) return false;
        const request = matching.find(function frozen(record): record is SandboxDegradeApproval { return "recordType" in record && record.recordType === "sandbox_degrade_request"; });
        const decision = matching.find(function approved(record): record is ApprovalDecision { return !("recordType" in record); });
        if (request && decision && (decision.toolName !== request.toolName || decision.expiresAt !== request.expiresAt)) return false;
        if (!request || !decision || !["allow_once", "allow_session", "allow_workspace"].includes(decision.decision) || request.constraint !== input.constraint || decision.constraint !== input.constraint || request.callId !== input.callId || decision.callId !== input.callId || request.normalizedInputHash !== input.normalizedInputHash || decision.normalizedInputHash !== input.normalizedInputHash || !Number.isFinite(Date.parse(request.expiresAt)) || !Number.isFinite(Date.parse(input.now)) || Date.parse(request.expiresAt) <= Date.parse(input.now)) return false;
        appendJsonLine(decisionsFile, JSON.stringify({ recordType: "sandbox_degrade_consumed", sessionId: input.sessionId, turnId: input.turnId, approvalId: input.approvalId }));
        return true;
      });
    },

    async getDecision(input: Parameters<ApprovalStore["getDecision"]>[0]): Promise<ApprovalDecision | null> {
      ensureDir();
      return withFileLock(decisionsFile, () => {
        const decisions = readJsonLines<ApprovalDecision>(decisionsFile).values;
        for (let index = decisions.length - 1; index >= 0; index--) {
          const decision = decisions[index];
          if (!("recordType" in decision) && decision.sessionId === input.sessionId && decision.turnId === input.turnId && decision.approvalId === input.approvalId) {
            return decision;
          }
        }
        return null;
      });
    },

    /** 原子保存审批决策；跨进程重复提交只允许第一个 owner 成功。 */
    async saveDecision(decision: ApprovalDecision): Promise<boolean> {
      ensureDir();
      return withFileLock(decisionsFile, () => {
        const existing = readJsonLines<ApprovalDecision>(decisionsFile).values;
        if (existing.some((candidate) => !("recordType" in candidate) && candidate.sessionId === decision.sessionId && candidate.turnId === decision.turnId && candidate.approvalId === decision.approvalId)) return false;
        appendJsonLine(decisionsFile, JSON.stringify(decision));
        return true;
      });
    },

    async getPersistentGrant(input: Parameters<ApprovalStore["getPersistentGrant"]>[0]): Promise<PersistentGrant | null> {
      ensureDir();
      const workspaceRoot = canonicalizeNodePath(input.workspaceRoot);
      return withFileLock(grantsFile, () => {
        const grants = readJsonLines<PersistentGrant>(grantsFile).values;
        for (let index = grants.length - 1; index >= 0; index--) {
          const grant = grants[index];
          const workspaceMatches = grant.workspaceRoot
            ? canonicalizeNodePath(grant.workspaceRoot) === workspaceRoot
            : false;
          if (
            grant.toolName === input.toolName &&
            grant.constraint === input.constraint &&
            ((grant.scope === "allow_workspace" && workspaceMatches) ||
              (grant.scope === "allow_session" && grant.sessionId === input.sessionId))
          ) {
            return grant;
          }
        }
        return null;
      });
    },

    async savePersistentGrant(
      input: Omit<PersistentGrant, "createdAt"> & { createdAt: string },
    ): Promise<PersistentGrant> {
      ensureDir();
      if (input.scope !== "allow_session" && input.scope !== "allow_workspace") {
        throw new AgentRuntimeError(
          "INVALID_INPUT",
          `PersistentGrant scope 只能是 allow_session 或 allow_workspace，收到 ${input.scope}`,
        );
      }
      if (input.scope === "allow_session" && !input.sessionId) {
        throw new AgentRuntimeError("INVALID_INPUT", "allow_session 授权必须包含 sessionId");
      }
      if (input.scope === "allow_workspace" && !input.workspaceRoot) {
        throw new AgentRuntimeError("INVALID_INPUT", "allow_workspace 授权必须包含 workspaceRoot");
      }
      const grant: PersistentGrant = {
        ...input,
        workspaceRoot: input.workspaceRoot ? canonicalizeNodePath(input.workspaceRoot) : undefined,
      };
      await appendUniqueJsonLine(grantsFile, JSON.stringify(grant));
      return grant;
    },

    async deletePersistentGrant(input: Parameters<ApprovalStore["deletePersistentGrant"]>[0]): Promise<boolean> {
      ensureDir();
      const workspaceRoot = canonicalizeNodePath(input.workspaceRoot);
      return withFileLock(grantsFile, () => {
        const grants = readJsonLines<PersistentGrant>(grantsFile).values;
        let deleted = false;
        // Talk-Plan1013 Stage 2：精确匹配 allow_workspace（按 canonical workspace）或 allow_session
        //（按 sessionId），同工作区/同工具的其他约束不受影响。
        const remaining = grants.filter((grant) => {
          const matches = grant.toolName === input.toolName && grant.constraint === input.constraint
            && ((grant.scope === "allow_workspace" && grant.workspaceRoot && canonicalizeNodePath(grant.workspaceRoot) === workspaceRoot)
              || (grant.scope === "allow_session" && grant.sessionId === input.sessionId));
          if (matches) deleted = true;
          return !matches;
        });
        if (deleted) atomicReplace(grantsFile, remaining.map((grant) => JSON.stringify(grant)).join("\n") + (remaining.length ? "\n" : ""));
        return deleted;
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      await withFileLock(decisionsFile, () => {
        const remaining = readJsonLines<ApprovalDecision>(decisionsFile).values.filter((decision) => decision.sessionId !== sessionId);
        atomicReplace(decisionsFile, remaining.map((decision) => JSON.stringify(decision)).join("\n") + (remaining.length ? "\n" : ""));
      });
      await withFileLock(grantsFile, () => {
        const remaining = readJsonLines<PersistentGrant>(grantsFile).values.filter((grant) => !(grant.scope === "allow_session" && grant.sessionId === sessionId));
        atomicReplace(grantsFile, remaining.map((grant) => JSON.stringify(grant)).join("\n") + (remaining.length ? "\n" : ""));
      });
    },

    /** Talk-Plan1013 Stage 2：按 canonical workspace / sessionId 过滤列出授权。 */
    async listPersistentGrants(input: Parameters<ApprovalStore["listPersistentGrants"]>[0]): Promise<PersistentGrant[]> {
      ensureDir();
      const workspaceRoot = input.workspaceRoot !== undefined ? canonicalizeNodePath(input.workspaceRoot) : undefined;
      return withFileLock(grantsFile, () => {
        return readJsonLines<PersistentGrant>(grantsFile).values.filter((grant) => {
          if (workspaceRoot !== undefined && !(grant.workspaceRoot && canonicalizeNodePath(grant.workspaceRoot) === workspaceRoot)) return false;
          if (input.sessionId !== undefined && grant.sessionId !== input.sessionId) return false;
          return true;
        });
      });
    },

    /** Talk-Plan1013 Stage 2：锁内更新授权投影状态；先写 grant 后投影失败时由调用方回写 pending。 */
    async setGrantProjection(input: Parameters<ApprovalStore["setGrantProjection"]>[0]): Promise<PersistentGrant | null> {
      ensureDir();
      const workspaceRoot = canonicalizeNodePath(input.workspaceRoot);
      return withFileLock(grantsFile, () => {
        const grants = readJsonLines<PersistentGrant>(grantsFile).values;
        for (let index = grants.length - 1; index >= 0; index--) {
          const grant = grants[index]!;
          const matches = grant.toolName === input.toolName && grant.constraint === input.constraint
            && ((grant.scope === "allow_workspace" && grant.workspaceRoot && canonicalizeNodePath(grant.workspaceRoot) === workspaceRoot)
              || (grant.scope === "allow_session" && grant.sessionId === input.sessionId));
          if (!matches) continue;
          const updated: PersistentGrant = { ...grant, projection: input.projection };
          const rewritten = grants.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate);
          atomicReplace(grantsFile, rewritten.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n");
          return updated;
        }
        return null;
      });
    },
  };
}
