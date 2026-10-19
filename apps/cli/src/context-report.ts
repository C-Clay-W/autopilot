/**
 * Context Usage 安全报告格式化。
 *
 * 所有输入只来自 Core 白名单 ContextUsageView DTO；宿主只做展示转换，
 * 不重算 token、不猜测窗口、不为非零分类强塞至少一格。
 */

import type { ContextUsageCategoryView, ContextUsageView } from "@autopilot-agent/core";

/** Core 固定枚举到 CLI 稳定中文标签的映射；不携带动态名称。 */
const CONTEXT_CATEGORY_LABELS: Readonly<Record<ContextUsageCategoryView["kind"], string>> = {
  system: "系统",
  instructions: "项目指令",
  memory: "Memory",
  skills: "Skills",
  tools: "工具",
  conversation: "对话",
  other: "其他",
  output_reserve: "输出预留",
};

/** Memory/Skills 以聚合行展示，不再出现在固定分类列表。 */
const AGGREGATED_CATEGORY_KINDS: ReadonlySet<ContextUsageCategoryView["kind"]> = new Set(["memory", "skills"]);

/** 1M 及以上窗口在相同列数下提供更细的网格分辨率。 */
const HIGH_RESOLUTION_WINDOW_TOKENS = 1_000_000;

/** 千分位数字格式；固定 locale 保证 Plain/JSONL/TUI 输出稳定。 */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/** 百分比格式；usageRatio 不在 Core clamp，允许显示超过 100% 的真实值。 */
function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 单条分类的稳定文本行；expanded 追加 projected 比例。 */
function formatCategoryLine(category: ContextUsageCategoryView, expanded: boolean): string {
  const label = CONTEXT_CATEGORY_LABELS[category.kind];
  const items = category.itemCount !== undefined ? ` · ${formatTokens(category.itemCount)} items` : "";
  const reserved = category.measurement === "reserved" ? " (reserved)" : "";
  const base = `${label}: ${formatTokens(category.tokens)} tokens${items} (${formatPercent(category.windowRatio)} window)${reserved}`;
  return expanded ? `${base} · ${formatPercent(category.projectedRatio)} projected` : base;
}

/** Memory/Skills 聚合行；expanded 时补充 Core 已提供的窗口占比与 projected 占比。 */
function formatAggregatedCategoryLine(category: ContextUsageCategoryView, expanded: boolean): string | undefined {
  const label = category.kind === "memory" ? "Memory files" : "Skills";
  const items = category.itemCount !== undefined ? `${formatTokens(category.itemCount)} items · ` : "";
  const base = `${label}: ${items}${formatTokens(category.tokens)} tokens`;
  return expanded ? `${base} (${formatPercent(category.windowRatio)} window) · ${formatPercent(category.projectedRatio)} projected` : base;
}

/** 右侧信息区的稳定文本行；字段顺序固定，供 Plain/TUI/视口共用。 */
function formatContextSummaryLines(usage: ContextUsageView, expanded: boolean): string[] {
  const lines = [
    `model: ${usage.modelRef}`,
    `projected: ${formatTokens(usage.projectedTokens)} / ${formatTokens(usage.contextWindowTokens)} tokens (${formatPercent(usage.usageRatio)} projected) · ${usage.measurement}`,
    "usage by category (estimated):",
  ];
  for (const category of usage.breakdown.categories) {
    if (AGGREGATED_CATEGORY_KINDS.has(category.kind)) continue;
    lines.push(`  ${formatCategoryLine(category, expanded)}`);
  }
  lines.push(
    `Free space: ${formatTokens(usage.breakdown.freeTokens)} tokens (${formatPercent(usage.breakdown.freeRatio)})`,
    `Autocompact buffer: ${formatTokens(usage.breakdown.compactBufferTokens)} tokens (${formatPercent(usage.breakdown.compactBufferRatio)})`,
  );
  for (const category of usage.breakdown.categories) {
    if (!AGGREGATED_CATEGORY_KINDS.has(category.kind)) continue;
    const aggregated = formatAggregatedCategoryLine(category, expanded);
    if (aggregated) lines.push(aggregated);
  }
  return lines;
}

/** /context all 的安全展开块；只补充 DTO 已有字段，不生成派生结论。 */
function formatContextDetailLines(usage: ContextUsageView): string[] {
  const lines = [
    "Context usage details (all):",
    `overall measurement: ${usage.measurement}`,
    `breakdown measurement: ${usage.breakdown.measurement}`,
    `provider measured: ${usage.providerMeasuredTokens !== undefined ? `${formatTokens(usage.providerMeasuredTokens)} tokens` : "not available"}`,
    `estimated added: ${formatTokens(usage.estimatedAddedTokens)} tokens`,
    `current context: ${formatTokens(usage.currentContextTokens)} tokens`,
    `output reserve: ${formatTokens(usage.outputReserveTokens)} tokens`,
    `compact trigger: ${formatTokens(usage.compactTriggerTokens)} tokens`,
    `compact needed: ${usage.compactNeeded ? "yes" : "no"}`,
    `free: ${formatTokens(usage.breakdown.freeTokens)} tokens (${formatPercent(usage.breakdown.freeRatio)})`,
    `compact buffer: ${formatTokens(usage.breakdown.compactBufferTokens)} tokens (${formatPercent(usage.breakdown.compactBufferRatio)})`,
    `over limit: ${formatTokens(usage.breakdown.overLimitTokens)} tokens (${formatPercent(usage.breakdown.overLimitRatio)})`,
  ];
  return lines;
}

/** 网格尺寸：窄屏降列数，>=1M 窗口提升行数（Plan 9.5）。 */
function resolveGridShape(usage: ContextUsageView, columns: number): { cols: number; rows: number } {
  const highResolution = usage.contextWindowTokens >= HIGH_RESOLUTION_WINDOW_TOKENS;
  if (columns < 80) return { cols: 5, rows: highResolution ? 10 : 5 };
  return { cols: highResolution ? 20 : 10, rows: 10 };
}

/** 用最大余数法把 window 分配到固定格子；零份额分类不保留格子。 */
function allocateGridCells(shares: number[], totalCells: number, windowTokens: number): number[] {
  const raw = shares.map(function toFraction(tokens): number { return tokens / windowTokens * totalCells; });
  const base = raw.map(function floorShare(value): number { return Math.floor(value); });
  let remaining = totalCells - base.reduce(function sumCells(total, cells): number { return total + cells; }, 0);
  const order = raw
    .map(function toRemainder(value, index): { index: number; remainder: number } { return { index, remainder: value - Math.floor(value) }; })
    .sort(function byRemainderDesc(left, right): number { return right.remainder - left.remainder || left.index - right.index; });
  for (const item of order) {
    if (remaining <= 0) break;
    base[item.index] += 1;
    remaining -= 1;
  }
  return base;
}

/** 渲染网格行：已用/侵入 buffer/free/剩余 buffer 使用不同单格宽字符。 */
function renderGridLines(usage: ContextUsageView, columns: number): string[] {
  const { cols, rows } = resolveGridShape(usage, columns);
  const projected = Math.min(usage.projectedTokens, usage.contextWindowTokens);
  const usedMain = Math.min(projected, usage.compactTriggerTokens);
  const usedBuffer = Math.max(projected - usage.compactTriggerTokens, 0);
  const free = Math.max(usage.breakdown.freeTokens, 0);
  const bufferRemaining = Math.max(usage.breakdown.compactBufferTokens - usedBuffer, 0);
  const counts = allocateGridCells([usedMain, usedBuffer, free, bufferRemaining], cols * rows, usage.contextWindowTokens);
  const glyphs = ["█", "▓", "░", "▒"];
  // 按份额顺序展开为每格字符；未分配格子保持空白。
  const cellGlyphs: string[] = [];
  counts.forEach(function expandCells(count, shareIndex): void {
    for (let index = 0; index < count; index += 1) cellGlyphs.push(glyphs[shareIndex] ?? " ");
  });
  // Array.from 回调首参是 element，行号在第二参；用错会把行号算成 NaN 并全部回退空格。
  return Array.from({ length: rows }, function buildRow(_element: unknown, rowIndex: number): string {
    let line = "";
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      line += cellGlyphs[rowIndex * cols + colIndex] ?? " ";
    }
    return line;
  });
}

/**
 * 生成 Context 报告文本行。
 * grid=false（Plain/screen reader/NO_COLOR）跳过装饰网格但保留完整文本；
 * 列数不足以并排时整体改为上下堆叠。
 */
export function formatContextReportLines(
  usage: ContextUsageView | null,
  expanded: boolean,
  options: { grid: boolean; columns: number },
): string[] {
  if (!usage) return ["Context: unknown"];
  const rightLines = formatContextSummaryLines(usage, expanded);
  if (expanded) rightLines.push(...formatContextDetailLines(usage));
  if (!options.grid) {
    return ["Context Usage", ...rightLines, "", "/context all to expand"];
  }
  const gridLines = renderGridLines(usage, options.columns);
  const gridWidth = gridLines.reduce(function maxGridWidth(width, line): number { return Math.max(width, line.length); }, 0);
  const stackVertically = gridWidth + 2 + 30 > options.columns;
  const rows: string[] = ["Context Usage"];
  if (stackVertically) {
    rows.push(...gridLines, ...rightLines);
  } else {
    const height = Math.max(gridLines.length, rightLines.length);
    for (let index = 0; index < height; index += 1) {
      const gridLine = (gridLines[index] ?? "").padEnd(gridWidth, " ");
      rows.push(`${gridLine}  ${rightLines[index] ?? ""}`.trimEnd());
    }
  }
  rows.push("", "/context all to expand");
  return rows;
}

/** Plain/非 TTY 的稳定文本报告；始终跳过装饰网格。 */
export function formatPlainContextReport(usage: ContextUsageView | null, expanded: boolean): string[] {
  return formatContextReportLines(usage, expanded, { grid: false, columns: Number.MAX_SAFE_INTEGER });
}

/** 状态栏只显示整个窗口的整数剩余百分比；计量来源留在 /context all。 */
export function formatTuiContextStatus(usage: ContextUsageView | null): string {
  if (!usage) return "unknown";
  return `${Math.round(Math.max(0, 1 - usage.usageRatio) * 100)}%`;
}
