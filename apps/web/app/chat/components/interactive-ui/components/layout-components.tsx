/** Intelligent UI 的纸本布局组件，只消费 Core 白名单的有限布局值。 */
"use client";

import type { InteractiveUiProps } from "../context";

const gaps: Record<number, string> = { 4: "gap-1", 8: "gap-2", 12: "gap-3", 16: "gap-4" };

/** 以有限方向和间距排列子节点，不把模型字符串用作 CSS。 */
function Stack({ element, children }: InteractiveUiProps) {
  return <div className={`flex min-w-0 ${element.props.direction === "row" ? "flex-row flex-wrap items-start" : "flex-col"} ${gaps[Number(element.props.gap)]}`}>{children}</div>;
}

/** 窄屏保持单列，宽屏按白名单列数排布。 */
function Grid({ element, children }: InteractiveUiProps) {
  const columns: Record<number, string> = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" };
  return <div className={`grid min-w-0 grid-cols-1 ${columns[Number(element.props.columns)]} ${gaps[Number(element.props.gap)]}`}>{children}</div>;
}

/** 以粗直角边框承载生成内容。 */
function Card({ element, children }: InteractiveUiProps) {
  return <section className="min-w-0 border-2 border-ink bg-card p-3">{element.props.title && <h4 className="mb-3 break-words text-sm font-semibold">{String(element.props.title)}</h4>}{children}</section>;
}

export { Card, Grid, Stack };
