/**
 * runtime/application/turn/turn-execution-coordinator.ts — Turn 执行状态机
 *
 * 负责内部 Agent 循环、事件与 checkpoint/transcript 持久化、lease heartbeat 和终态收尾；
 * TurnService 仅提供公开命令编排与依赖组合。
 */

import { createAgentRuntime as createInternalAgentRuntime } from "../../../internal/agent-runtime";
import { recordPerformanceDiagnostic } from "../../../internal/performance-diagnostics";
import type { AgentLease, AgentLoopEvent, RuntimeAgentRunInput } from "../../../internal/agent-runtime";
import { createDefaultModelSampler } from "../../../internal/kernel/model-sampler";
import type { FrozenRunConfig, ResolvedCredential, Session, Turn } from "../../domain";
import type { RuntimePorts } from "../../ports";
import type { AgentCheckpoint, AgentEvent, RunConfig } from "../../protocol";
import { AgentRuntimeError as RuntimeError } from "../../protocol";
import { redactWebCheckpoint } from "../../protocol/sanitize-checkpoint";
import { scanAgentToolPairing } from "../../../internal/types/agent-message";
import type { FrozenProviderConfig } from "../../provider/frozen-provider-config";
import { resolveContextBudgetBounds, type TurnCompactionCoordinator } from "./turn-compaction-coordinator";
import type { TurnLeaseCoordinator } from "./turn-lease-coordinator";
import type { TurnRuntimeConfigResolver } from "./turn-runtime-config-resolver";
import { createTurnEventRecorder } from "./turn-event-recorder";

/** 活跃 turn 的持久化心跳间隔；小于 stale 阈值，覆盖长模型调用。 */
const AGENT_LEASE_HEARTBEAT_MS = 15_000;
/** 连续文本 delta 的合并时间窗，避免每个 Provider 分片都触发一次持久化。 */
const DELTA_MERGE_WINDOW_MS = 16;
/** 单个合并事件的 UTF-8 大小上限，避免长时间等待或无界内存增长。 */
const DELTA_MERGE_MAX_BYTES = 4 * 1024;

type MergeableDeltaEvent = Extract<AgentLoopEvent, { type: "answer_delta" | "reasoning_delta" }>;

interface PendingDeltaEvent {
  event: MergeableDeltaEvent;
  bytes: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  timerPromise: Promise<"timer">;
}

/** 判断事件是否属于可合并的连续文本 delta。 */
function isMergeableDeltaEvent(event: AgentEvent | AgentLoopEvent): event is MergeableDeltaEvent {
  return event.type === "answer_delta" || event.type === "reasoning_delta";
}

/** 创建一个在 16ms 后触发的合并 flush 信号。 */
function createDeltaMergeTimer(): Pick<PendingDeltaEvent, "timer" | "timerPromise"> {
  let resolveTimer: (() => void) | undefined;
  const timerPromise = new Promise<"timer">(function waitForDeltaMergeWindow(resolve) {
    resolveTimer = function resolveDeltaMergeTimer() { resolve("timer"); };
  });
  const timer = setTimeout(function flushDeltaMergeWindow() { resolveTimer?.(); }, DELTA_MERGE_WINDOW_MS);
  return { timer, timerPromise };
}

/** 取消尚未触发的 delta 合并定时器。 */
function clearDeltaMergeTimer(pending: PendingDeltaEvent): void {
  clearTimeout(pending.timer);
}

/** 合并同一 turn/step/type 的文本分片，保留首个分片的事件元数据。 */
function appendDeltaEvent(pending: PendingDeltaEvent, event: MergeableDeltaEvent, bytes: number): void {
  pending.event = { ...pending.event, delta: pending.event.delta + event.delta };
  pending.bytes += bytes;
}

/** 对 Runtime 事件做短窗口 delta 合并；输出前仍由调用方完成持久化。 */
export function coalesceDeltaEvents(source: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent>;
export function coalesceDeltaEvents(source: AsyncIterable<AgentLoopEvent>): AsyncGenerator<AgentLoopEvent>;
export async function* coalesceDeltaEvents(source: AsyncIterable<AgentEvent | AgentLoopEvent>): AsyncGenerator<AgentEvent | AgentLoopEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let nextPromise: Promise<IteratorResult<AgentEvent | AgentLoopEvent>> | undefined = iterator.next();
  let deferredEvent: AgentEvent | AgentLoopEvent | undefined;
  let pending: PendingDeltaEvent | undefined;
  try {
    while (true) {
      if (deferredEvent) {
        const event = deferredEvent;
        deferredEvent = undefined;
        if (!isMergeableDeltaEvent(event)) {
          yield event;
          nextPromise = iterator.next();
          continue;
        }
        const timer = createDeltaMergeTimer();
        pending = { event, bytes: Buffer.byteLength(event.delta, "utf8"), startedAt: performance.now(), ...timer };
        nextPromise = iterator.next();
        continue;
      }

      if (!pending) {
        const result = await (nextPromise ?? iterator.next());
        nextPromise = undefined;
        if (result.done) return;
        if (!isMergeableDeltaEvent(result.value)) {
          yield result.value;
          nextPromise = iterator.next();
          continue;
        }
        const timer = createDeltaMergeTimer();
        pending = { event: result.value, bytes: Buffer.byteLength(result.value.delta, "utf8"), startedAt: performance.now(), ...timer };
        nextPromise = iterator.next();
        continue;
      }

      const pendingNext: Promise<IteratorResult<AgentEvent | AgentLoopEvent>> = nextPromise ?? iterator.next();
      nextPromise = pendingNext;
      const outcome = await Promise.race([
        pendingNext.then(function receivedNextEvent(result: IteratorResult<AgentEvent | AgentLoopEvent>) { return { kind: "event" as const, result }; }),
        pending.timerPromise.then(function mergeWindowElapsed() { return { kind: "timer" as const }; }),
      ]);
      if (outcome.kind === "timer") {
        const output = pending.event;
        pending = undefined;
        yield output;
        continue;
      }

      nextPromise = undefined;
      if (outcome.result.done) {
        const output = pending.event;
        clearDeltaMergeTimer(pending);
        pending = undefined;
        yield output;
        return;
      }
      const event = outcome.result.value;
      const eventBytes = isMergeableDeltaEvent(event) ? Buffer.byteLength(event.delta, "utf8") : 0;
      const sameBatch = isMergeableDeltaEvent(event)
        && event.type === pending.event.type
        && event.turnId === pending.event.turnId
        && event.stepId === pending.event.stepId;
      const withinWindow = performance.now() - pending.startedAt < DELTA_MERGE_WINDOW_MS;
      const withinSize = pending.bytes === 0 || pending.bytes + eventBytes <= DELTA_MERGE_MAX_BYTES;
      if (sameBatch && withinWindow && withinSize) {
        appendDeltaEvent(pending, event, eventBytes);
        if (pending.bytes >= DELTA_MERGE_MAX_BYTES) {
          const output = pending.event;
          clearDeltaMergeTimer(pending);
          pending = undefined;
          yield output;
        }
        nextPromise = iterator.next();
        continue;
      }

      const output = pending.event;
      clearDeltaMergeTimer(pending);
      pending = undefined;
      deferredEvent = event;
      yield output;
    }
  } catch (error) {
    if (pending) {
      const output = pending.event;
      clearDeltaMergeTimer(pending);
      pending = undefined;
      yield output;
    }
    throw error;
  } finally {
    if (pending) clearDeltaMergeTimer(pending);
    if (iterator.return) await iterator.return();
  }
}

/** 所有 durable checkpoint 写入前固定 V2 schema 并验证消息与暂停调用是否一致。 */
function normalizeCheckpointForStorage(checkpoint: AgentCheckpoint): AgentCheckpoint {
  const redacted = redactWebCheckpoint(checkpoint);
  const pairing = scanAgentToolPairing(redacted.messages);
  const pendingIds = redacted.pendingCalls?.map(function getPendingCallId(call) { return call.id; }) ?? [];
  if (pairing.pendingCallIds.length !== pendingIds.length
    || pairing.pendingCallIds.some(function differsFromCheckpoint(callId, index) { return callId !== pendingIds[index]; })) {
    throw new RuntimeError("CANONICAL_MESSAGE_INVALID", "checkpoint 的未闭合工具调用与 pendingCalls 不一致");
  }
  if ((redacted.status === "completed" || redacted.status === "failed" || redacted.status === "limit_reached") && pairing.pendingCallIds.length > 0) {
    throw new RuntimeError("CANONICAL_MESSAGE_INVALID", "终态 checkpoint 不能保留未闭合工具调用");
  }
  return { ...redacted, messageSchemaVersion: 2, messages: pairing.messages };
}

/** 执行状态机所需的依赖；公开 Facade 持有命令级语义。 */
export interface TurnExecutionCoordinatorDependencies {
  ports: RuntimePorts;
  activeTurns: Map<string, AbortController>;
  webInputs: import("./web-checkpoint-inputs").WebCheckpointInputs;
  leaseCoordinator: TurnLeaseCoordinator;
  runtimeConfigResolver: TurnRuntimeConfigResolver;
  compactionCoordinator: TurnCompactionCoordinator;
  requireSession(sessionId: string): Promise<Session>;
}

/** 执行一次 durable Turn 的完整输入。 */
export interface TurnExecutionInput {
  sessionId: string;
  turnId: string;
  frozen: FrozenRunConfig;
  capabilities: RunConfig;
  providerConfig: FrozenProviderConfig | undefined;
  previousContextWindowTokens: number | undefined;
  lease: AgentLease;
  makeRuntimeInput(runtime: ReturnType<typeof createInternalAgentRuntime>): RuntimeAgentRunInput;
}

/** Turn 执行协调器的内部职责。 */
export interface TurnExecutionCoordinator {
  execute(input: TurnExecutionInput): AsyncGenerator<AgentEvent>;
}

/** 创建持有完整执行状态机的协调器。 */
export function createTurnExecutionCoordinator(
  dependencies: TurnExecutionCoordinatorDependencies,
): TurnExecutionCoordinator {
  const { ports, activeTurns, webInputs, leaseCoordinator, runtimeConfigResolver, compactionCoordinator, requireSession } = dependencies;
  const eventRecorder = createTurnEventRecorder(ports);

  /** 执行一次 turn 的核心循环：状态更新、事件输出、持久化。 */
  async function* execute(input: TurnExecutionInput): AsyncGenerator<AgentEvent> {
    const { sessionId, turnId, frozen, capabilities, providerConfig, previousContextWindowTokens, lease, makeRuntimeInput } = input;
    const session = await requireSession(sessionId);
    if (activeTurns.has(turnId)) {
      throw new RuntimeError("TURN_ALREADY_RUNNING", `Turn ${turnId} 已在当前 Runtime 中运行`);
    }
    const credentialRef = providerConfig?.credentialRef ?? frozen.credentialRef;
    if (credentialRef && frozen.modelRef && credentialRef.provider !== frozen.modelRef.provider) {
      throw new RuntimeError("CREDENTIAL_REF_INVALID", "CredentialRef.provider 必须与 ModelRef.provider 一致");
    }
    let credential: ResolvedCredential | undefined;
    try {
      credential = credentialRef ? await ports.credentialStore.resolve(credentialRef) : undefined;
    } catch (error) {
      throw new RuntimeError("MISSING_CREDENTIAL", "指定的 Provider credentialRef 无法解析", error);
    }
    if (credentialRef && !credential) {
      throw new RuntimeError("MISSING_CREDENTIAL", "指定的 Provider credentialRef 无法解析");
    }
    const agentOptions = runtimeConfigResolver.buildAgentOptions(frozen, capabilities, sessionId, turnId, credential, providerConfig);
    const compactionSampler = agentOptions.modelSampler ?? createDefaultModelSampler();
    agentOptions.contextCompaction = compactionCoordinator.buildContextCompactionManager(frozen, providerConfig, compactionSampler);
    // Context Usage 展示与 auto compact 共用同一冻结派生；无真实窗口或模型引用时保持 unknown。
    const budgetBounds = resolveContextBudgetBounds(providerConfig);
    agentOptions.contextUsageProjection = budgetBounds.contextWindowTokens && budgetBounds.triggerTokens && frozen.modelRef
      ? {
          modelRef: `${frozen.modelRef.provider}/${frozen.modelRef.modelId}`,
          contextWindowTokens: budgetBounds.contextWindowTokens,
          outputReserveTokens: budgetBounds.outputReserveTokens,
          compactTriggerTokens: budgetBounds.triggerTokens,
        }
      : undefined;
    const internalRuntime = createInternalAgentRuntime(agentOptions);
    const abortController = new AbortController();
    activeTurns.set(turnId, abortController);

    session.status = "running";
    session.activeTurnId = turnId;
    session.updatedAt = ports.clock.now();
    await ports.sessionStore.save(session);
    // 恢复等待回答的 Turn 前先回写运行态，允许模型在读取答案后再次请求澄清。
    const runningTurn = await ports.turnStore.get(turnId);
    if (runningTurn) {
      runningTurn.status = "running";
      runningTurn.completedAt = undefined;
      await ports.turnStore.save(runningTurn);
    }

    const isDurable = session.persistenceMode !== "ephemeral";
    const transcript = isDurable ? await ports.transcriptStore.getEvents(sessionId) : [];
    let seq = transcript.reduce(function getTurnMaximum(current, envelope) {
      return envelope.turnId === turnId ? Math.max(current, envelope.seq) : current;
    }, 0);
    let finalCheckpoint: AgentCheckpoint | undefined;
    let latestCheckpoint: AgentCheckpoint | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatWrite = Promise.resolve();
    let checkpointWrite = Promise.resolve();
    let highestCheckpointBoundary = -1;

    /** 将 checkpoint 经 V2 校验后写入 durable Store，禁止旧 schema 回流。 */
    async function saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
      const normalized = normalizeCheckpointForStorage(structuredClone(checkpoint));
      const boundary = normalized.lease?.safeBoundarySeq ?? -1;
      if (boundary < highestCheckpointBoundary) return;
      highestCheckpointBoundary = boundary;
      const write = checkpointWrite.then(async function writeCheckpoint() {
        await ports.checkpointStore.save(sessionId, normalized);
      });
      checkpointWrite = write.catch(function keepCheckpointQueueOpen() { return undefined; });
      await write;
    }

    /** 将完整工具批次后的运行快照接入协调器，先落 durable checkpoint 再允许下一次采样。 */
    agentOptions.onSafeToolBatch = isDurable
      ? async function persistSafeToolBatch(checkpoint: AgentCheckpoint): Promise<void> {
        const now = ports.clock.now();
        const safeCheckpoint: AgentCheckpoint = {
          ...checkpoint,
          lease: { ...lease, heartbeatAt: now, safeBoundarySeq: seq },
        };
        latestCheckpoint = safeCheckpoint;
        finalCheckpoint = safeCheckpoint;
        await saveCheckpoint(safeCheckpoint);
      }
      : undefined;

    try {
      let runtimeInput = makeRuntimeInput(internalRuntime);
      if (runtimeInput.signal) runtimeInput.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      runtimeInput.signal = abortController.signal;
      const runtimeBudget: NonNullable<AgentCheckpoint["runtimeBudget"]> = {
        startedAt: ports.clock.now(),
        totalTokens: runtimeInput.checkpoint?.runtimeBudget?.totalTokens ?? 0,
        executionSegmentVersion: 1,
      };
      const initialCheckpoint: AgentCheckpoint = runtimeInput.checkpoint
        ? { ...runtimeInput.checkpoint, safetyBudgetVersion: 2, status: runtimeInput.checkpoint.status === "awaiting_approval" || runtimeInput.checkpoint.status === "awaiting_user_input" ? runtimeInput.checkpoint.status : "running", runtimeBudget, lease }
        : { turnId, status: "running", safetyBudgetVersion: 2, stepCount: 0, messages: runtimeInput.messages ?? [], completedCallIds: [], activeSkills: runtimeInput.activeSkills, runtimeBudget, lease };
      if (runtimeInput.checkpoint) runtimeInput = { ...runtimeInput, checkpoint: initialCheckpoint };
      latestCheckpoint = normalizeCheckpointForStorage(initialCheckpoint);
      finalCheckpoint = latestCheckpoint;
      if (isDurable) await saveCheckpoint(latestCheckpoint);

      const currentContextWindowTokens = providerConfig?.contextWindowTokens ?? providerConfig?.compactThresholdTokens;
      const shouldProactivelyCompact = previousContextWindowTokens !== undefined
        && currentContextWindowTokens !== undefined
        && previousContextWindowTokens > currentContextWindowTokens;
      if (shouldProactivelyCompact) {
        yield await persistEvent({ type: "context_compact_started", turnId, trigger: "proactive" });
        try {
          const compacted = await compactionCoordinator.compact({ sessionId, turnId, messages: initialCheckpoint.messages, trigger: "proactive", signal: abortController.signal, sampler: compactionSampler });
          // proactive compact 替换消息投影：旧 usage anchor 与 usage 快照不再可信。
          const { usageAnchor: _droppedProactiveUsageAnchor, contextUsage: _droppedProactiveContextUsage, ...proactiveCheckpointBase } = initialCheckpoint;
          const proactiveCheckpoint: AgentCheckpoint = { ...proactiveCheckpointBase, messages: compacted.messages, lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq } };
          runtimeInput = { ...runtimeInput, messages: compacted.messages, inheritedUsageAnchor: undefined };
          yield await persistEvent({ type: "context_compacted", turnId, trigger: "proactive", summary: compacted.summary, preTokens: compacted.preTokens, postTokens: compacted.postTokens, preservedFromIndex: compacted.preservedFromIndex, checkpoint: proactiveCheckpoint });
        } catch {
          const message = "proactive compact 失败";
          yield await persistEvent({ type: "context_compact_failed", turnId, trigger: "proactive", error: message });
          const failedCheckpoint: AgentCheckpoint = { ...initialCheckpoint, status: "failed", lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq } };
          yield await persistEvent({ type: "turn_failed", turnId, checkpoint: failedCheckpoint, error: message });
          return;
        }
      }

      /** 为事件补齐 Runtime 租约，并写入 EventSink / Transcript / Checkpoint。 */
      async function persistEvent(event: AgentLoopEvent): Promise<AgentEvent> {
        const checkpoint = extractCheckpoint(event);
        if (checkpoint) webInputs.remember(checkpoint);
        const priorTodoSnapshot = latestCheckpoint?.todoSnapshot;
        const todoSnapshot = event.type === "todo_updated"
          ? { todoChainId: event.todoChainId, todos: event.todos, counts: event.counts }
          : priorTodoSnapshot;
        const normalized = checkpoint
          ? ({ ...event, checkpoint: normalizeCheckpointForStorage({ ...checkpoint, ...(todoSnapshot ? { todoSnapshot } : {}), lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq + 1 } }) } as AgentLoopEvent)
          : event;
        const normalizedCheckpoint = extractCheckpoint(normalized);
        if (normalizedCheckpoint) {
          latestCheckpoint = normalizedCheckpoint;
          finalCheckpoint = normalizedCheckpoint;
        } else if (todoSnapshot && latestCheckpoint) {
          latestCheckpoint = { ...latestCheckpoint, todoSnapshot };
          finalCheckpoint = latestCheckpoint;
        } else if (event.type === "context_usage_updated" && latestCheckpoint) {
          // 无 checkpoint 的 usage 事件合并进 latest checkpoint：非 null 写入安全快照，null 明确清空旧状态。
          if (event.usage) {
            latestCheckpoint = { ...latestCheckpoint, contextUsage: event.usage };
          } else {
            const { contextUsage: _droppedContextUsage, ...withoutContextUsage } = latestCheckpoint;
            latestCheckpoint = withoutContextUsage;
          }
          finalCheckpoint = latestCheckpoint;
        }
        seq += 1;
        lease.safeBoundarySeq = seq;
        recordPerformanceDiagnostic("runtime_event_produced", event.type);
        // Transcript/EventSink 持久化走共享 recorder，与 manual compact 保持同一脱敏与 seq 边界。
        const persisted = await eventRecorder.record({ seq, sessionId, turnId, isDurable, event: normalized });
        if (isDurable) {
          if (normalizedCheckpoint) await saveCheckpoint(normalizedCheckpoint);
          else if ((event.type === "todo_updated" || event.type === "context_usage_updated") && latestCheckpoint) await saveCheckpoint(latestCheckpoint);
        }
        return persisted;
      }

      if (isDurable) {
        heartbeatTimer = setInterval(() => {
          const checkpoint = latestCheckpoint;
          if (!checkpoint || checkpoint.status !== "running") return;
          const heartbeatCheckpoint: AgentCheckpoint = { ...checkpoint, lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq } };
          latestCheckpoint = heartbeatCheckpoint;
          finalCheckpoint = heartbeatCheckpoint;
          heartbeatWrite = heartbeatWrite.then(async () => {
            const now = ports.clock.now();
            const heartbeatLease = { ...lease, heartbeatAt: now, safeBoundarySeq: seq };
            const owned = await ports.leaseStore.heartbeat({ sessionId, lease: heartbeatLease, now });
            if (!owned) {
              abortController.abort();
              return;
            }
            lease.heartbeatAt = now;
            lease.safeBoundarySeq = seq;
            await saveCheckpoint({ ...heartbeatCheckpoint, lease: heartbeatLease });
          }).catch(() => undefined);
        }, AGENT_LEASE_HEARTBEAT_MS);
      }

      let reactiveAttempts = 0;
      while (true) {
        let overflowCheckpoint: AgentCheckpoint | undefined;
        for await (const event of coalesceDeltaEvents(internalRuntime.run(runtimeInput))) {
          if (event.type === "context_overflow") {
            overflowCheckpoint = { ...event.checkpoint, status: "failed", lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq } };
            latestCheckpoint = overflowCheckpoint;
            finalCheckpoint = overflowCheckpoint;
            if (isDurable) await saveCheckpoint(overflowCheckpoint);
            break;
          }
          yield await persistEvent(event);
        }
        if (!overflowCheckpoint) break;
        if (reactiveAttempts >= 1) {
          yield await persistEvent({ type: "context_compact_circuit_open", turnId, trigger: "reactive" });
          const failedCheckpoint: AgentCheckpoint = { ...overflowCheckpoint, status: "failed" };
          yield await persistEvent({ type: "turn_failed", turnId, checkpoint: failedCheckpoint, error: "上下文溢出后已完成一次压缩重试，compact 熔断器已阻止重复请求" });
          break;
        }
        reactiveAttempts += 1;
        yield await persistEvent({ type: "context_compact_started", turnId, trigger: "reactive" });
        try {
          const compacted = await compactionCoordinator.compact({ sessionId, turnId, messages: overflowCheckpoint.messages, trigger: "reactive", signal: abortController.signal, sampler: compactionSampler });
          const { usageAnchor: _droppedUsageAnchor, contextUsage: _droppedContextUsage, ...checkpointWithoutUsageSnapshot } = overflowCheckpoint;
          const retryCheckpoint: AgentCheckpoint = { ...checkpointWithoutUsageSnapshot, status: "running", messages: compacted.messages, lease: { ...lease, heartbeatAt: ports.clock.now(), safeBoundarySeq: seq } };
          yield await persistEvent({ type: "context_compacted", turnId, trigger: "reactive", summary: compacted.summary, preTokens: compacted.preTokens, postTokens: compacted.postTokens, preservedFromIndex: compacted.preservedFromIndex, checkpoint: retryCheckpoint });
          const persistedRetryCheckpoint = latestCheckpoint ?? retryCheckpoint;
          finalCheckpoint = persistedRetryCheckpoint;
          runtimeInput = { ...runtimeInput, checkpoint: persistedRetryCheckpoint };
        } catch (error) {
          const message = error instanceof Error ? error.message : "上下文压缩失败";
          yield await persistEvent({ type: "context_compact_failed", turnId, trigger: "reactive", error: message });
          yield await persistEvent({ type: "context_compact_circuit_open", turnId, trigger: "reactive" });
          const failedCheckpoint: AgentCheckpoint = { ...overflowCheckpoint, status: "failed" };
          yield await persistEvent({ type: "turn_failed", turnId, checkpoint: failedCheckpoint, error: "reactive compact 失败，已熔断以避免重复请求" });
          break;
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeatWrite;
      activeTurns.delete(turnId);
      if (finalCheckpoint) {
        if (isDurable) await saveCheckpoint(finalCheckpoint);
        session.status = deriveSessionStatus(finalCheckpoint.status);
      } else {
        session.status = "failed";
      }
      session.activeTurnId = session.status === "running" ? turnId : undefined;
      session.updatedAt = ports.clock.now();
      await ports.sessionStore.save(session);
      const turn = await ports.turnStore.get(turnId);
      if (turn) {
        turn.status = finalCheckpoint ? deriveTurnStatus(finalCheckpoint.status) : "failed";
        turn.completedAt = ports.clock.now();
        await ports.turnStore.save(turn);
      }
      await leaseCoordinator.release(sessionId, lease);
    }
  }

  return { execute };
}

/** 从事件尝试提取 checkpoint。 */
function extractCheckpoint(event: AgentLoopEvent) {
  return "checkpoint" in event ? event.checkpoint : undefined;
}

/** 从 checkpoint 状态推导 Session 状态。 */
function deriveSessionStatus(checkpointStatus: string): Session["status"] {
  if (checkpointStatus === "completed" || checkpointStatus === "limit_reached") return "completed";
  if (checkpointStatus === "failed") return "failed";
  if (checkpointStatus === "awaiting_approval") return "waiting_approval";
  if (checkpointStatus === "awaiting_user_input") return "waiting_user_input";
  if (checkpointStatus === "interrupted" || checkpointStatus === "interrupted_recoverable") return "interrupted";
  return "running";
}

/** 从 checkpoint 状态推导 Turn 状态。 */
function deriveTurnStatus(checkpointStatus: string): Turn["status"] {
  if (checkpointStatus === "completed" || checkpointStatus === "limit_reached") return "completed";
  if (checkpointStatus === "failed") return "failed";
  if (checkpointStatus === "awaiting_approval") return "waiting_approval";
  if (checkpointStatus === "awaiting_user_input") return "waiting_user_input";
  if (checkpointStatus === "interrupted" || checkpointStatus === "interrupted_recoverable") return "interrupted";
  return "running";
}
