/**
 * runtime/application/approval-service.ts — 审批用例编排
 *
 * Phase 4 新增：把 Web `permission-store.ts` 中的审批与持久授权逻辑
 * 提升为跨端 Application Service，供 Web / CLI / Desktop 复用。
 */

import type { ApprovalStore, CheckpointStore, Clock, ExternalPermissionProjector, TranscriptStore, TurnStore } from "../ports";
import { TASK_EXTERNAL_FILE_SET_CONSTRAINT, TASK_FILE_SET_CONSTRAINT, isExternalTaskFileSetConstraint, isTaskFileSetConstraint, type ApprovalDecision, type PersistentGrant, type SubmitApprovalInput } from "../domain/approval";
import { AgentRuntimeError } from "../protocol";
import { externalRuleCoversRule, formatExternalFileRule, isExternalFileConstraint, classifyExternalRestriction, normalizeComparablePath } from "../domain/external-permissions";
import type { ExternalFileApproval } from "../domain/external-permissions";
import { computeExternalExecutionConstraint, isExternalExecutionConstraint, matchesExternalExecutionTarget, type ExternalExecutionAuthorization } from "../domain/external-execution";
import { isNoSandboxExecConstraint, type SandboxDegradeApproval } from "../domain/sandbox-policy";
import { resolveExternalExecutionTarget, sealExternalExecutionAuthorization } from "../../internal/tools/permissions/external-execution-policy";
import type { ExternalExecutionAuthority } from "../../internal/tools/types";
import { hashNormalizedToolInput } from "../../internal/tools/normalized-tool-input";
import { runCommandSchema } from "../../internal/tools/builtins/run-command-tool";
import { startBackgroundJobSchema } from "../../internal/tools/builtins/start-background-job-tool";

/** ApprovalService 所需的 Runtime-owned 状态端口；宿主不参与冻结凭证解析。 */
export interface ApprovalServiceDependencies {
  approvalStore: ApprovalStore;
  checkpointStore: CheckpointStore;
  transcriptStore: TranscriptStore;
  turnStore: TurnStore;
  clock: Clock;
  /** Talk-Plan1013 Stage 2：外部规则投影；缺省时 allow_workspace 外部授权保持 pending 不自动放行。 */
  externalRuleProjector?: ExternalPermissionProjector;
}

/** 撤销持久授权的结果；ruleRemoved=false 表示投影规则仍残留（orphan，按待批准声明展示）。 */
export interface RevokePersistentGrantResult {
  deleted: boolean;
  ruleRemoved: boolean;
}

/** ApprovalService 接口。 */
export interface ApprovalService {
  /**
   * 提交用户对审批请求的四字段决定；Runtime 从当前 checkpoint/transcript 解析并
   * 校验 callId、toolName、normalizedInputHash 与持久授权约束。
   */
  submit(input: SubmitApprovalInput): Promise<ApprovalDecision>;

  /** 查询指定审批决策。 */
  getDecision(input: { sessionId: string; turnId: string; approvalId: string }): Promise<ApprovalDecision | null>;

  /** 查询持久授权是否命中。 */
  hasPersistentGrant(input: { workspaceRoot: string; sessionId: string; toolName: string; constraint: string }): Promise<boolean>;

  /** Talk-Plan1013 Stage 2：列出持久授权（可按 workspace/session 过滤），供宿主展示。 */
  listPersistentGrants(input?: { workspaceRoot?: string; sessionId?: string }): Promise<PersistentGrant[]>;

  /** Talk-Plan1013 Stage 2：精确撤销一条持久授权；外部授权同时尽力移除投影规则。 */
  revokePersistentGrant(input: { workspaceRoot: string; sessionId: string; toolName: string; constraint: string }): Promise<RevokePersistentGrantResult>;
}

/** 仅Turn应用层持有的签发桥接，不添加到公开Runtime approvals门面。 */
export interface InternalApprovalService extends ApprovalService {
  freezeExecutionApproval(input: { sessionId: string; turnId: string; workspaceRoot: string } & Parameters<ExternalExecutionAuthority["freeze"]>[0]): Promise<void>;
  authorizeExecution(input: { sessionId: string; turnId: string; workspaceRoot: string } & Parameters<ExternalExecutionAuthority["authorize"]>[0]): Promise<ExternalExecutionAuthorization | null>;
  /** Talk-Plan1013 Stage5 R5：当前外部限制判定（allow/ask/deny）；唯一来源为 projector 快照，不新建第二套规则。 */
  resolveExternalRestriction(input: { workspaceRoot: string; toolName: string; constraint: string }): Promise<"allow" | "ask" | "deny">;
  /** Talk-Plan1013 Stage5 R2：文件审批持久一次消费；存储底座缺失时 fail-closed。 */
  consumeFileApproval(input: { sessionId: string; turnId: string; approvalId: string; constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean>;
  /** R1：沙箱降级审批持久一次消费；存储底座缺失时 fail-closed。 */
  consumeDegradeApproval(input: { sessionId: string; turnId: string; approvalId: string; constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean>;
  /**
   * 任务文件集合成员检查：write/edit 逐调用核对目标与操作是否在当前 Turn 已批准集合内。
   * 集合 grant 绑定 turnId，跨 Turn 自然失效；未命中即返回 false，回到既有逐次审批。
   */
  hasTaskFileSetGrant(input: { sessionId: string; turnId: string; workspaceRoot: string; path: string; operation: "create" | "edit" }): Promise<boolean>;
  /**
   * 外部文件集合成员检查（2.4 第 4 项）：write/edit 对工作区外目标逐调用核对 canonical
   * 绝对路径与操作是否在当前 Turn 已批准外部集合内；比较经 comparable 归一（Windows
   * 大小写/分隔符不敏感），只匹配精确文件，不含父目录与递归语义。
   */
  hasExternalTaskFileSetGrant(input: { sessionId: string; turnId: string; workspaceRoot: string; canonicalTarget: string; operation: "create" | "edit" }): Promise<boolean>;
}

/** 创建 ApprovalService 实例。 */
export function createApprovalService(dependencies: ApprovalServiceDependencies): InternalApprovalService {
  return {
    freezeExecutionApproval,
    authorizeExecution,
    resolveExternalRestriction,
    consumeFileApproval,
    consumeDegradeApproval,
    hasTaskFileSetGrant,
    hasExternalTaskFileSetGrant,
    submit,
    getDecision,
    hasPersistentGrant,
    listPersistentGrants,
    revokePersistentGrant,
  };

  async function submit(
    input: SubmitApprovalInput,
  ): Promise<ApprovalDecision> {
    if (!isApprovalDecision(input.decision)) {
      throw new AgentRuntimeError("INVALID_INPUT", "Invalid approval decision");
    }
    const existing = await dependencies.approvalStore.getDecision(input);
    if (existing) {
      throw new AgentRuntimeError("APPROVAL_ALREADY_SUBMITTED", `审批 ${input.approvalId} 已经提交过决定`);
    }

    const checkpoint = await dependencies.checkpointStore.getLatest(input.sessionId);
    if (!checkpoint || checkpoint.turnId !== input.turnId || checkpoint.status !== "awaiting_approval") {
      throw new AgentRuntimeError("APPROVAL_NOT_FOUND", "当前 turn 没有可提交的审批");
    }

    const approvalEvent = await findApprovalEvent(dependencies.transcriptStore, input.sessionId, input.turnId, input.approvalId);
    if (!approvalEvent) {
      throw new AgentRuntimeError("APPROVAL_NOT_FOUND", "审批不存在、已失效或不属于当前 turn");
    }

    const approval = approvalEvent.result.approval;
    const execution = isExternalExecutionConstraint(approval.constraint) ? await dependencies.approvalStore.getExecutionApproval?.({ sessionId: input.sessionId, turnId: input.turnId, approvalId: input.approvalId }) : undefined;
    if (isExternalExecutionConstraint(approval.constraint) && (!execution || execution.constraint !== approval.constraint || execution.callId !== approval.callId || execution.toolName !== approval.toolName || execution.normalizedInputHash !== approval.normalizedInputHash || execution.expiresAt !== approval.expiresAt || !matchesExternalExecutionTarget(approval.toolName, approval.constraint!, execution.target))) throw new AgentRuntimeError("APPROVAL_MISMATCH", "缺少匹配的私有外部执行冻结事实");
    if (approval.callId !== approvalEvent.callId || approval.toolName !== approvalEvent.toolName) {
      throw new AgentRuntimeError("APPROVAL_MISMATCH", "审批冻结凭证与当前事件不一致");
    }

    // Talk-Plan1013 Stage 2（Plan 16.5）：跨进程恢复路径同样校验审批有效期；
    // 内存执行路径早已校验，这里补齐宿主 submit 的权威入口。旧事件缺少 expiresAt 时跳过（兼容）。
    const expiresAtMs = Date.parse(approval.expiresAt);
    if ((execution && !Number.isFinite(expiresAtMs)) || (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.parse(dependencies.clock.timestamp()))) {
      throw new AgentRuntimeError("APPROVAL_NOT_FOUND", "审批已过期，请重新发起操作");
    }

    const turn = await dependencies.turnStore.get(input.turnId);
    if (!turn || turn.sessionId !== input.sessionId) {
      throw new AgentRuntimeError("TURN_NOT_FOUND", `Turn ${input.turnId} 不存在`);
    }
    if (execution && turn.frozenRunConfig.workspaceRoot !== execution.target.canonicalWorkspace) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行请求不属于当前冻结工作区");
    if (execution) {
      const pending = checkpoint.pendingCalls?.find(function pendingExecution(call) { return call.id === execution.callId && call.name === execution.toolName; });
      const parsed = parseExecutionInput(execution.toolName, pending?.input);
      const currentTarget = await resolveExternalExecutionTarget(execution.target.canonicalWorkspace, parsed);
      if (!currentTarget || hashNormalizedToolInput(parsed) !== execution.normalizedInputHash || computeExternalExecutionConstraint(execution.toolName, currentTarget) !== execution.constraint) throw new AgentRuntimeError("APPROVAL_MISMATCH", "审批提交时目标或输入已经改变");
    }
    // 旧事件缺少冻结范围时 fail closed：只允许一次性决定，绝不把历史数据升级为持久 grant。
    const allowedDecisions = approval.allowedDecisions ?? ["allow_once", "deny"];
    if (!allowedDecisions.includes(input.decision)) {
      throw new AgentRuntimeError("INVALID_INPUT", "当前冻结 Policy 不允许提交该审批范围");
    }
    if (input.decision === "allow_workspace" && !turn.frozenRunConfig.workspaceRoot) {
      throw new AgentRuntimeError("APPROVAL_MISMATCH", "allow_workspace 缺少 Runtime 冻结的 workspaceRoot");
    }

    const now = dependencies.clock.timestamp();
    // Talk-Plan1013 Stage5 R2：外部文件审批落存可验证冻结身份与 TTL，复用 external_execution_request
    // 的同一存储底座（decisions.jsonl + withFileLock），独立 recordType 不与 execution 记录混淆。
    const fileConstraint = isExternalFileConstraint(approval.constraint) ? approval.constraint : undefined;
    if (fileConstraint) {
      const frozen: ExternalFileApproval = {
        recordType: "external_file_request",
        sessionId: input.sessionId,
        turnId: input.turnId,
        approvalId: input.approvalId,
        callId: approvalEvent.callId,
        toolName: approvalEvent.toolName,
        normalizedInputHash: approval.normalizedInputHash,
        constraint: fileConstraint,
        expiresAt: approval.expiresAt,
      };
      if (!Number.isFinite(Date.parse(frozen.expiresAt)) || !(await dependencies.approvalStore.saveFileApproval?.(frozen))) {
        throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部文件审批缺少有效 TTL 或无法冻结身份");
      }
    }
    // R1：降级（无沙箱直执）审批同样落存可验证冻结身份与 TTL，复用同一授权存储底座、
    // 独立 recordType；decision 携带 constraint 后，恢复路径能区分降级批准与普通批准，
    // 并经 consumeDegradeApproval 持久原子一次消费，崩溃窗口重放不得再次直执。
    const degradeConstraint = isNoSandboxExecConstraint(approval.constraint) ? approval.constraint : undefined;
    if (degradeConstraint) {
      const frozen: SandboxDegradeApproval = {
        recordType: "sandbox_degrade_request",
        sessionId: input.sessionId,
        turnId: input.turnId,
        approvalId: input.approvalId,
        callId: approvalEvent.callId,
        toolName: approvalEvent.toolName,
        normalizedInputHash: approval.normalizedInputHash,
        constraint: degradeConstraint,
        expiresAt: approval.expiresAt,
      };
      if (!Number.isFinite(Date.parse(frozen.expiresAt)) || !(await dependencies.approvalStore.saveDegradeApproval?.(frozen))) {
        throw new AgentRuntimeError("APPROVAL_MISMATCH", "降级审批缺少有效 TTL 或无法冻结身份");
      }
    }
    const approvalDecision: ApprovalDecision = {
      approvalId: input.approvalId,
      turnId: input.turnId,
      sessionId: input.sessionId,
      callId: approvalEvent.callId,
      toolName: approvalEvent.toolName,
      normalizedInputHash: approval.normalizedInputHash,
      // 文件审批与 ext-exec 对称：decision 同样携带 constraint/expiresAt，供恢复路径核对与持久消费。
      // R1：降级审批同样携带，恢复时区分无沙箱批准与普通批准并复核 TTL。
      ...(execution
        ? { constraint: execution.constraint, expiresAt: execution.expiresAt }
        : fileConstraint || degradeConstraint ? { constraint: fileConstraint ?? degradeConstraint, expiresAt: approval.expiresAt } : {}),
      decision: input.decision,
      createdAt: now,
    };
    const saved = await dependencies.approvalStore.saveDecision(approvalDecision);
    if (!saved) {
      throw new AgentRuntimeError("APPROVAL_ALREADY_SUBMITTED", `审批 ${input.approvalId} 已经提交过决定`);
    }

    // 任务文件集合审批（工作区 task-files:v1 与外部 task-ext-files:v1）：allow_once 语义即
    // "批准本任务文件集合"；保存 Turn 绑定的集合 grant。同一 Turn 内的增量声明与既有集合
    // 合并（path+operation 去重），新 Turn 的声明整体替换旧集合。
    if (input.decision === "allow_once" && (isTaskFileSetConstraint(approval.constraint) || isExternalTaskFileSetConstraint(approval.constraint))) {
      const setConstraint = isExternalTaskFileSetConstraint(approval.constraint) ? TASK_EXTERNAL_FILE_SET_CONSTRAINT : TASK_FILE_SET_CONSTRAINT;
      const declared = approval.taskFileSet;
      if (!declared?.length) throw new AgentRuntimeError("APPROVAL_MISMATCH", "任务文件集合审批缺少冻结清单");
      const existing = await dependencies.approvalStore.getPersistentGrant({
        workspaceRoot: turn.frozenRunConfig.workspaceRoot ?? "",
        sessionId: input.sessionId,
        toolName: approvalEvent.toolName,
        constraint: setConstraint,
      });
      const merged = new Map<string, { path: string; operation: "create" | "edit" }>();
      for (const entry of existing?.turnId === input.turnId ? existing.taskFiles ?? [] : []) merged.set(`${entry.operation}:${entry.path}`, entry);
      for (const entry of declared) merged.set(`${entry.operation}:${entry.path}`, entry);
      await dependencies.approvalStore.savePersistentGrant({
        scope: "allow_session",
        sessionId: input.sessionId,
        toolName: approvalEvent.toolName,
        constraint: setConstraint,
        turnId: input.turnId,
        taskFiles: [...merged.values()],
        risk: approval.risk,
        createdAt: now,
      });
      return approvalDecision;
    }

    if (input.decision === "allow_session" || input.decision === "allow_workspace") {
      const constraint = approval.constraint ?? approval.normalizedInputHash;
      // Talk-Plan1013 Stage 2（Plan 16.4）：外部修改的 allow_workspace 走"先 grant 后投影"。
      // 投影失败不回滚批准：grant 标记 pending，双边不一致时不自动放行（fail-safe），
      // 返回的 projection 字段让宿主区分"批准成功"与"记住失败"。
      if (input.decision === "allow_workspace" && (isExternalFileConstraint(constraint) || execution)) {
        const workspaceRoot = turn.frozenRunConfig.workspaceRoot!;
        const externalRule = execution ? `Write(${execution.target.canonicalTarget})` : formatExternalFileRule(approvalEvent.toolName, constraint);
        await dependencies.approvalStore.savePersistentGrant({
          scope: "allow_workspace",
          workspaceRoot,
          toolName: approvalEvent.toolName,
          constraint,
          risk: approval.risk,
          externalRule,
          ...(execution ? { executionTarget: execution.target } : {}),
          projection: "pending",
          createdAt: now,
        });
        const projector = dependencies.externalRuleProjector;
        if (projector) {
          try {
            await projector.project({ workspaceRoot, rule: externalRule, action: "add" });
            await dependencies.approvalStore.setGrantProjection({ workspaceRoot, sessionId: input.sessionId, toolName: approvalEvent.toolName, constraint, projection: "synced" });
            approvalDecision.projection = "synced";
          } catch {
            approvalDecision.projection = "pending";
          }
        } else {
          approvalDecision.projection = "pending";
        }
        return approvalDecision;
      }
      await dependencies.approvalStore.savePersistentGrant({
        scope: input.decision,
        workspaceRoot: input.decision === "allow_workspace" ? turn.frozenRunConfig.workspaceRoot : undefined,
        sessionId: input.decision === "allow_session" ? input.sessionId : undefined,
        toolName: approvalEvent.toolName,
        // 旧审批事件没有稳定约束时回退 hash；新工具会传 path/program constraint。
        constraint,
        ...(execution ? { executionTarget: execution.target, externalRule: `Write(${execution.target.canonicalTarget})` } : {}),
        risk: approval.risk,
        createdAt: now,
      });
    }

    return approvalDecision;
  }

  /** 当前外部限制判定：deny 并集优先，ask 次之；非外部约束或缺投影器时按 allow（无已知限制）。快照匹配复用 domain 共享纯函数。 */
  async function resolveExternalRestriction(input: { workspaceRoot: string; toolName: string; constraint: string }): Promise<"allow" | "ask" | "deny"> {
    if (!isExternalFileConstraint(input.constraint)) return "allow";
    const projector = dependencies.externalRuleProjector;
    if (!projector) return "allow";
    return classifyExternalRestriction(await projector.read(input.workspaceRoot), input.toolName, input.constraint);
  }

  /** 文件审批持久一次消费；约束/身份/TTL 与未消费状态由存储锁内核验，本层不重复判定。 */
  async function consumeFileApproval(input: { sessionId: string; turnId: string; approvalId: string; constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean> {
    if (!dependencies.approvalStore.consumeFileApproval) return false;
    return dependencies.approvalStore.consumeFileApproval(input);
  }

  /** R1：降级审批持久一次消费；约束/身份/TTL 与未消费状态由存储锁内核验，本层不重复判定。 */
  async function consumeDegradeApproval(input: { sessionId: string; turnId: string; approvalId: string; constraint: string; callId: string; normalizedInputHash: string; now: string }): Promise<boolean> {
    if (!dependencies.approvalStore.consumeDegradeApproval) return false;
    return dependencies.approvalStore.consumeDegradeApproval(input);
  }

  async function getDecision(input: { sessionId: string; turnId: string; approvalId: string }): Promise<ApprovalDecision | null> {
    return dependencies.approvalStore.getDecision(input);
  }

  async function hasPersistentGrant(input: { workspaceRoot: string; sessionId: string; toolName: string; constraint: string }): Promise<boolean> {
    const grant = await dependencies.approvalStore.getPersistentGrant(input);
    if (!grant) return false;
    // Talk-Plan1013 Stage 2（Plan 16.4）：非外部约束沿用既有语义（真实审批凭证即权威）。
    if (!isExternalFileConstraint(input.constraint) && !isExternalExecutionConstraint(input.constraint)) return true;
    if (isExternalExecutionConstraint(input.constraint) && (!matchesExternalExecutionTarget(input.toolName, input.constraint, grant.executionTarget) || grant.externalRule !== `Write(${grant.executionTarget?.canonicalTarget})`)) return false;
    // 外部 grant 的所有 lifetime 均读取最新收窄；缺失投影器不能证明当前 deny/ask。
    const projector = dependencies.externalRuleProjector;
    if (!projector) return false;
    const snapshot = await projector.read(input.workspaceRoot);
    // 快照无法完整解释 deny/ask 时不能证明收窄范围，任何持久放行都不成立（fail-closed）。
    if (snapshot.restricted === true) return false;
    const rule = isExternalExecutionConstraint(input.constraint) ? grant.externalRule! : formatExternalFileRule(input.toolName, input.constraint);
    if ([...snapshot.deny, ...(snapshot.ask ?? [])].some((restriction) => externalRuleCoversRule(restriction, rule))) return false;
    if (grant.scope === "allow_session") return true;
    // allow_workspace 外部授权必须双边一致：grant synced 且 local 投影 allow 含同一规则；
    // orphan rule（无 grant）与 pending grant（无投影）都不放行。deny 并集始终收窄。
    if (grant.projection !== "synced" || !grant.externalRule) return false;
    return snapshot.allow.includes(grant.externalRule);
  }

  /** 任务文件集合成员检查：集合 grant 必须属于当前 Turn，且 path 与声明操作精确匹配；其余一律回到逐次审批。 */
  async function hasTaskFileSetGrant(input: { sessionId: string; turnId: string; workspaceRoot: string; path: string; operation: "create" | "edit" }): Promise<boolean> {
    const grant = await dependencies.approvalStore.getPersistentGrant({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      toolName: "todo_write",
      constraint: TASK_FILE_SET_CONSTRAINT,
    });
    if (!grant || grant.turnId !== input.turnId || !grant.taskFiles?.length) return false;
    return grant.taskFiles.some((entry) => entry.path === input.path && entry.operation === input.operation);
  }

  /**
   * 外部文件集合成员检查（2.4 第 4 项）：与工作区集合同一 Turn 绑定与操作绑定语义，
   * 但比较经 comparable 归一（Windows 大小写/分隔符不敏感）；只匹配精确 canonical 文件，
   * 无父目录与递归语义；跨 Turn 与非成员一律回到既有逐次审批。
   */
  async function hasExternalTaskFileSetGrant(input: { sessionId: string; turnId: string; workspaceRoot: string; canonicalTarget: string; operation: "create" | "edit" }): Promise<boolean> {
    const grant = await dependencies.approvalStore.getPersistentGrant({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      toolName: "todo_write",
      constraint: TASK_EXTERNAL_FILE_SET_CONSTRAINT,
    });
    if (!grant || grant.turnId !== input.turnId || !grant.taskFiles?.length) return false;
    const requested = normalizeComparablePath(input.canonicalTarget);
    return grant.taskFiles.some((entry) => normalizeComparablePath(entry.path) === requested && entry.operation === input.operation);
  }

  async function listPersistentGrants(input: { workspaceRoot?: string; sessionId?: string } = {}): Promise<PersistentGrant[]> {
    const grants = await dependencies.approvalStore.listPersistentGrants(input);
    return grants.map(function safeGrant(grant) {
      if (!isExternalExecutionConstraint(grant.constraint)) return grant;
      const safe = { ...grant };
      delete safe.executionTarget;
      delete safe.externalRule;
      return safe;
    });
  }

  async function revokePersistentGrant(input: { workspaceRoot: string; sessionId: string; toolName: string; constraint: string }): Promise<RevokePersistentGrantResult> {
    // 删顺序（Plan 16.4）：先删 grant（权威），后删投影规则；残留 orphan 规则无 grant 不放行。
    const grant = isExternalExecutionConstraint(input.constraint) ? await dependencies.approvalStore.getPersistentGrant(input) : null;
    const deleted = await dependencies.approvalStore.deletePersistentGrant(input);
    if (!deleted || (!isExternalFileConstraint(input.constraint) && !isExternalExecutionConstraint(input.constraint)) || !dependencies.externalRuleProjector) {
      return { deleted, ruleRemoved: false };
    }
    try {
      await dependencies.externalRuleProjector.project({
        workspaceRoot: input.workspaceRoot,
        rule: isExternalExecutionConstraint(input.constraint) ? grant?.externalRule ?? "" : formatExternalFileRule(input.toolName, input.constraint),
        action: "remove",
      });
      return { deleted, ruleRemoved: true };
    } catch {
      return { deleted, ruleRemoved: false };
    }
  }

  /** 从原输入重新预检，并冻结 Core 私有身份；端口缺失不能降级为普通审批。 */
  async function freezeExecutionApproval(input: { sessionId: string; turnId: string; workspaceRoot: string } & Parameters<ExternalExecutionAuthority["freeze"]>[0]): Promise<void> {
    const approval = input.approval;
    const parsed = parseExecutionInput(approval.toolName, input.input);
    const target = await resolveExternalExecutionTarget(input.workspaceRoot, parsed);
    if (!target || hashNormalizedToolInput(parsed) !== approval.normalizedInputHash || !matchesExternalExecutionTarget(approval.toolName, approval.constraint ?? "", target) || !Number.isFinite(Date.parse(approval.expiresAt)) || !dependencies.approvalStore.saveExecutionApproval) throw new AgentRuntimeError("APPROVAL_MISMATCH", "无法冻结外部执行身份");
    const saved = await dependencies.approvalStore.saveExecutionApproval({ recordType: "external_execution_request", sessionId: input.sessionId, turnId: input.turnId, approvalId: approval.approvalId, callId: approval.callId, toolName: approval.toolName, normalizedInputHash: approval.normalizedInputHash, constraint: approval.constraint!, expiresAt: approval.expiresAt, target });
    if (!saved) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行审批已冻结");
  }

  /** 当前目标重验、grant双边收窄或真实批准一次消费；旧validator boolean不参与签发。 */
  async function authorizeExecution(input: { sessionId: string; turnId: string; workspaceRoot: string } & Parameters<ExternalExecutionAuthority["authorize"]>[0]): Promise<ExternalExecutionAuthorization | null> {
    const parsed = parseExecutionInput(input.toolName, input.input);
    const target = await resolveExternalExecutionTarget(input.workspaceRoot, parsed);
    if (!target || hashNormalizedToolInput(parsed) !== input.inputHash || !matchesExternalExecutionTarget(input.toolName, input.constraint, target)) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行目标身份已改变");
    const query = { workspaceRoot: target.canonicalWorkspace, sessionId: input.sessionId, toolName: input.toolName, constraint: input.constraint };
    if (!input.approval) {
      if (!await hasPersistentGrant(query)) return null;
      const grant = await dependencies.approvalStore.getPersistentGrant(query);
      return grant ? sealExternalExecutionAuthorization({ lifetime: grant.scope, sessionId: input.sessionId, canonicalWorkspace: target.canonicalWorkspace }) : null;
    }
    if (input.approval.decision === "deny") return null;
    const key = { sessionId: input.sessionId, turnId: input.turnId, approvalId: input.approval.approvalId };
    const frozen = await dependencies.approvalStore.getExecutionApproval?.(key);
    const decision = await dependencies.approvalStore.getDecision(key);
    if (!frozen || !decision || decision.decision === "deny" || frozen.toolName !== input.toolName || frozen.callId !== input.callId || frozen.normalizedInputHash !== input.inputHash || frozen.constraint !== input.constraint || decision.constraint !== input.constraint || !matchesExternalExecutionTarget(input.toolName, input.constraint, frozen.target) || !Number.isFinite(Date.parse(frozen.expiresAt)) || Date.parse(frozen.expiresAt) <= Date.parse(dependencies.clock.timestamp())) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行批准缺失、过期或与当前调用不匹配");
    const projector = dependencies.externalRuleProjector;
    if (!projector) throw new AgentRuntimeError("APPROVAL_MISMATCH", "无法核验最新外部写限制");
    const snapshot = await projector.read(target.canonicalWorkspace);
    if (snapshot.deny.some(function denied(rule) { return externalRuleCoversRule(rule, `Write(${target.canonicalTarget})`); })) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部写目标已被拒绝");
    if (decision.decision !== "allow_once") {
      const grant = await dependencies.approvalStore.getPersistentGrant(query);
      if (!grant || !matchesExternalExecutionTarget(input.toolName, input.constraint, grant.executionTarget) || grant.externalRule !== `Write(${target.canonicalTarget})` || (grant.scope === "allow_workspace" && grant.projection === "synced" && !snapshot.allow.includes(grant.externalRule))) throw new AgentRuntimeError("APPROVAL_MISMATCH", "持久批准已撤销或记住规则已删除，旧审批不能复活权限");
    }
    const consumed = await dependencies.approvalStore.consumeExecutionApproval?.({ ...key, constraint: input.constraint, callId: input.callId, normalizedInputHash: input.inputHash, now: dependencies.clock.timestamp() });
    if (!consumed) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行批准已消费或不可验证");
    return sealExternalExecutionAuthorization({ lifetime: decision.decision, sessionId: input.sessionId, canonicalWorkspace: target.canonicalWorkspace, approvalId: frozen.approvalId, expiresAt: frozen.expiresAt });
  }
}

/** 审批恢复与工具执行使用同一严格schema，缺字段按原default处理，未知主体拒绝。 */
function parseExecutionInput(toolName: string, input: unknown): unknown {
  const schema = toolName === "run_command" ? runCommandSchema : toolName === "start_background_job" ? startBackgroundJobSchema : undefined;
  const parsed = schema?.safeParse(input);
  if (!parsed?.success) throw new AgentRuntimeError("APPROVAL_MISMATCH", "外部执行输入不符合原工具schema");
  return parsed.data;
}

/** 从 Runtime transcript 中定位审批事件；完整冻结字段只在 Core 内部使用。 */
async function findApprovalEvent(
  transcriptStore: TranscriptStore,
  sessionId: string,
  turnId: string,
  approvalId: string,
): Promise<Extract<import("../protocol").AgentEvent, { type: "approval_required" }> | null> {
  const events = await transcriptStore.getEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "approval_required" && event.turnId === turnId && event.result.approval.approvalId === approvalId) return event;
  }
  return null;
}

/** 妫€鏌ュ鎵规彁浜ょ殑 decision 鏄惁灞炰簬瀹夸富鍏紑鍗忚銆?*/
function isApprovalDecision(value: unknown): value is SubmitApprovalInput["decision"] {
  return value === "allow_once" || value === "allow_session" || value === "allow_workspace" || value === "deny";
}
