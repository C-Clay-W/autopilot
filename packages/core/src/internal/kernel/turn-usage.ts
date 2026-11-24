/**
 * Kernel Turn 累计用量汇总：把私有 runtimeBudget 收窄为只读安全 DTO（累计输入/输出/总量与执行段耗时）。
 * 供 context_usage_updated 事件附带值与 turns.getTurnUsageSummary 只读查询共用；
 * 数字全部来自 Kernel 已有的 runtimeBudget 同一个采样累计点，不新建平行统计，也不进入公开 checkpoint。
 */

import type { AgentCheckpoint } from "../agent-runtime";

/** Turn 累计用量安全展示视图；Web/CLI 只能消费该 DTO，禁止自行重算或读取私有 anchor。 */
export interface TurnUsageSummaryView {
  /** 该汇总所属 Turn 身份；无 Turn 时不产生视图。 */
  turnId: string;
  /**
   * 本 Turn 累计输入 token（各次成功采样 inputTokens 之和）。
   * 只在与 outputTokens 一起构成完整分项（inputTokens + outputTokens === totalTokens）时提供；
   * 旧 checkpoint 缺少分项或跨版本继续执行造成分项不完整时整对省略，宿主不得补造。
   */
  inputTokens?: number;
  /** 本 Turn 累计输出 token；与 inputTokens 同时提供或同时省略。 */
  outputTokens?: number;
  /** 只有本Turn全部输出均有供应商推理明细时提供；已含在outputTokens中。 */
  reasoningTokens?: number;
  /** 本 Turn 累计输入+输出 token；与 Kernel 安全预算 runtimeBudget.totalTokens 同源，恒有值。 */
  totalTokens: number;
  /** 当前执行段耗时毫秒；以最近一次安全边界刷新的 checkpoint 为准，终态后不再增长。 */
  elapsedMs: number;
}

/** 非负安全整数判定；任何浮点、负数或超大值都不作为可信计量。 */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 从私有 runtimeBudget 构造 Turn 累计用量汇总。
 * 缺预算或总量非法时 fail closed 为 null；分项不完整时只保留总量与耗时，不拼凑部分分项。
 */
export function buildTurnUsageSummary(input: {
  turnId: string;
  runtimeBudget: AgentCheckpoint["runtimeBudget"];
}): TurnUsageSummaryView | null {
  const budget = input.runtimeBudget;
  if (!budget || !isTokenCount(budget.totalTokens) || !Number.isSafeInteger(budget.startedAt) || budget.startedAt < 0) return null;
  const hasCompleteSplit = isTokenCount(budget.inputTokens)
    && isTokenCount(budget.outputTokens)
    && budget.inputTokens + budget.outputTokens === budget.totalTokens;
  // 无 updatedAt（旧 checkpoint 未刷新过）时耗时按 0 处理，不把查询时刻当作结束时刻。
  const updatedAt = isTokenCount(budget.updatedAt) && budget.updatedAt >= budget.startedAt ? budget.updatedAt : budget.startedAt;
  return {
    turnId: input.turnId,
    ...(hasCompleteSplit ? { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens } : {}),
    ...(hasCompleteSplit && budget.reasoningReportedOutputTokens === budget.outputTokens && isTokenCount(budget.reasoningTokens) && budget.reasoningTokens <= budget.outputTokens! ? { reasoningTokens: budget.reasoningTokens } : {}),
    totalTokens: budget.totalTokens,
    elapsedMs: updatedAt - budget.startedAt,
  };
}

/**
 * 对外投影的安全白名单复制：只保留已冻结字段，丢弃任何多余属性；
 * 任一数值非法、分项不成对或求和不等时 fail closed 为 null。
 * 供 context_usage_updated 事件脱敏与 getTurnUsageSummary 查询共用，不信任对象形状。
 */
export function projectPublicTurnUsageSummary(summary: TurnUsageSummaryView | null | undefined): TurnUsageSummaryView | null {
  if (!summary || typeof summary.turnId !== "string" || summary.turnId.length === 0) return null;
  if (!isTokenCount(summary.totalTokens) || !isTokenCount(summary.elapsedMs)) return null;
  const hasSplit = summary.inputTokens !== undefined || summary.outputTokens !== undefined;
  if (hasSplit && (!isTokenCount(summary.inputTokens) || !isTokenCount(summary.outputTokens))) return null;
  if (hasSplit && summary.inputTokens! + summary.outputTokens! !== summary.totalTokens) return null;
  if (summary.reasoningTokens !== undefined && (!hasSplit || !isTokenCount(summary.reasoningTokens) || summary.reasoningTokens > summary.outputTokens!)) return null;
  return {
    turnId: summary.turnId,
    ...(hasSplit ? { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens } : {}),
    ...(summary.reasoningTokens !== undefined ? { reasoningTokens: summary.reasoningTokens } : {}),
    totalTokens: summary.totalTokens,
    elapsedMs: summary.elapsedMs,
  };
}