/**
 * Kernel context 预算器：以最近真实 Provider usage 为锚点，只估算锚点后新增消息。
 * 本文件不触发 compact，仅为后续 Step 的安全边界状态机提供纯计算；
 * 并在同一总量算法之上生成面向展示的安全 ContextUsageView 投影（Talk-Plan0828 Stage 1）。
 */

import type { AgentCheckpoint } from "../agent-runtime";
import { getUsageAnchorRequestSignature } from "../agent-runtime";
import type { AgentMessage } from "../types/agent-message";
import type { AgentModelToolDefinition } from "../lib/llm";
import type { ModelSampleOptions } from "../types";
import { estimateMessageTokens } from "./compact";

/** 单次模型采样的保守 context 预算结果；不含 Provider 原始 payload。 */
export interface ContextBudgetSnapshot {
  source: "provider" | "estimated";
  inputTokens: number;
  outputReserveTokens: number;
  totalTokens: number;
}

/** 请求组装分类的固定来源枚举；只表达类别，不携带正文、路径或动态名称。 */
export type ContextUsageCategoryKind =
  | "system"
  | "instructions"
  | "memory"
  | "skills"
  | "tools"
  | "conversation"
  | "other"
  | "output_reserve";

/** 固定枚举顺序；分类输出、去重与求和校验都依赖该顺序。 */
const CONTEXT_USAGE_CATEGORY_ORDER: readonly ContextUsageCategoryKind[] = ["system", "instructions", "memory", "skills", "tools", "conversation", "other", "output_reserve"];

/** 请求组装阶段维护的单条分类贡献：估算权重只用于分布，绝不反过来决定 compact 总量。 */
export interface ContextUsageContribution {
  kind: ContextUsageCategoryKind;
  /** 与总量同一估算器得到的权重；仅在最大余数归一时使用。 */
  weight: number;
  /** 仅 memory/skills 允许的聚合注入项数量；不携带名称、路径或 ID。 */
  count?: number;
}

/** 单个分类的安全展示视图。 */
export interface ContextUsageCategoryView {
  kind: ContextUsageCategoryKind;
  tokens: number;
  /** 只允许 memory/skills 提供聚合数量；不携带名称、路径或 ID。 */
  itemCount?: number;
  /** 本分类占完整模型窗口的比例。 */
  windowRatio: number;
  /** 本分类占 projectedTokens 的比例。 */
  projectedRatio: number;
  /** 内容分类均为估算；输出预留是冻结配置值。 */
  measurement: "estimated" | "reserved";
}

/** 与 projectedTokens 严格对齐的安全分类分布。 */
export interface ContextUsageBreakdownView {
  /** 固定枚举顺序输出；零值分类省略，宿主不得补造。 */
  categories: ContextUsageCategoryView[];
  /** 距 compact trigger 尚可使用的空间；达到 trigger 后为 0。 */
  freeTokens: number;
  freeRatio: number;
  /** context window 中由 compact policy 预留的固定安全区。 */
  compactBufferTokens: number;
  compactBufferRatio: number;
  /** projectedTokens 超过模型窗口的部分；未超限时为 0。 */
  overLimitTokens: number;
  overLimitRatio: number;
  /** Provider 不提供逐分类 usage，因此内容分类只能是估算。 */
  measurement: "estimated";
}

/** Core 安全边界同时生成的上下文用量展示快照；Web/CLI 只能消费该 DTO，禁止自行重算。 */
export interface ContextUsageView {
  /** 当前 Turn 冻结模型的安全展示引用；不得包含 endpoint、credential 或任意动态标签。 */
  modelRef: string;
  /** 当前 Turn 冻结模型的完整 context window。 */
  contextWindowTokens: number;
  /** 最近可信 Provider 完整响应的 context token；无锚点时省略。 */
  providerMeasuredTokens?: number;
  /** 锚点后或全量本地估算的新增/当前输入 token。 */
  estimatedAddedTokens: number;
  /** 下一次采样前预计已占用的输入上下文，不含输出预留。 */
  currentContextTokens: number;
  /** 当前冻结 sampleOptions 为下一次输出保留的 token。 */
  outputReserveTokens: number;
  /** Core 按冻结窗口、输出预留和 safety buffer 得出的真实 compact 门槛。 */
  compactTriggerTokens: number;
  /** currentContextTokens + outputReserveTokens。 */
  projectedTokens: number;
  /** projectedTokens / contextWindowTokens；不在 Core clamp。 */
  usageRatio: number;
  /** projectedTokens 是否已达到 Core 的 compactTriggerTokens。 */
  compactNeeded: boolean;
  /** measured=无本地增量；projected=Provider 锚点+增量估算；estimated=无可信锚点。 */
  measurement: "measured" | "projected" | "estimated";
  /** 与 projectedTokens 严格对齐的安全分类分布。 */
  breakdown: ContextUsageBreakdownView;
}

/** 为工具定义生成内容无关的稳定签名；schema 改变时强制回退为完整估算。 */
export function getToolSignature(tools: AgentModelToolDefinition[]): string {
  return JSON.stringify(tools.map(function toStableTool(tool) {
    return { name: tool.function.name, parameters: tool.function.parameters };
  }));
}

/** 用与总量一致的估算器计算工具 schema 权重；只用于分类分布。 */
export function estimateToolSignatureTokens(tools: AgentModelToolDefinition[]): number {
  return Math.ceil(Buffer.byteLength(getToolSignature(tools), "utf8") / 4);
}

/** 估算完整请求的消息、工具 schema 与输出预留；只用于无可信 usage anchor 的保守降级。 */
export function estimateContextBudget(
  messages: AgentMessage[],
  tools: AgentModelToolDefinition[],
  outputReserveTokens: number,
): ContextBudgetSnapshot {
  const inputTokens = estimateMessageTokens(messages) + estimateToolSignatureTokens(tools);
  return { source: "estimated", inputTokens, outputReserveTokens, totalTokens: inputTokens + outputReserveTokens };
}

/** 基于可信 anchor 计算预算；消息或 tools 已重建时回退完整估算，禁止累计历史 usage。 */
export function calculateContextBudget(
  checkpoint: AgentCheckpoint | undefined,
  messages: AgentMessage[],
  tools: AgentModelToolDefinition[],
  outputReserveTokens: number,
): ContextBudgetSnapshot {
  const anchor = checkpoint?.usageAnchor;
  if (!anchor || anchor.messageCount > messages.length || anchor.toolSignature !== getToolSignature(tools)) {
    return estimateContextBudget(messages, tools, outputReserveTokens);
  }
  const addedTokens = estimateMessageTokens(messages.slice(anchor.messageCount));
  const inputTokens = anchor.usage.contextTokens + addedTokens;
  return { source: "provider", inputTokens, outputReserveTokens, totalTokens: inputTokens + outputReserveTokens };
}

/** 判断数字是否为非负安全整数。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 判断数字是否为非负有限数；比例允许小数但不允许 NaN/Infinity。 */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 比例一致性比较；浮点比例只允许舍入级别的误差。 */
function isRatioCloseTo(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

/** 判断是否为允许进入内容分布的固定 kind；output_reserve 只能来自冻结输出预留。 */
function isKnownContentKind(kind: unknown): kind is ContextUsageCategoryKind {
  return typeof kind === "string" && kind !== "output_reserve" && CONTEXT_USAGE_CATEGORY_ORDER.includes(kind as ContextUsageCategoryKind);
}

/** 对生成的 ContextUsageView 做运行时断言；任一求和、比例或数字非法时 fail closed 返回 null。 */
export function assertContextUsageView(view: ContextUsageView): ContextUsageView | null {
  if (typeof view?.modelRef !== "string" || view.modelRef.length === 0) return null;
  if (!isNonNegativeSafeInteger(view.contextWindowTokens) || view.contextWindowTokens === 0) return null;
  if (!isNonNegativeSafeInteger(view.currentContextTokens) || !isNonNegativeSafeInteger(view.outputReserveTokens)
    || !isNonNegativeSafeInteger(view.compactTriggerTokens) || !isNonNegativeSafeInteger(view.projectedTokens)
    || !isNonNegativeSafeInteger(view.estimatedAddedTokens)) return null;
  if (view.providerMeasuredTokens !== undefined && !isNonNegativeSafeInteger(view.providerMeasuredTokens)) return null;
  if (view.compactTriggerTokens <= 0 || view.compactTriggerTokens > view.contextWindowTokens) return null;
  if (view.projectedTokens !== view.currentContextTokens + view.outputReserveTokens) return null;
  if (view.compactNeeded !== (view.projectedTokens >= view.compactTriggerTokens)) return null;
  if (!isNonNegativeFinite(view.usageRatio) || !isRatioCloseTo(view.usageRatio, view.projectedTokens / view.contextWindowTokens)) return null;
  if (view.measurement === "measured") {
    if (view.providerMeasuredTokens === undefined || view.estimatedAddedTokens !== 0) return null;
  } else if (view.measurement === "projected") {
    if (view.providerMeasuredTokens === undefined || view.estimatedAddedTokens <= 0) return null;
  } else if (view.measurement === "estimated") {
    if (view.providerMeasuredTokens !== undefined || view.estimatedAddedTokens !== view.currentContextTokens) return null;
  } else return null;

  const breakdown = view.breakdown;
  if (!breakdown || breakdown.measurement !== "estimated" || !Array.isArray(breakdown.categories)) return null;
  if (!isNonNegativeSafeInteger(breakdown.freeTokens) || !isNonNegativeSafeInteger(breakdown.compactBufferTokens) || !isNonNegativeSafeInteger(breakdown.overLimitTokens)) return null;
  if (!isNonNegativeFinite(breakdown.freeRatio) || !isNonNegativeFinite(breakdown.compactBufferRatio) || !isNonNegativeFinite(breakdown.overLimitRatio)) return null;

  let lastIndex = -1;
  let contentSum = 0;
  let reservedSum = 0;
  for (const category of breakdown.categories) {
    const kindIndex = CONTEXT_USAGE_CATEGORY_ORDER.indexOf(category?.kind);
    if (kindIndex < 0 || kindIndex <= lastIndex) return null;
    lastIndex = kindIndex;
    if (!isNonNegativeSafeInteger(category.tokens)) return null;
    if (!isNonNegativeFinite(category.windowRatio) || !isNonNegativeFinite(category.projectedRatio)) return null;
    if (!isRatioCloseTo(category.windowRatio, category.tokens / view.contextWindowTokens)) return null;
    if (!isRatioCloseTo(category.projectedRatio, view.projectedTokens > 0 ? category.tokens / view.projectedTokens : 0)) return null;
    if (category.itemCount !== undefined) {
      if (category.kind !== "memory" && category.kind !== "skills") return null;
      if (!isNonNegativeSafeInteger(category.itemCount)) return null;
    }
    if (category.kind === "output_reserve") {
      if (category.measurement !== "reserved") return null;
      reservedSum += category.tokens;
    } else {
      if (category.measurement !== "estimated") return null;
      contentSum += category.tokens;
    }
  }
  if (contentSum !== view.currentContextTokens) return null;
  if (contentSum + reservedSum !== view.projectedTokens) return null;

  const expectedFree = Math.max(view.compactTriggerTokens - view.projectedTokens, 0);
  const expectedBuffer = view.contextWindowTokens - view.compactTriggerTokens;
  const expectedOverLimit = Math.max(view.projectedTokens - view.contextWindowTokens, 0);
  if (breakdown.freeTokens !== expectedFree || breakdown.compactBufferTokens !== expectedBuffer || breakdown.overLimitTokens !== expectedOverLimit) return null;
  if (!isRatioCloseTo(breakdown.freeRatio, expectedFree / view.contextWindowTokens)) return null;
  if (!isRatioCloseTo(breakdown.compactBufferRatio, expectedBuffer / view.contextWindowTokens)) return null;
  if (!isRatioCloseTo(breakdown.overLimitRatio, expectedOverLimit / view.contextWindowTokens)) return null;
  if (view.projectedTokens <= view.compactTriggerTokens) {
    if (view.projectedTokens + breakdown.freeTokens + breakdown.compactBufferTokens !== view.contextWindowTokens) return null;
  } else if (view.projectedTokens + breakdown.compactBufferTokens !== view.contextWindowTokens + (view.projectedTokens - view.compactTriggerTokens)) return null;
  return view;
}

/**
 * 对外投影的安全白名单复制：只保留已冻结字段，丢弃任何多余属性；
 * 先过运行时断言，任一求和、比例或数字非法时 fail closed 为 null。
 * 供 context_usage_updated 事件脱敏与 getContextUsage 查询共用，不能因它是对象就原样信任。
 */
export function projectPublicContextUsage(usage: ContextUsageView | null | undefined): ContextUsageView | null {
  if (!usage) return null;
  const asserted = assertContextUsageView(usage);
  if (!asserted) return null;
  return {
    modelRef: asserted.modelRef,
    contextWindowTokens: asserted.contextWindowTokens,
    ...(asserted.providerMeasuredTokens !== undefined ? { providerMeasuredTokens: asserted.providerMeasuredTokens } : {}),
    estimatedAddedTokens: asserted.estimatedAddedTokens,
    currentContextTokens: asserted.currentContextTokens,
    outputReserveTokens: asserted.outputReserveTokens,
    compactTriggerTokens: asserted.compactTriggerTokens,
    projectedTokens: asserted.projectedTokens,
    usageRatio: asserted.usageRatio,
    compactNeeded: asserted.compactNeeded,
    measurement: asserted.measurement,
    breakdown: {
      categories: asserted.breakdown.categories.map(function copyCategory(category) {
        return {
          kind: category.kind,
          tokens: category.tokens,
          ...(category.itemCount !== undefined ? { itemCount: category.itemCount } : {}),
          windowRatio: category.windowRatio,
          projectedRatio: category.projectedRatio,
          measurement: category.measurement,
        };
      }),
      freeTokens: asserted.breakdown.freeTokens,
      freeRatio: asserted.breakdown.freeRatio,
      compactBufferTokens: asserted.breakdown.compactBufferTokens,
      compactBufferRatio: asserted.breakdown.compactBufferRatio,
      overLimitTokens: asserted.breakdown.overLimitTokens,
      overLimitRatio: asserted.breakdown.overLimitRatio,
      measurement: asserted.breakdown.measurement,
    },
  };
}

/** Context Usage 投影的输入；总量与 compact 共用 calculateContextBudget，禁止另建平行计算。 */
export interface ContextUsageProjectionInput {
  /** 私有 checkpoint 的相关切片：usageAnchor 决定三态总量，contextUsage 作为恢复基线。 */
  checkpoint?: Pick<AgentCheckpoint, "usageAnchor" | "contextUsage">;
  messages: AgentMessage[];
  tools: AgentModelToolDefinition[];
  /** 当前进程内请求组装维护的分类贡献账本；恢复的 Turn 只包含安全边界后的新增贡献。 */
  contributions?: ContextUsageContribution[];
  /** 账本是否覆盖全部消息：新 Turn 请求组装或 compact 重建后为 true。 */
  contributionsComplete?: boolean;
  /** 冻结模型完整窗口；缺失时投影返回 null，不猜测窗口。 */
  contextWindowTokens?: number;
  outputReserveTokens: number;
  compactTriggerTokens: number;
  modelRef?: string;
  /** 当前冻结采样配置；用于验证 anchor 覆盖前缀的请求签名。 */
  sampleOptions?: ModelSampleOptions;
}

/** 校验投影边界输入；窗口或阈值非法时返回 false，不产生伪值。 */
function hasValidProjectionBounds(input: ContextUsageProjectionInput): boolean {
  if (!isNonNegativeSafeInteger(input.contextWindowTokens) || !input.contextWindowTokens) return false;
  if (!isNonNegativeSafeInteger(input.outputReserveTokens)) return false;
  if (!isNonNegativeSafeInteger(input.compactTriggerTokens) || input.compactTriggerTokens <= 0 || input.compactTriggerTokens > input.contextWindowTokens) return false;
  return typeof input.modelRef === "string" && input.modelRef.length > 0;
}

/** 校验单条账本贡献；未知 kind、负权重或错误位置的 itemCount 都视为账本损坏。 */
function isValidContribution(entry: ContextUsageContribution): boolean {
  if (!isKnownContentKind(entry.kind) || !isNonNegativeSafeInteger(entry.weight)) return false;
  if (entry.count !== undefined) {
    if ((entry.kind !== "memory" && entry.kind !== "skills") || !isNonNegativeSafeInteger(entry.count)) return false;
  }
  return true;
}

/** 把权重累加进内容分布；memory/skills 额外聚合注入项数量。 */
function accumulateWeight(
  weights: Map<ContextUsageCategoryKind, { weight: number; count?: number }>,
  kind: ContextUsageCategoryKind,
  weight: number,
  count?: number,
): void {
  const entry = weights.get(kind) ?? { weight: 0, ...(kind === "memory" || kind === "skills" ? { count: 0 } : {}) };
  entry.weight += weight;
  if (entry.count !== undefined && count !== undefined) entry.count += count;
  weights.set(kind, entry);
}

/** 最大余数法：把内容分类权重确定性地归一为非负整数，使合计严格等于 total。 */
function normalizeContentWeights(
  weights: Map<ContextUsageCategoryKind, { weight: number; count?: number }>,
  total: number,
): Array<{ kind: ContextUsageCategoryKind; tokens: number; count?: number }> {
  if (total <= 0) return [];
  const entries = CONTEXT_USAGE_CATEGORY_ORDER
    .filter((kind) => kind !== "output_reserve" && weights.has(kind))
    .map((kind) => ({ kind, ...weights.get(kind)! }));
  const weightSum = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (entries.length === 0 || weightSum <= 0) return [{ kind: "other", tokens: total }];
  const allocated = entries.map((entry) => {
    const exact = (entry.weight / weightSum) * total;
    return { ...entry, exact, tokens: Math.floor(exact) };
  });
  let remaining = total - allocated.reduce((sum, entry) => sum + entry.tokens, 0);
  // 同余数按固定枚举顺序决胜：排序输入已按固定顺序构造，稳定排序保持决胜规则。
  const byRemainder = [...allocated].sort((left, right) => (right.exact - right.tokens) - (left.exact - left.tokens));
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    entry.tokens += 1;
    remaining -= 1;
  }
  return allocated.map(({ kind, tokens, count }) => ({ kind, tokens, ...(count !== undefined && count > 0 ? { count } : {}) }));
}

/**
 * 基于与 compact 共用的总量算法生成安全展示投影。
 * 计算顺序：窗口/预留校验 → anchor 边界、tool signature 与请求签名验证 → 三态总量 →
 * 分类权重（完整账本 / checkpoint 基线 + 新增贡献 / other 兜底）→ 最大余数归一 → 运行时断言。
 * 任一步骤失败都返回 null，绝不发送部分明细、NaN 或 Infinity。
 */
export function projectContextUsage(input: ContextUsageProjectionInput): ContextUsageView | null {
  if (!hasValidProjectionBounds(input)) return null;
  const anchor = input.checkpoint?.usageAnchor;
  // 验证 anchor 覆盖前缀与冻结采样配置的签名；模型/采样配置变化时禁止继承旧 usage。
  const effectiveAnchor = anchor?.requestSignature
    && getUsageAnchorRequestSignature(input.messages.slice(0, anchor.messageCount), input.sampleOptions) !== anchor.requestSignature
    ? undefined
    : anchor;
  const anchorCheckpoint: AgentCheckpoint | undefined = effectiveAnchor
    ? { turnId: "context-usage-projection", status: "running", stepCount: 0, messages: [], completedCallIds: [], usageAnchor: effectiveAnchor }
    : undefined;
  const budget = calculateContextBudget(anchorCheckpoint, input.messages, input.tools, input.outputReserveTokens);
  const measured = budget.source === "provider" && effectiveAnchor !== undefined;
  // 展示口径：锚点后无新增消息时增量为 0（估算器对空切片的 JSON 包装开销不计入 measured 真值）。
  const addedTokens = measured && input.messages.length > effectiveAnchor!.messageCount
    ? estimateMessageTokens(input.messages.slice(effectiveAnchor!.messageCount))
    : 0;
  const currentContextTokens = measured ? effectiveAnchor!.usage.contextTokens + addedTokens : budget.inputTokens;
  const projectedTokens = currentContextTokens + input.outputReserveTokens;
  const measurement: ContextUsageView["measurement"] = measured
    ? (addedTokens > 0 ? "projected" : "measured")
    : "estimated";
  const estimatedAddedTokens = measured ? addedTokens : currentContextTokens;

  const contentWeights = new Map<ContextUsageCategoryKind, { weight: number; count?: number }>();
  const baselineCategories = input.contributionsComplete || !input.checkpoint?.contextUsage
    ? undefined
    : input.checkpoint.contextUsage.breakdown?.categories;
  if (input.contributionsComplete && input.contributions) {
    // 完整账本模式：新 Turn 请求组装或 compact 重建后，内容与工具 schema 全部可精确归类。
    for (const entry of input.contributions) {
      if (!isValidContribution(entry)) return null;
      if (entry.kind === "tools") continue;
      accumulateWeight(contentWeights, entry.kind, entry.weight, entry.count);
    }
    accumulateWeight(contentWeights, "tools", estimateToolSignatureTokens(input.tools));
  } else if (baselineCategories) {
    // 恢复模式：不回读正文重建分类，以 checkpoint 安全 breakdown 为基线，仅追加新增贡献；
    // 工具 schema 始终按当前冻结 tools 输入重新计权，避免继承过期权重。
    for (const category of baselineCategories) {
      if (category.kind === "output_reserve" || category.kind === "tools") continue;
      if (!isKnownContentKind(category.kind) || !isNonNegativeSafeInteger(category.tokens)) return null;
      accumulateWeight(contentWeights, category.kind, category.tokens, category.itemCount);
    }
    for (const entry of input.contributions ?? []) {
      if (!isValidContribution(entry)) return null;
      if (entry.kind === "tools") continue;
      accumulateWeight(contentWeights, entry.kind, entry.weight, entry.count);
    }
    accumulateWeight(contentWeights, "tools", estimateToolSignatureTokens(input.tools));
  } else {
    // 无账本且无基线（如旧 checkpoint）：整体回退为 other/estimated，不伪造已知分类。
    for (const entry of input.contributions ?? []) {
      if (!isValidContribution(entry)) return null;
    }
  }

  const categories: ContextUsageCategoryView[] = [];
  for (const item of normalizeContentWeights(contentWeights, currentContextTokens)) {
    if (item.tokens <= 0) continue;
    categories.push({
      kind: item.kind,
      tokens: item.tokens,
      ...(item.count !== undefined ? { itemCount: item.count } : {}),
      windowRatio: item.tokens / input.contextWindowTokens!,
      projectedRatio: projectedTokens > 0 ? item.tokens / projectedTokens : 0,
      measurement: "estimated",
    });
  }
  if (input.outputReserveTokens > 0) {
    categories.push({
      kind: "output_reserve",
      tokens: input.outputReserveTokens,
      windowRatio: input.outputReserveTokens / input.contextWindowTokens!,
      projectedRatio: projectedTokens > 0 ? input.outputReserveTokens / projectedTokens : 0,
      measurement: "reserved",
    });
  }

  const freeTokens = Math.max(input.compactTriggerTokens - projectedTokens, 0);
  const compactBufferTokens = input.contextWindowTokens! - input.compactTriggerTokens;
  const overLimitTokens = Math.max(projectedTokens - input.contextWindowTokens!, 0);
  return assertContextUsageView({
    modelRef: input.modelRef!,
    contextWindowTokens: input.contextWindowTokens!,
    ...(measured ? { providerMeasuredTokens: effectiveAnchor!.usage.contextTokens } : {}),
    estimatedAddedTokens,
    currentContextTokens,
    outputReserveTokens: input.outputReserveTokens,
    compactTriggerTokens: input.compactTriggerTokens,
    projectedTokens,
    usageRatio: projectedTokens / input.contextWindowTokens!,
    compactNeeded: projectedTokens >= input.compactTriggerTokens,
    measurement,
    breakdown: {
      categories,
      freeTokens,
      freeRatio: freeTokens / input.contextWindowTokens!,
      compactBufferTokens,
      compactBufferRatio: compactBufferTokens / input.contextWindowTokens!,
      overLimitTokens,
      overLimitRatio: overLimitTokens / input.contextWindowTokens!,
      measurement: "estimated",
    },
  });
}
