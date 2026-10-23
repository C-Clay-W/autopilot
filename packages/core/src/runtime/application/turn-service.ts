/**
 * runtime/application/turn-service.ts — Turn 用例编排
 *
 * TurnService 是 Runtime 层的核心用例：
 * 它接收宿主命令，编排 Session 与 Turn 生命周期，并委托内部协调器执行 turn、
 * 持久化 checkpoint 和投影事件。
 *
 * Phase 3 改动：
 * - start 时调用 resolveRunConfig 计算三层优先级，冻结为 FrozenRunConfig 并写入 TurnStore。
 * - continue 强制读取 TurnStore 中的 FrozenRunConfig，忽略 input.runConfig 覆盖。
 * - ephemeral 模式跳过 transcript / checkpoint 持久化，但 eventSink 仍执行。
 * - 事件信封构造改为调用 createEventEnvelope 纯工厂函数。
 */

import { assertWorkHistoryWritable } from "./turn/work-history-boundary";
import { resolveTurnCapabilities } from "./turn/turn-capability-ceiling";
import { readSessionIdentity } from "../domain/product-mode";
import { createWebCheckpointInputs } from "./turn/web-checkpoint-inputs";
import { randomUUID } from "node:crypto";
import type { ContextUsageView } from "../../internal/kernel/context-budget";
import type { ToolApprovalDecision } from "../../internal/tools/types";
import type { RuntimePorts } from "../ports";
import type {
  AgentEvent,
  StartTurnInput,
  ContinueTurnInput,
  CancelTurnInput,
  SteerTurnInput,
  RunConfig,
  CompactTurnInput,
  CompactTurnResult,
  FrozenRunConfigView,
  RecoverableTurnView,
} from "../protocol";
import {
  resolveRunConfig,
  AgentRuntimeError as RuntimeError,
} from "../protocol";
import type { Session, Turn } from "../domain";
import type { InboxInput } from "../domain";
import type { ApprovalService } from "./approval-service";
import type { InputInboxService } from "./input-inbox-service";
import type { JobService } from "./job-service";
import { createTurnConversationBuilder } from "./turn/turn-conversation-builder";
import { createTurnLeaseCoordinator } from "./turn/turn-lease-coordinator";
import { createTurnRuntimeConfigResolver } from "./turn/turn-runtime-config-resolver";
import { createTurnCompactionCoordinator } from "./turn/turn-compaction-coordinator";
import { createTurnRecoveryService } from "./turn/turn-recovery-service";
import { createTurnExecutionCoordinator } from "./turn/turn-execution-coordinator";
import type { TurnState } from "./turn/turn-recovery-service";
import type { UserQuestionService } from "./user-question-service";
export { STALE_AGENT_LEASE_MS } from "./turn/turn-lease-coordinator";
export type { TurnState } from "./turn/turn-recovery-service";

/** TurnService 接口：宿主唯一需要的 turn 操作入口。 */
export interface TurnService {
  /** 启动一个新 turn。 */
  start(input: StartTurnInput): AsyncIterable<AgentEvent>;

  /** 从最新 checkpoint 继续运行 turn。 */
  continue(input: ContinueTurnInput): AsyncIterable<AgentEvent>;

  /** 取消当前运行中 turn。 */
  cancel(input: CancelTurnInput): Promise<void>;

  /** 向运行中 turn 注入 steer / queue 输入。 */
  steer(input: SteerTurnInput): Promise<InboxInput>;

  /** 压缩指定 turn 的历史上下文。 */
  compact(input: CompactTurnInput): Promise<CompactTurnResult>;

  /** 查询宿主恢复/状态页面所需的最新 Turn、checkpoint 与安全事件；省略 turnId 时返回整个 Session transcript。 */
  getState(input: { sessionId: string; turnId?: string }): Promise<TurnState>;

  /** 查询只包含生命周期、审批摘要和 Skill 身份的脱敏恢复视图。 */
  getRecoverableState(input: { sessionId: string; turnId?: string }): Promise<RecoverableTurnView | null>;

  /** 查询当前 Turn 的脱敏冻结模型与推理配置。 */
  getFrozenRunConfig(input: { sessionId: string; turnId?: string }): Promise<FrozenRunConfigView | null>;

  /** 只读查询最新安全 Context Usage 快照；无数据时为 null，宿主不得自行重算或读取私有 anchor。 */
  getContextUsage(input: { sessionId: string; turnId?: string }): Promise<ContextUsageView | null>;
}

/** 创建 TurnService 实例。 */
export function createTurnService(
  ports: RuntimePorts,
  defaultRunConfig: RunConfig = {},
  approvalService?: ApprovalService,
  inputInboxService?: InputInboxService,
  jobService?: JobService,
  userQuestionService?: UserQuestionService,
  enableUserQuestions = false,
): TurnService {
  const webInputs = createWebCheckpointInputs();
  const activeTurns = new Map<string, AbortController>();
  const conversationBuilder = createTurnConversationBuilder(ports);
  const leaseCoordinator = createTurnLeaseCoordinator(ports, activeTurns);
  const runtimeConfigResolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig, approvalService, inputInboxService, jobService, userQuestionService, enableUserQuestions });
  const compactionCoordinator = createTurnCompactionCoordinator(ports, defaultRunConfig, leaseCoordinator, runtimeConfigResolver);
  const recoveryService = createTurnRecoveryService(ports, leaseCoordinator);
  const executionCoordinator = createTurnExecutionCoordinator({
    ports,
    activeTurns,
    webInputs,
    leaseCoordinator,
    runtimeConfigResolver,
    compactionCoordinator,
    requireSession,
  });

  return {
    start,
    continue: continueTurn,
    cancel,
    steer,
    compact,
    getState,
    getRecoverableState,
    getFrozenRunConfig,
    getContextUsage,
  };

  /** 把公共审批决定映射为内部 ToolApprovalDecision。 */
  function mapApprovalDecision(decision: "allow" | "deny"): ToolApprovalDecision {
    return decision === "allow" ? "allow_once" : "deny";
  }

  /** 读取并校验 Session。 */
  async function requireSession(sessionId: string): Promise<Session> {
    const session = await ports.sessionStore.get(sessionId);
    if (!session) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session ${sessionId} 不存在`);
    }
    readSessionIdentity(session);
    return session;
  }

  /** 读取 Project 默认运行配置；session.projectId 缺失时返回 undefined。 */
  async function resolveProjectDefault(session: Session) {
    if (!session.projectId) return undefined;
    const project = await ports.projectStore.get(session.projectId);
    return project?.defaultRunConfig;
  }

  /** 启动新 turn。 */
  async function* start(input: StartTurnInput): AsyncGenerator<AgentEvent> {
    const session = await requireSession(input.sessionId);
    await assertWorkHistoryWritable(ports, session);
    if (session.productMode === "chat" && (input.messages !== undefined || input.activeSkills?.length)) throw new RuntimeError("INVALID_INPUT", "Chat 只接受当前用户正文，不接受外部历史或 Skill 上下文");
    await leaseCoordinator.assertNoFresh(input.sessionId);
    const projectDefault = await resolveProjectDefault(session);
    const runtimeDefault = runtimeConfigResolver.readRuntimeDefault();

    // 三层优先级合并并冻结为 FrozenRunConfig。
    let frozenRunConfig = resolveRunConfig({
      projectDefault,
      sessionDefault: session.defaultRunConfig,
      turnOverride: input.runConfig,
      runtimeDefault,
    });
    // Talk-Plan1022 R2：把受信宿主的有效进程执行方式随 Turn 一并冻结，恢复时据此拒绝跨执行方式继续。
    frozenRunConfig = { ...frozenRunConfig, processExecution: readProcessExecution(ports) };

    const turnId = input.turnId ?? randomUUID();
    if (await ports.turnStore.get(turnId)) throw new RuntimeError("TURN_FROZEN_MISMATCH", "Turn ID 已存在，不能覆盖冻结身份");
    // H1：会话延续以最近可安全重建的终态轮为基线（含失败/中断），不只为 completed 跳过原任务。
    const baselineTurn = await conversationBuilder.getConversationBaselineTurn(input.sessionId);
    const todoChainId = input.continuity?.source === "claimed_queue"
      ? baselineTurn?.todoChainId ?? baselineTurn?.id ?? turnId
      : turnId;
    const resolved = await resolveTurnCapabilities({ session, turnId, runtimeDefault, override: input.runConfig, frozen: frozenRunConfig, now: ports.clock.now() });
    const capabilities = resolved.capabilities;
    frozenRunConfig = resolved.frozen;
    const frozenProviderConfig = runtimeConfigResolver.freezeProviderConfig(frozenRunConfig, capabilities);
    const turn: Turn = {
      id: turnId,
      sessionId: input.sessionId,
      status: "running",
      frozenRunConfig,
      frozenProviderConfig,
      todoChainId,
      startedAt: ports.clock.now(),
      schemaVersion: 2,
    };
    const initialMessages = conversationBuilder.buildInitialMessages(input);
    await conversationBuilder.refreshContext(capabilities, input.content);
    let messages = await conversationBuilder.buildCanonicalSessionMessages(baselineTurn, initialMessages);
    // P1-a：新 Turn 继承上一 Turn 私有 anchor，避免首采样退化为全量估算；不满足条件时为 undefined。
    const inheritedUsageAnchor = await conversationBuilder.inheritPreviousUsageAnchor(input.sessionId, baselineTurn, messages, initialMessages);
    // claimed queue 连续路径注入最近 Todo 快照；普通新 Turn 不设置 continuity，不注入。
    // 注入放在 anchor 校验之后，避免 reminder 消息破坏 anchor 长度一致性校验。
    if (session.productMode !== "chat" && input.continuity?.source === "claimed_queue") {
      messages = await conversationBuilder.injectTodoSnapshot(input.sessionId, todoChainId, messages);
    }
    const lease = await leaseCoordinator.acquire(input.sessionId, turnId);
    try {
      await ports.turnStore.save(turn);
      yield* executionCoordinator.execute({ sessionId: input.sessionId, turnId, frozen: frozenRunConfig, capabilities, providerConfig: frozenProviderConfig, previousContextWindowTokens: baselineTurn?.frozenProviderConfig?.contextWindowTokens ?? baselineTurn?.frozenProviderConfig?.compactThresholdTokens, lease, makeRuntimeInput: () => ({
        turnId,
        todoChainId,
        messages,
        activeSkills: session.productMode === "chat" ? undefined : input.activeSkills,
        inheritedUsageAnchor,
        signal: input.signal,
        maxSteps: frozenRunConfig.maxSteps,
        maxToolRetries: frozenRunConfig.maxToolRetries,
        runtimeLimitsResolved: true,
        maxDurationMs: frozenRunConfig.maxDurationMs,
        maxTotalTokens: frozenRunConfig.maxTotalTokens,
      }) });
    } catch (error) {
      // 凭据/模型装配在首个 checkpoint 前失败时，执行协调器尚未接管终态收尾。
      // 保留原错误契约，但不能留下 running Turn 让下一条输入被误判为 steer。
      const checkpoint = await ports.checkpointStore.getLatest(input.sessionId);
      if (checkpoint?.turnId !== turnId) {
        await ports.turnStore.save({ ...turn, status: "failed", completedAt: ports.clock.now() });
        const failedSession = await requireSession(input.sessionId);
        failedSession.status = "failed";
        failedSession.activeTurnId = undefined;
        failedSession.updatedAt = ports.clock.now();
        await ports.sessionStore.save(failedSession);
      }
      throw error;
    } finally {
      await leaseCoordinator.release(input.sessionId, lease);
    }
  }

  /** 继续运行 turn；强制使用 TurnStore 中的 FrozenRunConfig，忽略 input.runConfig 覆盖。 */
  async function* continueTurn(input: ContinueTurnInput): AsyncGenerator<AgentEvent> {
    const session = await requireSession(input.sessionId);
    await assertWorkHistoryWritable(ports, session);
    const recovered = await recoveryService.getContinuation(input.sessionId, input.turnId);
    const turn = recovered.turn;
    // Talk-Plan1022 R2：执行方式在 Turn 冻结，恢复先比对；不匹配时不进入执行链，旧审批零消费。
    assertFrozenProcessExecution(turn, ports);
    const checkpoint = webInputs.restore(recovered.checkpoint);

    const turnId = input.turnId ?? checkpoint.turnId;
    const userQuestion = await resolveUserQuestionContinuation(input, checkpoint, turnId);
    // Chat 只重新读取宿主能力并与旧快照取交集；不重读主模型冻结参数。
    const resolved = await resolveTurnCapabilities({ session, turnId, runtimeDefault: session.productMode === "chat" ? runtimeConfigResolver.readRuntimeDefault() : defaultRunConfig, override: input.runConfig, frozen: turn.frozenRunConfig, continuing: true, now: ports.clock.now() });
    const capabilities = resolved.capabilities;

    const providerConfig = runtimeConfigResolver.normalizeFrozenProviderConfig(turn.frozenProviderConfig);
    const lease = await leaseCoordinator.acquire(input.sessionId, turnId);
    try {
      if (providerConfig !== turn.frozenProviderConfig) {
        await ports.turnStore.save({ ...turn, frozenProviderConfig: providerConfig });
      }
      /** 在协调器内创建已冻结权限的输入，生命周期仍由原执行链管理。 */
      yield* executionCoordinator.execute({ sessionId: input.sessionId, turnId, frozen: resolved.frozen, capabilities, providerConfig, previousContextWindowTokens: undefined, lease, makeRuntimeInput: () => ({
        turnId,
        todoChainId: turn.todoChainId ?? turn.id,
        checkpoint,
        signal: input.signal,
        maxSteps: turn.frozenRunConfig.maxSteps,
        maxToolRetries: turn.frozenRunConfig.maxToolRetries,
        runtimeLimitsResolved: true,
        maxDurationMs: turn.frozenRunConfig.maxDurationMs,
        maxTotalTokens: turn.frozenRunConfig.maxTotalTokens,
        approval: input.approval
          ? { approvalId: input.approval.approvalId, decision: mapApprovalDecision(input.approval.decision) }
          : undefined,
        userQuestion,
      }) });
    } finally {
      await leaseCoordinator.release(input.sessionId, lease);
    }

    // 若 turnId 与 session.activeTurnId 不一致，保持 session 以 checkpoint 为准
    if (session.activeTurnId && session.activeTurnId !== turnId) {
      session.activeTurnId = turnId;
      session.updatedAt = ports.clock.now();
      await ports.sessionStore.save(session);
    }
  }

  /** 只从可信 Question Store 读取已提交答案，并确认其仍绑定当前等待中的原 Tool 调用。 */
  async function resolveUserQuestionContinuation(
    input: ContinueTurnInput,
    checkpoint: import("../../internal/agent-runtime").AgentCheckpoint,
    turnId: string,
  ): Promise<{ requestId: string; answer: import("../domain").UserQuestionAnswer } | undefined> {
    if (checkpoint.status !== "awaiting_user_input") {
      if (input.requestId) throw new RuntimeError("QUESTION_TURN_STATE_INVALID", "当前 Turn 不在等待用户回答状态");
      return undefined;
    }
    if (!input.requestId) {
      throw new RuntimeError("QUESTION_TURN_STATE_INVALID", "恢复等待用户回答的 Turn 必须提供 requestId");
    }
    const pendingCall = checkpoint.pendingCalls?.[0];
    if (checkpoint.pendingCalls?.length !== 1 || pendingCall?.name !== "ask_user_question") {
      throw new RuntimeError("QUESTION_TURN_STATE_INVALID", "等待用户回答的 Turn 不包含唯一的 ask_user_question 调用");
    }
    const pendingQuestion = checkpoint.pendingUserQuestion;
    if (!pendingQuestion || pendingQuestion.callId !== pendingCall.id || pendingQuestion.requestId !== input.requestId) {
      throw new RuntimeError("QUESTION_TURN_STATE_INVALID", "requestId 不属于当前等待回答的问题");
    }
    if (!userQuestionService) throw new RuntimeError("NOT_IMPLEMENTED", "当前 Runtime 未装配 UserQuestionService");
    const answer = await userQuestionService.getAnswer({ sessionId: input.sessionId, turnId, requestId: input.requestId });
    if (!answer) throw new RuntimeError("QUESTION_NOT_FOUND", "问题尚未提交答案或不属于当前 Turn");
    return { requestId: input.requestId, answer };
  }

  /** 取消运行中 turn。 */
  async function cancel(input: CancelTurnInput): Promise<void> {
    const controller = activeTurns.get(input.turnId);
    if (controller) {
      controller.abort();
    }

    const session = await ports.sessionStore.get(input.sessionId);
    if (session && (session.activeTurnId === input.turnId || session.status === "waiting_user_input")) {
      session.status = "interrupted";
      session.activeTurnId = undefined;
      session.updatedAt = ports.clock.now();
      await ports.sessionStore.save(session);
    }

    const checkpoint = await ports.checkpointStore.getLatest(input.sessionId);
    if (checkpoint?.turnId === input.turnId && checkpoint.status === "awaiting_user_input") {
      await ports.checkpointStore.save(input.sessionId, { ...checkpoint, status: "interrupted" });
    }

    // 更新运行中或等待用户回答的 Turn 状态为 interrupted。
    const turn = await ports.turnStore.get(input.turnId);
    if (turn && (turn.status === "running" || turn.status === "waiting_user_input")) {
      turn.status = "interrupted";
      turn.completedAt = ports.clock.now();
      await ports.turnStore.save(turn);
    }
  }

  /** 向运行中 turn 投递 steer / queue 输入。 */
  async function steer(input: SteerTurnInput): Promise<InboxInput> {
    await assertWorkHistoryWritable(ports, await requireSession(input.sessionId));
    if (!inputInboxService) {
      throw new RuntimeError("NOT_IMPLEMENTED", "steer 需要 InputInboxService；请在 createAgentRuntime 中注入");
    }
    return inputInboxService.post({
      sessionId: input.sessionId,
      turnId: input.turnId,
      clientMessageId: input.clientMessageId,
      delivery: input.delivery ?? (input.content.startsWith("/queue") ? "queue" : "steer"),
      content: input.delivery === "steer" ? input.content.trim() : input.content.replace(/^\/queue\s*/, "").trim(),
      attachments: input.attachments ?? [],
      selectedSkills: input.selectedSkills ?? [],
    });
  }

  /** 将公开 compact 命令委托给压缩协调器。 */
  async function compact(input: CompactTurnInput): Promise<CompactTurnResult> {
    await assertWorkHistoryWritable(ports, await requireSession(input.sessionId));
    return compactionCoordinator.compact(input);
  }

  /** 将公开状态查询委托给 recovery service。 */
  async function getState(input: { sessionId: string; turnId?: string }): Promise<TurnState> {
    return recoveryService.getState(input);
  }

  /** 将公开恢复视图查询委托给 recovery service。 */
  async function getRecoverableState(input: { sessionId: string; turnId?: string }): Promise<RecoverableTurnView | null> {
    return recoveryService.getRecoverableState(input);
  }

  /** 将冻结运行配置查询委托给 recovery service。 */
  async function getFrozenRunConfig(input: { sessionId: string; turnId?: string }): Promise<FrozenRunConfigView | null> {
    return recoveryService.getFrozenRunConfig(input);
  }

  /** 将安全 Context Usage 查询委托给 recovery service。 */
  async function getContextUsage(input: { sessionId: string; turnId?: string }): Promise<ContextUsageView | null> {
    return recoveryService.getContextUsage(input);
  }
}

/** 读取受信宿主当前声明的有效进程执行方式；只有宿主执行 Port 声明 host，其余按沙箱。 */
function readProcessExecution(ports: RuntimePorts): "sandbox" | "host" {
  return ports.sandboxPort.execution === "host" ? "host" : "sandbox";
}

/**
 * Talk-Plan1022 R2：恢复前比对 Turn 冻结的有效执行方式与当前宿主。旧沙箱记录缺省按沙箱处理，
 * 在宿主执行 Runtime 上必须停止——否则旧沙箱审批会以当前用户完整权限执行。反向（宿主 Turn
 * 落到沙箱 Runtime）同样拒绝，避免把宿主批准当成沙箱批准重放。
 */
function assertFrozenProcessExecution(turn: Turn, ports: RuntimePorts): void {
  const current = readProcessExecution(ports);
  const frozen = turn.frozenRunConfig.processExecution ?? "sandbox";
  if (frozen === current) return;
  throw new RuntimeError(
    "TURN_FROZEN_MISMATCH",
    current === "host"
      ? "该任务创建于沙箱执行方式，当前已停用 Windows 进程沙箱；旧审批不能转为宿主执行，请新建任务重新审批"
      : "该任务创建于宿主执行方式，当前运行时要求沙箱执行；旧审批不能转为沙箱执行，请新建任务重新审批",
  );
}
