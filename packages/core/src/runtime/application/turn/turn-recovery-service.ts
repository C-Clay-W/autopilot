/**
 * runtime/application/turn/turn-recovery-service.ts — Turn 恢复与公开状态视图
 *
 * 负责从 durable Turn、checkpoint 与 transcript 构建脱敏状态视图，并统一 continue 前的
 * stale lease、Turn 与 checkpoint 校验；不执行模型、修改事件序号或管理 lease 生命周期。
 */

import { getWorkHistoryRestriction } from "./work-history-boundary";
import { projectPublicContextUsage, type ContextUsageView } from "../../../internal/kernel/context-budget";
import type { AgentCheckpoint, AgentEventEnvelope, FrozenRunConfigView, PublicCheckpointView, RecoverableTurnView } from "../../protocol";
import { AgentRuntimeError as RuntimeError } from "../../protocol";
import { sanitizeCheckpoint, sanitizeEventForExternal } from "../../protocol/sanitize-checkpoint";
import { sanitizeAgentTerminationView } from "../../protocol/recoverable-turn-view";
import { migrateAgentMessages } from "../../protocol/migrate-agent-messages";
import { createAgentToolResultMessage, getAgentToolCalls, scanAgentToolPairing, validateAgentMessages } from "../../../internal/types/agent-message";
import { serializeToolResultForModel } from "../../../internal/tool-scheduler";
import { createSyntheticToolErrorResult } from "../../../internal/tools/synthetic-tool-result";
import type { FrozenRunConfig, Turn } from "../../domain";
import type { RuntimePorts } from "../../ports";
import { SANDBOX_POLICY_VERSION } from "../../domain/sandbox-policy";
import { STALE_AGENT_LEASE_MS } from "./turn-lease-coordinator";
import type { TurnLeaseCoordinator } from "./turn-lease-coordinator";

/** 旧 resolver 写入 FrozenRunConfig 的累计 token 默认值。 */
const LEGACY_DEFAULT_MAX_TOTAL_TOKENS = 2_000_000;
/** 当前累计安全预算语义版本。 */
const SAFETY_BUDGET_VERSION = 2;

/** Runtime 对外暴露的 Turn 状态快照；宿主不再直接读取 checkpoint Port。 */
export interface TurnState {
  /** 旧知识来源未验证时只能展示历史，不能重新采样。 */
  readOnlyReason?: "WORK_HISTORY_READ_ONLY";
  turn: Turn | null;
  checkpoint: PublicCheckpointView | null;
  events: AgentEventEnvelope[];
}

/** Continue 前已确认可恢复的 durable 状态。 */
export interface RecoverableContinuation {
  turn: Turn;
  checkpoint: AgentCheckpoint;
}

/** Turn 恢复服务的内部职责。 */
export interface TurnRecoveryService {
  getState(input: { sessionId: string; turnId?: string }): Promise<TurnState>;
  getRecoverableState(input: { sessionId: string; turnId?: string }): Promise<RecoverableTurnView | null>;
  getFrozenRunConfig(input: { sessionId: string; turnId?: string }): Promise<FrozenRunConfigView | null>;
  /** 只读返回最新私有 checkpoint 的安全 Context Usage 快照；无数据时为 null。 */
  getContextUsage(input: { sessionId: string; turnId?: string }): Promise<ContextUsageView | null>;
  getContinuation(sessionId: string, turnId: string | undefined): Promise<RecoverableContinuation>;
}

/** 判断 checkpoint 状态是否允许通过同一 Turn 的 durable 状态继续执行。 */
function isContinuableStatus(status: AgentCheckpoint["status"]): boolean {
  return status === "awaiting_approval"
    || status === "awaiting_user_input"
    || status === "interrupted"
    || status === "interrupted_recoverable"
    || status === "limit_reached";
}

/** 判断崩溃/中断后的未闭合调用是否必须先以未知结果安全闭合。 */
function mustCloseInterruptedCalls(status: AgentCheckpoint["status"]): boolean {
  return status === "interrupted" || status === "interrupted_recoverable" || status === "limit_reached";
}

/** 纯计算旧 token 安全预算迁移，供恢复视图预判与 Continue 持久化共用。 */
function assessSafetyBudgetMigration(turn: Turn, checkpoint: AgentCheckpoint): {
  frozenRunConfig: FrozenRunConfig;
  explicitLimit?: number;
  terminalizeCheckpoint: boolean;
  checkpointNeedsSave: boolean;
  turnNeedsSave: boolean;
} {
  let frozenRunConfig = turn.frozenRunConfig;
  if (frozenRunConfig.safetyBudgetVersion !== SAFETY_BUDGET_VERSION) {
    const legacyMaxTotalTokens = frozenRunConfig.maxTotalTokens;
    const { maxTotalTokens: _legacyMaxTotalTokens, ...legacyWithoutTokenBudget } = frozenRunConfig;
    const hasExplicitLegacyLimit = Number.isSafeInteger(legacyMaxTotalTokens)
      && (legacyMaxTotalTokens ?? 0) > 0
      && legacyMaxTotalTokens !== LEGACY_DEFAULT_MAX_TOTAL_TOKENS;
    frozenRunConfig = {
      ...legacyWithoutTokenBudget,
      safetyBudgetVersion: SAFETY_BUDGET_VERSION,
      ...(hasExplicitLegacyLimit ? { maxTotalTokens: legacyMaxTotalTokens } : {}),
    };
  }

  // 沙箱迁移与 token 预算同一幂等范式：版本缺省视为旧记录，纯函数计算迁移，
  // 只在需要时重写 durable，重跑结果不变。无沙箱历史的旧记录恢复后 fail-safe
  // 迁移为 read-only（不可继承宽能力）；需要更多能力时以新 Turn 显式启动。
  if (frozenRunConfig.sandboxPolicyVersion !== SANDBOX_POLICY_VERSION) {
    frozenRunConfig = {
      ...frozenRunConfig,
      sandboxMode: frozenRunConfig.sandboxMode ?? "read-only",
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
    };
  }

  const explicitLimit = frozenRunConfig.maxTotalTokens;
  const tokenBudgetExhausted = explicitLimit !== undefined
    && (checkpoint.interruptionReason === "token_budget" || (checkpoint.runtimeBudget?.totalTokens ?? 0) >= explicitLimit);
  const terminalizeCheckpoint = isContinuableStatus(checkpoint.status) && tokenBudgetExhausted;
  const checkpointNeedsSave = checkpoint.safetyBudgetVersion !== SAFETY_BUDGET_VERSION || terminalizeCheckpoint;
  const terminalCheckpoint = terminalizeCheckpoint || checkpoint.status === "failed";

  return {
    frozenRunConfig,
    explicitLimit,
    terminalizeCheckpoint,
    checkpointNeedsSave,
    turnNeedsSave: turn.frozenRunConfig.safetyBudgetVersion !== SAFETY_BUDGET_VERSION
      || turn.frozenRunConfig.sandboxPolicyVersion !== SANDBOX_POLICY_VERSION
      || (terminalCheckpoint && turn.status !== "failed"),
  };
}

/** 创建只读取 durable recovery 状态并投影公开 DTO 的服务。 */
export function createTurnRecoveryService(
  ports: RuntimePorts,
  leaseCoordinator: TurnLeaseCoordinator,
): TurnRecoveryService {
  /** 在 durable 读取边界一次性迁移 V1 消息，并拒绝 pendingCalls 与配对扫描不一致的损坏记录。 */
  async function recoverCheckpoint(sessionId: string): Promise<AgentCheckpoint | undefined> {
    const checkpoint = await ports.checkpointStore.recoverStale(sessionId, ports.clock.now(), STALE_AGENT_LEASE_MS);
    if (!checkpoint) return undefined;
    const migrated = migrateAgentMessages({ messageSchemaVersion: checkpoint.messageSchemaVersion, messages: checkpoint.messages, allowPending: true });
    if (!migrated.ok) {
      throw new RuntimeError("CANONICAL_MESSAGE_INVALID", `checkpoint 消息迁移失败：${migrated.message}`);
    }
    const pairing = scanAgentToolPairing(migrated.messages);
    const pendingIds = checkpoint.pendingCalls?.map(function getPendingCallId(call) { return call.id; }) ?? [];
    const pendingMatches = pairing.pendingCallIds.length === pendingIds.length
      && pairing.pendingCallIds.every(function matchesPending(callId, index) { return callId === pendingIds[index]; });
    if (!pendingMatches && !mustCloseInterruptedCalls(checkpoint.status)) {
      throw new RuntimeError("CANONICAL_MESSAGE_INVALID", "checkpoint 的未闭合工具调用与 pendingCalls 不一致");
    }
    const pendingCalls = pairing.messages.flatMap(getAgentToolCalls)
      .filter(function selectUnclosedCall(call) { return pairing.pendingCallIds.includes(call.id); });
    if (pendingCalls.length !== pairing.pendingCallIds.length) {
      throw new RuntimeError("CANONICAL_MESSAGE_INVALID", "checkpoint 的未闭合工具调用无法恢复调用元数据");
    }
    // 等待用户回答的工具没有外部副作用；取消后继续应重新展示原问题，而不是把同一 call
    // 合成为结果后再让模型重复生成相同 ID。其余中断调用仍按未知结果安全闭合。
    const preserveCancelledQuestion = pendingCalls.length === 1
      && pendingCalls[0]?.name === "ask_user_question"
      && checkpoint.pendingUserQuestion?.callId === pendingCalls[0]?.id;
    const shouldClose = pendingCalls.length > 0 && mustCloseInterruptedCalls(checkpoint.status) && !preserveCancelledQuestion;
    const messages = shouldClose
      ? validateAgentMessages([
          ...pairing.messages,
          ...pendingCalls.map(function closeUnknownOutcome(call) {
            const result = createSyntheticToolErrorResult(call, "TOOL_OUTCOME_UNKNOWN", "恢复时无法确认该工具是否已产生副作用，请先验证外部状态后再继续");
            return createAgentToolResultMessage({ toolCallId: call.id, text: serializeToolResultForModel(result), isError: true });
          }),
        ])
      : pairing.messages;
    const normalized: AgentCheckpoint = {
      ...checkpoint,
      messageSchemaVersion: 2,
      messages,
      ...(shouldClose ? { pendingCalls: undefined, pendingUserQuestion: undefined } : {}),
    };
    if (checkpoint.messageSchemaVersion !== 2 || shouldClose) await ports.checkpointStore.save(sessionId, normalized);
    return normalized;
  }

  /** 查询指定 Turn，或在未指定 Turn 时返回整个 Session 的安全 transcript 供宿主重放历史。 */
  async function getState(input: { sessionId: string; turnId?: string }): Promise<TurnState> {
    const turn = input.turnId
      ? await ports.turnStore.get(input.turnId)
      : await ports.turnStore.getLatest(input.sessionId);
    const session = await ports.sessionStore.get(input.sessionId);
    const readOnlyReason = session ? await getWorkHistoryRestriction(ports, session) : undefined;
    const checkpoint = readOnlyReason ? await ports.checkpointStore.getLatest(input.sessionId) : await recoverCheckpoint(input.sessionId);
    const events = (await ports.transcriptStore.getEvents(input.sessionId)).map(
      /** 旧 transcript 也在读取出口脱敏，保持原记录不变。 */
      function sanitizeStoredEnvelope(envelope) { return { ...envelope, event: sanitizeEventForExternal(envelope.event) }; },
    );
    const selectedTurnId = input.turnId ?? turn?.id;
    return {
      readOnlyReason,
      turn: turn && turn.sessionId === input.sessionId && (!selectedTurnId || turn.id === selectedTurnId) ? sanitizeTurnForExternal(turn) : null,
      // checkpointStore 保留 raw reasoning 供 Provider 工具调用续接；公开状态只返回脱敏副本。
      checkpoint: checkpoint && (!selectedTurnId || checkpoint.turnId === selectedTurnId)
        ? sanitizeCheckpoint(checkpoint)
        : null,
      events: input.turnId ? events.filter((event) => event.turnId === selectedTurnId) : events,
    };
  }

  /** 将完整 Runtime 状态收窄为宿主恢复所需的安全 DTO。 */
  async function getRecoverableState(input: { sessionId: string; turnId?: string }): Promise<RecoverableTurnView | null> {
    const turn = input.turnId
      ? await ports.turnStore.get(input.turnId)
      : await ports.turnStore.getLatest(input.sessionId);
    const session = await ports.sessionStore.get(input.sessionId);
    const readOnlyReason = session ? await getWorkHistoryRestriction(ports, session) : undefined;
    const checkpoint = readOnlyReason ? await ports.checkpointStore.getLatest(input.sessionId) : await recoverCheckpoint(input.sessionId);
    if (readOnlyReason) return null;
    const selectedTurnId = input.turnId ?? checkpoint?.turnId ?? turn?.id;
    if (!selectedTurnId) return null;
    if (turn && (turn.sessionId !== input.sessionId || turn.id !== selectedTurnId)) return null;
    if (checkpoint && checkpoint.turnId !== selectedTurnId) return null;

    const events = (await ports.transcriptStore.getEvents(input.sessionId)).filter((event) => event.turnId === selectedTurnId);
    const approvalEvent = [...events].reverse().find((envelope) => envelope.event.type === "approval_required");
    const safetyBudgetMigration = turn && checkpoint ? assessSafetyBudgetMigration(turn, checkpoint) : undefined;
    const status = safetyBudgetMigration?.terminalizeCheckpoint
      ? "failed"
      : checkpoint?.status ?? mapTurnStatus(turn?.status);
    if (!status) return null;
    const recoverable = isContinuableStatus(status);
    const terminalEvent = isTerminalStatus(status)
      ? [...events].reverse().find(function hasTermination(envelope) { return "termination" in envelope.event; })
      : undefined;
    const tokenBudgetTermination = safetyBudgetMigration?.terminalizeCheckpoint
      ? sanitizeAgentTerminationView({
          reason: "token_budget",
          recoverable: false,
          ...(typeof checkpoint?.runtimeBudget?.totalTokens === "number"
            && Number.isSafeInteger(checkpoint.runtimeBudget.totalTokens)
            && checkpoint.runtimeBudget.totalTokens >= 0
            && typeof safetyBudgetMigration.explicitLimit === "number"
            && Number.isSafeInteger(safetyBudgetMigration.explicitLimit)
            && safetyBudgetMigration.explicitLimit >= 0
            ? { budget: { used: checkpoint.runtimeBudget.totalTokens, limit: safetyBudgetMigration.explicitLimit, unit: "tokens" } }
            : {}),
        }, false)
      : undefined;
    const termination = tokenBudgetTermination ?? (terminalEvent && "termination" in terminalEvent.event
      ? sanitizeAgentTerminationView(terminalEvent.event.termination, recoverable)
      : undefined);

    return {
      sessionId: input.sessionId,
      turnId: selectedTurnId,
      status: mapRecoverableStatus(status),
      recoverable,
      ...(termination ? { termination } : {}),
      approval: checkpoint?.status === "awaiting_approval" && approvalEvent?.event.type === "approval_required"
        ? {
            approvalId: approvalEvent.event.result.approval.approvalId,
            toolName: approvalEvent.event.toolName,
            reason: approvalEvent.event.result.approval.reason,
            risk: approvalEvent.event.result.approval.risk,
          }
        : undefined,
      lastSeq: events.length > 0 ? events[events.length - 1]?.seq : undefined,
      activeSkills: (checkpoint?.activeSkills ?? []).map((skill) => ({ skillId: skill.skillId, contentHash: skill.contentHash })),
    };
  }

  /** 将 Turn 冻结配置收窄为宿主可显示的模型与推理 DTO。 */
  async function getFrozenRunConfig(input: { sessionId: string; turnId?: string }): Promise<FrozenRunConfigView | null> {
    const turn = input.turnId
      ? await ports.turnStore.get(input.turnId)
      : await ports.turnStore.getLatest(input.sessionId);
    if (!turn || turn.sessionId !== input.sessionId) return null;
    return {
      sessionId: input.sessionId,
      turnId: turn.id,
      modelRef: turn.frozenRunConfig.modelRef
        ? { provider: turn.frozenRunConfig.modelRef.provider, modelId: turn.frozenRunConfig.modelRef.modelId }
        : undefined,
      reasoningProfile: turn.frozenRunConfig.reasoningProfile
        ? { ...turn.frozenRunConfig.reasoningProfile }
        : undefined,
      effectiveReasoning: turn.frozenProviderConfig?.effectiveReasoning,
      permissionMode: turn.frozenRunConfig.permissionMode,
      ...(turn.frozenRunConfig.capabilityCeiling ? { capabilityCeiling: structuredClone(turn.frozenRunConfig.capabilityCeiling) } : {}),
    };
  }

  /** 只读返回最新私有 checkpoint 的安全 Context Usage 投影；不触发恢复副作用，宿主不得自行重算。 */
  async function getContextUsage(input: { sessionId: string; turnId?: string }): Promise<ContextUsageView | null> {
    const checkpoint = await ports.checkpointStore.getLatest(input.sessionId);
    if (!checkpoint) return null;
    if (input.turnId && checkpoint.turnId !== input.turnId) return null;
    // 出口统一走白名单投影：非法 DTO fail closed 为 null，不把对象形状当可信输入。
    return projectPublicContextUsage(checkpoint.contextUsage);
  }

  /** 在 continue 前确认最新 Turn、checkpoint 与 stale lease 边界均一致。 */
  async function getContinuation(sessionId: string, turnId: string | undefined): Promise<RecoverableContinuation> {
    let turn = await ports.turnStore.getLatest(sessionId);
    if (!turn || turn.id !== turnId) {
      throw new RuntimeError("TURN_NOT_FOUND", `Session ${sessionId} 没有可恢复的 Turn ${turnId}`);
    }
    let checkpoint = await recoverCheckpoint(sessionId);
    if (!checkpoint) {
      throw new RuntimeError("CHECKPOINT_NOT_FOUND", `Session ${sessionId} 没有可恢复的 checkpoint`);
    }
    if (checkpoint.turnId !== turn.id) {
      throw new RuntimeError("TURN_FROZEN_MISMATCH", "checkpoint 与当前最新 Turn 身份不一致，拒绝继续执行");
    }
    if (leaseCoordinator.hasFresh(checkpoint, ports.clock.now())) {
      throw new RuntimeError("TURN_ALREADY_RUNNING", `Session ${sessionId} 已有正在运行的 Turn`);
    }
    const migrated = await migrateSafetyBudgetBeforeContinue(turn, checkpoint);
    turn = migrated.turn;
    checkpoint = migrated.checkpoint;
    if (!isContinuableStatus(checkpoint.status)) {
      throw new RuntimeError("TURN_NOT_RESUMABLE", `Turn ${turnId} 当前状态 ${checkpoint.status} 不允许继续执行`);
    }
    return { turn, checkpoint };
  }

  /** 在 Continue 前幂等迁移旧 token 默认值与 checkpoint，先持久化配置/状态再允许执行。 */
  async function migrateSafetyBudgetBeforeContinue(
    turn: Turn,
    checkpoint: AgentCheckpoint,
  ): Promise<{ turn: Turn; checkpoint: AgentCheckpoint }> {
    const migration = assessSafetyBudgetMigration(turn, checkpoint);
    const migratedCheckpoint: AgentCheckpoint = migration.checkpointNeedsSave
      ? {
          ...checkpoint,
          safetyBudgetVersion: SAFETY_BUDGET_VERSION,
          ...(migration.terminalizeCheckpoint ? { status: "failed" } : {}),
        }
      : checkpoint;

    const terminalCheckpoint = migratedCheckpoint.status === "failed";
    const migratedTurn: Turn = {
      ...turn,
      frozenRunConfig: migration.frozenRunConfig,
      ...(terminalCheckpoint && turn.status !== "failed"
        ? { status: "failed", completedAt: turn.completedAt ?? ports.clock.now() }
        : {}),
    };

    if (migration.turnNeedsSave) await ports.turnStore.save(migratedTurn);
    if (migration.checkpointNeedsSave) await ports.checkpointStore.save(turn.sessionId, migratedCheckpoint);
    return { turn: migratedTurn, checkpoint: migratedCheckpoint };
  }

  return { getState, getRecoverableState, getFrozenRunConfig, getContextUsage, getContinuation };
}

/** 只有已结束、暂停或中断的 checkpoint 才能继承最近一次终态投影。 */
function isTerminalStatus(status: AgentCheckpoint["status"]): boolean {
  return status === "interrupted"
    || status === "interrupted_recoverable"
    || status === "failed"
    || status === "limit_reached";
}

/** 将内部 durable Turn 记录收窄为宿主可读取的安全元数据。 */
function sanitizeTurnForExternal(turn: Turn): Turn {
  const { frozenProviderConfig: _frozenProviderConfig, frozenRunConfig, ...safeTurn } = turn;
  const { credentialRef: _credentialRef, rerankPolicy: _rerankPolicy, safetyBudgetVersion: _safetyBudgetVersion, modelRef, ...safeFrozenRunConfig } = frozenRunConfig;
  return {
    ...safeTurn,
    frozenRunConfig: {
      ...safeFrozenRunConfig,
      ...(modelRef ? { modelRef: { provider: modelRef.provider, modelId: modelRef.modelId } } : {}),
    },
  };
}

/** 将 Turn 元数据状态转换为恢复视图允许的生命周期状态。 */
function mapTurnStatus(status: Turn["status"] | undefined): AgentCheckpoint["status"] | undefined {
  if (status === "waiting_approval") return "awaiting_approval";
  if (status === "waiting_user_input") return "awaiting_user_input";
  if (status === "interrupted") return "interrupted_recoverable";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return undefined;
}

/** 将内部 checkpoint 状态收窄为宿主恢复 DTO 状态。 */
function mapRecoverableStatus(status: AgentCheckpoint["status"]): RecoverableTurnView["status"] {
  if (status === "awaiting_approval") return "awaiting_approval";
  if (status === "awaiting_user_input") return "awaiting_user_input";
  if (status === "interrupted" || status === "interrupted_recoverable") return "interrupted_recoverable";
  if (status === "limit_reached") return "limit_reached";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}
