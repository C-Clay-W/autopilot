/**
 * runtime/application/turn/turn-compaction-coordinator.ts — Turn 上下文压缩协调
 *
 * 统一手动、主动、响应式和 Kernel 自动压缩的冻结 policy、lease 守卫与 checkpoint 投影切换；
 * 不管理执行循环、事件序号或终态收尾。
 */

import { compactMessages } from "../../../internal/kernel/compact";
import { createDefaultModelSampler } from "../../../internal/kernel/model-sampler";
import type { ModelSampler } from "../../../internal/kernel/model-sampler";
import { calculateContextBudget, projectContextUsage, projectPublicContextUsage, type ContextUsageView } from "../../../internal/kernel/context-budget";
import type { AgentMessage } from "../../../internal/types/agent-message";
import type { ContextCompactionManager } from "../../../internal/kernel/run-context";
import type { FrozenRunConfig, Turn } from "../../domain";
import type { RuntimePorts } from "../../ports";
import type { CompactTurnInput, CompactTurnResult, RunConfig } from "../../protocol";
import { AgentRuntimeError as RuntimeError } from "../../protocol";
import type { FrozenProviderConfig } from "../../provider/frozen-provider-config";
import type { TurnLeaseCoordinator } from "./turn-lease-coordinator";
import type { TurnRuntimeConfigResolver } from "./turn-runtime-config-resolver";
import { createTurnEventRecorder } from "./turn-event-recorder";

/** 自动 compact 的上下文窗口触发比例。 */
const COMPACT_TRIGGER_RATIO = 0.80;
/** 自动 compact 为 provider 侧不可见 token 保留的窗口比例。 */
const COMPACT_SAFETY_BUFFER_RATIO = 0.02;
/** 自动 compact 最小安全 buffer，避免小比例导致的窗口边界抖动。 */
const MIN_COMPACT_SAFETY_BUFFER = 8_192;
/** 未显式冻结 policy 时使用的兼容默认压缩策略。 */
const DEFAULT_COMPACT_POLICY = { preserveRecentTurns: 4, targetTokens: Math.floor(128_000 * 0.55) } as const;

/** 供执行协调器传入摘要采样器的内部 compact 请求。 */
export interface TurnCompactionRequest extends CompactTurnInput {
  sampler?: ModelSampler;
}

/** 统一派生的 Context 预算边界；展示投影与 auto compact 共用，禁止两处各自推导。 */
export interface ContextBudgetBounds {
  /** 预算分母窗口：优先真实 context window，兼容仅有 compactThresholdTokens 的旧配置。 */
  budgetWindowTokens: number | undefined;
  /** 冻结模型的真实完整窗口；缺失时展示投影保持 unknown。 */
  contextWindowTokens: number | undefined;
  /** 下一次输出的冻结预留。 */
  outputReserveTokens: number;
  /** 与 auto compact 完全一致的触发阈值；非法时为 undefined。 */
  triggerTokens: number | undefined;
}

/** 从冻结 Provider 配置统一派生预算窗口、输出预留与 compact 触发阈值。 */
export function resolveContextBudgetBounds(providerConfig: FrozenProviderConfig | undefined): ContextBudgetBounds {
  const contextWindowTokens = providerConfig?.contextWindowTokens;
  const compactThresholdTokens = providerConfig?.compactThresholdTokens;
  const budgetWindowTokens = contextWindowTokens ?? compactThresholdTokens;
  const outputReserveTokens = providerConfig?.sampleOptions?.maxTokens ?? 8_192;
  if (!budgetWindowTokens) {
    return { budgetWindowTokens: undefined, contextWindowTokens, outputReserveTokens, triggerTokens: undefined };
  }
  const safetyBufferTokens = Math.max(MIN_COMPACT_SAFETY_BUFFER, Math.ceil(budgetWindowTokens * COMPACT_SAFETY_BUFFER_RATIO));
  const derivedTriggerTokens = Math.min(Math.floor(budgetWindowTokens * COMPACT_TRIGGER_RATIO), budgetWindowTokens - outputReserveTokens - safetyBufferTokens);
  const triggerTokens = compactThresholdTokens === undefined ? derivedTriggerTokens : Math.min(compactThresholdTokens, derivedTriggerTokens);
  return {
    budgetWindowTokens,
    contextWindowTokens,
    outputReserveTokens,
    triggerTokens: triggerTokens > 0 ? triggerTokens : undefined,
  };
}

/** Turn 上下文压缩协调器的内部职责。 */
export interface TurnCompactionCoordinator {
  buildContextCompactionManager(frozen: FrozenRunConfig, providerConfig: FrozenProviderConfig | undefined, sampler: ModelSampler): ContextCompactionManager | undefined;
  compact(input: TurnCompactionRequest): Promise<CompactTurnResult>;
}

/** 创建只管理上下文压缩边界的协调器。 */
export function createTurnCompactionCoordinator(
  ports: RuntimePorts,
  defaultRunConfig: RunConfig,
  leaseCoordinator: TurnLeaseCoordinator,
  runtimeConfigResolver: TurnRuntimeConfigResolver,
): TurnCompactionCoordinator {
  const eventRecorder = createTurnEventRecorder(ports);

  /**
   * manual compact changed 后生成 estimated 降级投影：旧 usage anchor 已失效，
   * 无账本恢复输入，内容分类整体回退 other，等待下一次完整请求组装后再校准；
   * 无冻结窗口或安全模型引用时返回 undefined（fail closed，不猜测窗口）。
   */
  function buildEstimatedUsageAfterCompact(turn: Turn | undefined, messages: AgentMessage[]): ContextUsageView | undefined {
    const modelRef = turn?.frozenRunConfig.modelRef;
    const bounds = resolveContextBudgetBounds(turn?.frozenProviderConfig);
    if (!modelRef || !bounds.contextWindowTokens || !bounds.triggerTokens) return undefined;
    return projectContextUsage({
      checkpoint: {},
      messages,
      tools: [],
      contextWindowTokens: bounds.contextWindowTokens,
      outputReserveTokens: bounds.outputReserveTokens,
      compactTriggerTokens: bounds.triggerTokens,
      modelRef: `${modelRef.provider}/${modelRef.modelId}`,
    }) ?? undefined;
  }

  /** 创建只在 Kernel before_sample 安全点使用的 auto compact 判断与执行器。 */
  function buildContextCompactionManager(
    frozen: FrozenRunConfig,
    providerConfig: FrozenProviderConfig | undefined,
    sampler: ModelSampler,
  ): ContextCompactionManager | undefined {
    const bounds = resolveContextBudgetBounds(providerConfig);
    if (!bounds.budgetWindowTokens || !bounds.triggerTokens) return undefined;
    const outputReserveTokens = bounds.outputReserveTokens;
    const triggerTokens = bounds.triggerTokens;
    const policy = frozen.compactPolicy ?? defaultRunConfig.compactPolicy ?? DEFAULT_COMPACT_POLICY;
    return {
      shouldCompact({ messages, usageAnchor, tools }) {
        return calculateContextBudget(
          usageAnchor ? { turnId: "context-budget", status: "running", stepCount: 0, messages, completedCallIds: [], usageAnchor } : undefined,
          messages,
          tools,
          outputReserveTokens,
        ).totalTokens >= triggerTokens;
      },
      async compact(input) {
        return compactMessages({
          messages: input.messages,
          trigger: "auto",
          preserveRecentTurns: policy.preserveRecentTurns,
          targetTokens: policy.targetTokens,
          signal: input.signal,
          sampler,
        });
      },
    };
  }

  /** 压缩指定 Turn 的消息上下文，并在手动调用时更新 durable checkpoint 投影。 */
  async function compact(input: TurnCompactionRequest): Promise<CompactTurnResult> {
    const needsRuntimePolicy = input.preserveRecentTurns === undefined || input.targetTokens === undefined;
    const storedTurn = await ports.turnStore.get(input.turnId);
    const turn = storedTurn?.sessionId === input.sessionId ? storedTurn : undefined;
    if (needsRuntimePolicy && !turn) {
      throw new RuntimeError("TURN_NOT_FOUND", `Session ${input.sessionId} 没有 Turn ${input.turnId}`);
    }
    // 手动 compact 守卫：Turn 仍在运行中时拒绝宿主手动压缩，避免与 Kernel 并发写 checkpoint，且内存投影会在 Turn 结束时覆盖压缩结果。
    if (input.trigger === "manual" && leaseCoordinator.isActive(input.turnId)) {
      throw new RuntimeError("TURN_ALREADY_RUNNING", `Turn ${input.turnId} 正在运行中，手动 compact 请等待 Turn 结束后触发`);
    }
    // 跨进程 lease 守卫：checkpoint 仍被其他 Runtime 的新鲜 lease 持有时，只有 lease owner（本进程 activeTurns）可以压缩并切换投影。
    const guardedCheckpoint = await ports.checkpointStore.getLatest(input.sessionId);
    if (
      guardedCheckpoint &&
      guardedCheckpoint.turnId === input.turnId &&
      leaseCoordinator.hasFresh(guardedCheckpoint, ports.clock.now()) &&
      !leaseCoordinator.isActive(input.turnId)
    ) {
      throw new RuntimeError("TURN_ALREADY_RUNNING", `Session ${input.sessionId} 已有正在运行的 Turn，compact 仅限 lease owner`);
    }
    const checkpoint = input.messages
      ? undefined
      : await ports.checkpointStore.getLatest(input.sessionId);
    if (!input.messages && (!checkpoint || checkpoint.turnId !== input.turnId)) {
      throw new RuntimeError("CHECKPOINT_NOT_FOUND", `Session ${input.sessionId} 没有可压缩的 Turn ${input.turnId}`);
    }
    const policy = turn?.frozenRunConfig.compactPolicy ?? defaultRunConfig.compactPolicy ?? DEFAULT_COMPACT_POLICY;
    const sampler = input.sampler ?? (turn
      ? runtimeConfigResolver.buildCompactionSampler(
          turn.frozenRunConfig,
          defaultRunConfig,
          input.sessionId,
          input.turnId,
          (turn.frozenProviderConfig?.credentialRef ?? turn.frozenRunConfig.credentialRef)
            ? await ports.credentialStore.resolve(turn.frozenProviderConfig?.credentialRef ?? turn.frozenRunConfig.credentialRef!)
            : undefined,
          turn.frozenProviderConfig,
        )
      : createDefaultModelSampler());
    const result = await compactMessages({
      messages: input.messages ?? checkpoint!.messages,
      trigger: input.trigger,
      preserveRecentTurns: input.preserveRecentTurns ?? policy.preserveRecentTurns,
      targetTokens: input.targetTokens ?? policy.targetTokens,
      signal: input.signal,
      sampler,
    });
    if (result.outcome === "skipped") {
      // no-op：消息投影与 anchor 均不变，不写 checkpoint 与事件；宿主以 outcome 而非空 summary 判断 skipped。
      return { ...result, contextUsage: projectPublicContextUsage(checkpoint?.contextUsage) };
    }
    if (checkpoint) {
      // 手动 compact 的新投影替换旧消息边界；旧 usage anchor 与 usage 快照不再可信，以 estimated 降级投影替代。
      const { usageAnchor: _droppedUsageAnchor, contextUsage: _droppedContextUsage, ...checkpointWithoutUsageSnapshot } = checkpoint;
      const usage = buildEstimatedUsageAfterCompact(turn, result.messages);
      await ports.checkpointStore.save(input.sessionId, { ...checkpointWithoutUsageSnapshot, messages: result.messages, ...(usage ? { contextUsage: usage } : {}) });
      // 变更沿共享 event recorder 持久化，与 Execution Coordinator 保持同一脱敏与 seq 边界，不在 Route 伪造 Runtime 事件。
      const session = await ports.sessionStore.get(input.sessionId);
      await eventRecorder.record({
        seq: await eventRecorder.nextSeq(input.sessionId, input.turnId),
        sessionId: input.sessionId,
        turnId: input.turnId,
        isDurable: session?.persistenceMode !== "ephemeral",
        event: { type: "context_usage_updated", turnId: input.turnId, usage: usage ?? null },
      });
      return { ...result, contextUsage: projectPublicContextUsage(usage) };
    }
    // 宿主传入完整消息列表的迁移调用：无 durable checkpoint 可切换投影，只返回结果。
    return { ...result, contextUsage: null };
  }

  return { buildContextCompactionManager, compact };
}
