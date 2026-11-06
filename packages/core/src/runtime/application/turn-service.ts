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

import { assertThreadExecutionHost } from "./thread-execution-host";
import { createThreadService, hasEnabledThreadMembership } from "./thread-service";
import { assertWorkHistoryWritable } from "./turn/work-history-boundary";
import { resolveTurnCapabilities } from "./turn/turn-capability-ceiling";
import { readSessionIdentity } from "../domain/product-mode";
import { createWebCheckpointInputs } from "./turn/web-checkpoint-inputs";
import { randomUUID } from "node:crypto";
import type { ContextUsageView } from "../../internal/kernel/context-budget";
import type { TurnUsageSummaryView } from "../../internal/kernel/turn-usage";
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
import { readTurnExecutionView, type TurnExecutionView } from "./turn/turn-execution-view";
import { createTurnExecutionCoordinator } from "./turn/turn-execution-coordinator";
import { createTurnEventRecorder } from "./turn/turn-event-recorder";
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

  /** 已保存交互的持久宿主交接；无协作组时由调用方沿原本机continue入口执行。 */
  requestInteractionContinuation?(input: { sessionId: string; turnId: string; approvalId?: string; requestId?: string }): Promise<{ queued: boolean; controlId?: string }>;

  /** 取消当前运行中 turn。 */
  cancel(input: CancelTurnInput): Promise<void>;
  /** 仅取消此Runtime真实持有的执行体；不修改远端摘要，旧宿主可缺省。 */
  cancelLocalExecution?(input: CancelTurnInput): Promise<boolean>;

  /** 向运行中 turn 注入 steer / queue 输入。 */
  steer(input: SteerTurnInput): Promise<InboxInput>;

  /** 压缩指定 turn 的历史上下文。 */
  compact(input: CompactTurnInput): Promise<CompactTurnResult>;

  /** 查询宿主恢复/状态页面所需的最新 Turn、checkpoint 与安全事件；省略 turnId 时返回整个 Session transcript。 */
  getState(input: { sessionId: string; turnId?: string }): Promise<TurnState>;

  /** 查询只包含生命周期、审批摘要和 Skill 身份的脱敏恢复视图。 */
  getRecoverableState(input: { sessionId: string; turnId?: string }): Promise<RecoverableTurnView | null>;
  /** 只读统一执行/交互事实，不恢复或启动任务。 */
  getExecutionState(input: { sessionId: string; turnId?: string; signal?: AbortSignal }): Promise<TurnExecutionView | null>;

  /** 查询当前 Turn 的脱敏冻结模型与推理配置。 */
  getFrozenRunConfig(input: { sessionId: string; turnId?: string }): Promise<FrozenRunConfigView | null>;

  /** 只读查询最新安全 Context Usage 快照；无数据时为 null，宿主不得自行重算或读取私有 anchor。 */
  getContextUsage(input: { sessionId: string; turnId?: string }): Promise<ContextUsageView | null>;

  /** 只读查询 Turn 累计用量汇总（累计输入/输出/总量与执行段耗时）；无数据时为 null，宿主不得自行重算。 */
  getTurnUsageSummary(input: { sessionId: string; turnId?: string }): Promise<TurnUsageSummaryView | null>;

  /** 一次读取最新checkpoint后返回两个既有白名单用量投影，缺失或错Turn时均为null。 */
  getUsageSnapshot(input: { sessionId: string; turnId?: string }): Promise<{ contextUsage: ContextUsageView | null; turnUsage: TurnUsageSummaryView | null }>;
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
  const eventRecorder = createTurnEventRecorder(ports);
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
    requestInteractionContinuation,
    cancel,
    cancelLocalExecution,
    steer,
    compact,
    getState,
    getRecoverableState,
    getExecutionState: function getExecutionState(input) { return readTurnExecutionView(ports, input); },
    getFrozenRunConfig,
    getContextUsage,
    getTurnUsageSummary,
    getUsageSnapshot,
  };

  /** 按当前受信工作区和本机人类身份找到唯一目标组，模型工具不提供此入口。 */
  async function requestInteractionContinuation(input: { sessionId: string; turnId: string; approvalId?: string; requestId?: string }): Promise<{ queued: boolean; controlId?: string }> {
    const capability = runtimeConfigResolver.readRuntimeDefault().threads;
    if (!capability?.humanPrincipalId) return { queued: false };
    const session = await requireSession(input.sessionId);
    if (session.productMode !== "work" || session.projectId !== capability.projectId) throw new RuntimeError("THREAD_SCOPE_DENIED", "THREAD_SCOPE_DENIED");
    const service = createThreadService(ports, ports.threadStore, { ...capability, actor: { kind: "human", principalId: capability.humanPrincipalId } });
    const groupId = await service.resolveGroup({ threadIds: [input.sessionId] });
    if (!groupId) return { queued: false };
    return { queued: true, ...await service.continueInteraction({ groupId, threadId: input.sessionId, turnId: input.turnId, approvalId: input.approvalId, requestId: input.requestId }) };
  }

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

  /**
   * 普通 Work 会话按宿主和 Project 装配创建能力，通信组授权仍由每次具体操作检查。
   * 恢复路径继续使用原冻结目录；来源和已停用通信组不降低后续普通 Turn 能力。
   */
  async function scopeThreadsForSession(
    session: Session,
    runtimeDefault: import("../protocol").RunConfig,
  ): Promise<import("../protocol").RunConfig> {
    const threads = runtimeDefault.threads;
    if (!threads) return runtimeDefault;
    if (session.productMode === "work" && session.projectId === threads.projectId && (threads.humanPrincipalId || await hasEnabledThreadMembership(ports, threads, session.id))) return { ...runtimeDefault, threads };
    return { ...runtimeDefault, threads: undefined };
  }

  /** 启动新 turn。 */
  async function* start(input: StartTurnInput): AsyncGenerator<AgentEvent> {
    const session = await requireSession(input.sessionId);
    await assertWorkHistoryWritable(ports, session);
    if (session.productMode === "work") await assertThreadExecutionHost(ports, session.id, session.projectId, runtimeConfigResolver.readRuntimeDefault().threads?.executionHost);
    if (session.productMode === "chat" && (input.messages !== undefined || input.activeSkills?.length)) throw new RuntimeError("INVALID_INPUT", "Chat 只接受当前用户正文，不接受外部历史或 Skill 上下文");
    await leaseCoordinator.assertNoFresh(input.sessionId);
    const projectDefault = await resolveProjectDefault(session);
    const runtimeDefault = await scopeThreadsForSession(session, runtimeConfigResolver.readRuntimeDefault());

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
    // 新Turn准备期间人类可能绑定旧缺省档位，领取后复核且拒绝时不创建Turn。
    try { if (session.productMode === "work") await assertThreadExecutionHost(ports, session.id, session.projectId, runtimeConfigResolver.readRuntimeDefault().threads?.executionHost); }
    catch (error) { await leaseCoordinator.release(input.sessionId, lease); throw error; }
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
    if (session.productMode === "work") await assertThreadExecutionHost(ports, session.id, session.projectId, runtimeConfigResolver.readRuntimeDefault().threads?.executionHost, true);
    const recovered = await recoveryService.getContinuation(input.sessionId, input.turnId);
    const turn = recovered.turn;
    // Talk-Plan1022 R2：执行方式在 Turn 冻结，恢复先比对；不匹配时不进入执行链，旧审批零消费。
    assertFrozenProcessExecution(turn, ports);
    const checkpoint = webInputs.restore(recovered.checkpoint);

    // 仅可信权威视图已撤下当前审批身份时允许重签，HTTP/模型不能自报该内部标记。
    const approvalView = checkpoint.status === "awaiting_approval" && !input.approval
      ? await recoveryService.getRecoverableState({ sessionId: input.sessionId, turnId: turn.id })
      : undefined;
    const reissueApproval = approvalView?.status === "awaiting_approval" && approvalView.recoverable && !approvalView.approval;

    const turnId = input.turnId ?? checkpoint.turnId;
    const userQuestion = await resolveUserQuestionContinuation(input, checkpoint, turnId);
    // Work 恢复也须重取宿主动态协作能力，再与原冻结目录取交集；模型和权限仍用原冻结参数。
    const runtimeDefault = await scopeThreadsForSession(session, session.productMode === "chat" ? runtimeConfigResolver.readRuntimeDefault() : { ...defaultRunConfig, threads: runtimeConfigResolver.readRuntimeDefault().threads });
    const resolved = await resolveTurnCapabilities({ session, turnId, runtimeDefault, override: input.runConfig, frozen: turn.frozenRunConfig, continuing: true, now: ports.clock.now() });
    const capabilities = resolved.capabilities;

    const providerConfig = runtimeConfigResolver.normalizeFrozenProviderConfig(turn.frozenProviderConfig);
    const lease = await leaseCoordinator.acquire(input.sessionId, turnId);
    try {
      // 领取等待期间其他宿主可能已执行到下一暂停或终态，旧快照不得再次驱动工具。
      const current = await recoveryService.getContinuation(input.sessionId, turnId);
      if (current.checkpoint.status !== recovered.checkpoint.status
        || current.checkpoint.lease?.leaseId !== recovered.checkpoint.lease?.leaseId
        || current.checkpoint.lease?.safeBoundarySeq !== recovered.checkpoint.lease?.safeBoundarySeq) {
        throw new RuntimeError("TURN_NOT_RESUMABLE", "恢复等待期间执行段已改变，请读取当前状态");
      }
      if (providerConfig !== turn.frozenProviderConfig) {
        await ports.turnStore.save({ ...turn, frozenProviderConfig: providerConfig });
      }
      /** 在协调器内创建已冻结权限的输入，生命周期仍由原执行链管理。 */
      yield* executionCoordinator.execute({ sessionId: input.sessionId, turnId, frozen: resolved.frozen, capabilities, providerConfig, previousContextWindowTokens: undefined, lease, makeRuntimeInput: () => ({
        turnId,
        todoChainId: turn.todoChainId ?? turn.id,
        checkpoint,
        reissueApproval,
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

  /** 精确验证Session/Turn后仅abort本Runtime的controller，返回真实归属，不写持久状态。 */
  async function cancelLocalExecution(input: CancelTurnInput): Promise<boolean> {
    const turn = await ports.turnStore.get(input.turnId);
    if (!turn || turn.sessionId !== input.sessionId) throw new RuntimeError("TURN_NOT_FOUND", "Turn 不存在或不属于当前会话");
    const controller = activeTurns.get(input.turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 取消前先验证Session/Turn；等待收尾与start/continue共享lease并在持有期间重读当前身份。 */
  async function cancel(input: CancelTurnInput): Promise<void> {
    const turn = await ports.turnStore.get(input.turnId);
    if (!turn || turn.sessionId !== input.sessionId) throw new RuntimeError("TURN_NOT_FOUND", "Turn 不存在或不属于当前会话");
    if (turn.status === "waiting_user_input" || turn.status === "waiting_approval" || turn.status === "interrupted") {
      const lease = await leaseCoordinator.acquire(input.sessionId, input.turnId);
      try {
        const [current, session, latest, checkpoint] = await Promise.all([ports.turnStore.get(input.turnId), ports.sessionStore.get(input.sessionId), ports.turnStore.getLatest(input.sessionId), ports.checkpointStore.getLatest(input.sessionId)]);
        const waiting = current?.status === "waiting_approval" || current?.status === "waiting_user_input";
        const checkpointStatus = current?.status === "waiting_approval" ? "awaiting_approval" : "awaiting_user_input";
        const recovering = current?.status === "interrupted" && checkpoint?.status === "interrupted";
        if (!current || current.sessionId !== input.sessionId || (!waiting && !recovering) || !session
          || !(session.status === current.status || (recovering && (session.status === "waiting_approval" || session.status === "waiting_user_input")))
          || (session.activeTurnId && session.activeTurnId !== input.turnId) || latest?.id !== input.turnId
          || checkpoint?.turnId !== input.turnId || (checkpoint.status !== "interrupted" && checkpoint.status !== checkpointStatus)) throw new RuntimeError("TURN_FROZEN_MISMATCH", "取消目标与当前等待任务不一致");
        // 先封住旧审批；后续任一步失败，精确重试仍可从 interrupted checkpoint 继续收敛。
        const interrupted = { ...checkpoint, status: "interrupted" as const };
        if (checkpoint.status !== "interrupted") await ports.checkpointStore.save(input.sessionId, interrupted);
        const transcript = await ports.transcriptStore.getEvents(input.sessionId);
        const terminal = transcript.find(function sameTerminal(item) { return item.turnId === input.turnId && item.event.type === "turn_interrupted" && item.event.checkpoint.status === "interrupted"; });
        // transcript 已成功、sink 失败时复用同一信封/seq；不为重试追加第二条终态。
        if (terminal) {
          if (current.status === "interrupted" && session.status === "interrupted" && !session.activeTurnId) return;
          await ports.eventSink.write(terminal);
        } else {
          await eventRecorder.record({
            seq: await eventRecorder.nextSeq(input.sessionId, input.turnId), sessionId: input.sessionId, turnId: input.turnId,
            isDurable: session.persistenceMode !== "ephemeral",
            event: { type: "turn_interrupted", turnId: input.turnId, checkpoint: interrupted, error: "用户已取消等待中的任务" },
          });
        }
        if (current.status !== "interrupted") await ports.turnStore.save({ ...current, status: "interrupted", completedAt: ports.clock.now() });
        if (session.status !== "interrupted" || session.activeTurnId) await ports.sessionStore.save({ ...session, status: "interrupted", activeTurnId: undefined, updatedAt: ports.clock.now() });
      } finally {
        await leaseCoordinator.release(input.sessionId, lease);
      }
      return;
    }

    // running保留本进程controller的原中断语义；身份已经在任何abort/状态修改之前验证。
    const controller = activeTurns.get(input.turnId);
    if (controller) controller.abort();
    const session = await ports.sessionStore.get(input.sessionId);
    if (session?.activeTurnId === input.turnId) {
      await ports.sessionStore.save({ ...session, status: "interrupted", activeTurnId: undefined, updatedAt: ports.clock.now() });
    }
    const checkpoint = await ports.checkpointStore.getLatest(input.sessionId);
    if (checkpoint?.turnId === input.turnId && (checkpoint.status === "awaiting_user_input" || checkpoint.status === "awaiting_approval")) {
      await ports.checkpointStore.save(input.sessionId, { ...checkpoint, status: "interrupted" });
    }
    if (turn.status === "running") await ports.turnStore.save({ ...turn, status: "interrupted", completedAt: ports.clock.now() });
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

  /** 将同一checkpoint的安全用量双投影委托给既有恢复服务。 */
  async function getUsageSnapshot(input: { sessionId: string; turnId?: string }): Promise<{ contextUsage: ContextUsageView | null; turnUsage: TurnUsageSummaryView | null }> {
    return recoveryService.getUsageSnapshot(input);
  }

  /** 将 Turn 累计用量汇总查询委托给 recovery service。 */
  async function getTurnUsageSummary(input: { sessionId: string; turnId?: string }): Promise<TurnUsageSummaryView | null> {
    return recoveryService.getTurnUsageSummary(input);
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
