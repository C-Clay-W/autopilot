/** ContextUsageDetails.tsx — Context 条点击后的分类明细面板；只做 Core DTO 的固定中文映射、单位格式化与视觉 clamp，不重算任何 tokens 或百分比。 */
"use client";

import type { ContextUsageCategoryKind, ContextUsageView } from "@autopilot-agent/core";

interface ContextUsageDetailsProps {
  /** Core 最新安全 Context Usage 快照；undefined 表示无可用展示事实。 */
  usage: ContextUsageView | undefined;
  /** 当前会话是否允许触发 manual compact。 */
  canWrite: boolean;
  /** compact 请求进行中，禁用压缩入口。 */
  compacting: boolean;
  /** 关闭面板并打开既有 Popconfirm 二次确认；查看与压缩是两个明确步骤。 */
  onOpenCompactConfirm: () => void;
}

/** 固定分类枚举的中文 label 映射；顺序由 Core DTO 保证，不携带任何动态名称。 */
const CATEGORY_LABELS: Record<ContextUsageCategoryKind, string> = {
  system: "系统",
  instructions: "项目指令",
  memory: "Memory",
  skills: "Skills",
  tools: "工具",
  conversation: "对话",
  other: "其他",
  output_reserve: "输出预留",
};

/** 总体三态的稳定中文标签；实测只表示无本地增量，输出仍是预留。 */
const MEASUREMENT_LABELS: Record<ContextUsageView["measurement"], string> = {
  measured: "实测",
  projected: "预测",
  estimated: "估算",
};

/** 将非负 token 数格式化为千分位整数字符串；顶栏 title 与面板共用。 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/** 将比例格式化为一位小数百分比；小于 0.1% 但非零显示 <0.1%，不 clamp 文本真实值。 */
export function formatRatio(ratio: number): string {
  if (ratio > 0 && ratio < 0.001) return "<0.1%";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 渲染 Context 分类明细面板；unknown 时只显示未知说明，不渲染空分类、0% 或猜测窗口。 */
export default function ContextUsageDetails({ usage, canWrite, compacting, onOpenCompactConfirm }: ContextUsageDetailsProps) {
  if (!usage) {
    return (
      <div id="context-usage-details" className="absolute right-0 top-7 z-50 w-[min(22rem,calc(100vw-1rem))] border-2 border-ink bg-card p-3 text-xs shadow-[4px_4px_0_var(--ink)]">
        <p className="text-muted">当前上下文用量未知；完成一次可提供 usage 的模型响应后再校准</p>
        <button
          type="button"
          onClick={onOpenCompactConfirm}
          disabled={!canWrite || compacting}
          className="mt-3 border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {compacting ? "压缩中…" : "压缩上下文"}
        </button>
      </div>
    );
  }
  return (
    <div id="context-usage-details" className="absolute right-0 top-7 z-50 w-[min(22rem,calc(100vw-1rem))] border-2 border-ink bg-card p-3 text-xs shadow-[4px_4px_0_var(--ink)]">
      {/* 标题区：整体 projectedTokens / contextWindowTokens、总体百分比、三态标签、压缩阈值与分类估算提示。 */}
      <div className="space-y-1 border-b-2 border-ink pb-2">
        <p className="truncate font-semibold text-ink" title={usage.modelRef}>{usage.modelRef}</p>
        <p className="tabular-nums text-ink">
          {formatTokens(usage.projectedTokens)} / {formatTokens(usage.contextWindowTokens)} tokens · {formatRatio(usage.usageRatio)} · {MEASUREMENT_LABELS[usage.measurement]}
        </p>
        <p className="text-[10px] text-muted">
          {usage.measurement === "measured" ? "总量实测，分类估算" : "分类为本地估算"}；下一次输出预留 {formatTokens(usage.outputReserveTokens)} tokens
        </p>
        <p className="text-[10px] text-muted">压缩阈值 {formatTokens(usage.compactTriggerTokens)} tokens{usage.compactNeeded ? " · 已达到" : ""}</p>
      </div>
      {/* 分类列表：按 Core 固定枚举顺序逐项展示，零值或缺失分类不渲染。 */}
      <ul role="list" className="space-y-2 py-2">
        {usage.breakdown.categories.map((category) => (
          <li key={category.kind}>
            <div className="flex items-baseline justify-between gap-2 text-ink">
              <span>
                {CATEGORY_LABELS[category.kind]}
                {category.kind === "memory" || category.kind === "skills" ? ` · ${category.itemCount ?? 0} 项` : ""}
                {category.kind === "output_reserve" ? "（预留）" : ""}
              </span>
              <span className="tabular-nums">{formatTokens(category.tokens)}</span>
            </div>
            <div className="flex justify-between text-[10px] text-muted tabular-nums">
              <span>占窗口 {formatRatio(category.windowRatio)}</span>
              <span>占预计 {formatRatio(category.projectedRatio)}</span>
            </div>
            {/* 比例条只做视觉投影；名称与数字独立完整，不依赖颜色传达状态。 */}
            <div className="mt-1 h-1.5 border border-ink bg-bg">
              <div
                className={category.kind === "output_reserve" ? "h-full bg-accent" : "h-full bg-ink"}
                style={{ width: `${Math.min(Math.max(category.windowRatio, 0), 1) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {/* 底部分区：free/buffer 不作为已用内容分类加入求和；超限文本保留真实值。 */}
      <div className="space-y-0.5 border-t-2 border-ink pt-2 text-[10px] text-muted tabular-nums">
        <p>距压缩阈值的可用空间：{formatTokens(usage.breakdown.freeTokens)}（{formatRatio(usage.breakdown.freeRatio)}）</p>
        <p>Compact buffer：{formatTokens(usage.breakdown.compactBufferTokens)}（{formatRatio(usage.breakdown.compactBufferRatio)}）</p>
        {usage.breakdown.overLimitTokens > 0 && <p className="text-accent">超出窗口：{formatTokens(usage.breakdown.overLimitTokens)}（{formatRatio(usage.breakdown.overLimitRatio)}）</p>}
      </div>
      <button
        type="button"
        onClick={onOpenCompactConfirm}
        disabled={!canWrite || compacting}
        className="mt-3 border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {compacting ? "压缩中…" : "压缩上下文"}
      </button>
    </div>
  );
}
