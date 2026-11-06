/** Intelligent UI 图表组件；按需加载无动画图形并始终提供完整数据表。 */
"use client";

import { Component, lazy, Suspense, type ReactNode } from "react";
import type { InteractiveUiProps, ChartProps } from "../context";
import { UiNodeFallback } from "./content";

const ChartPlot = lazy(function loadChart() { return import("./ChartPlot"); });

/** 图形失败时只隐藏图形，保留可读表格数据。 */
class PlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  /** 把异步 chunk 与图形组件错误收敛成固定本地状态。 */
  static getDerivedStateFromError() {
    return { failed: true };
  }

  /** 不向用户显示底层异常。 */
  render() {
    return this.state.failed ? <p className="text-xs text-muted">图形暂时不可用，请查看下方数据表。</p> : this.props.children;
  }
}

/** 按系列输出每个原始点，不丢弃不同 x 坐标的数据。 */
function ChartData({ series, xLabel, yLabel, unit }: ChartProps) {
  return <details className="mt-2"><summary className="cursor-pointer text-xs text-muted focus-visible:outline-2 focus-visible:outline-accent">查看图表数据</summary><div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><caption className="sr-only">图表完整数据</caption><thead><tr><th scope="col" className="p-2">系列</th><th scope="col" className="p-2">{xLabel ?? "X"}</th><th scope="col" className="p-2">{yLabel ?? "数值"}{unit ? `（${unit}）` : ""}</th></tr></thead><tbody>{series.flatMap(function rows(item, index) { return item.points.map(function point(point, pointIndex) { return <tr key={`${index}:${pointIndex}`} className="border-t border-ink/20"><th scope="row" className="p-2 font-normal">{item.name}</th><td className="p-2 tabular-nums">{point.x}</td><td className="p-2 tabular-nums">{point.y === null ? "无数据" : point.y}</td></tr>; }); })}</tbody></table></div></details>;
}

/** 仅当序列已归一为数据数组时显示图表，并保留表格替代。 */
function Chart({ element }: InteractiveUiProps) {
  if (!Array.isArray(element.props.series)) return <UiNodeFallback />;
  const props = { ...element.props, type: element.type } as unknown as ChartProps;
  return <figure className="min-w-0" aria-label={props.title ?? "数据图表"}>{props.title && <figcaption className="mb-2 text-sm font-semibold">{props.title}</figcaption>}<PlotBoundary><Suspense fallback={<p className="text-xs text-muted">图表加载中，数据表可用。</p>}><ChartPlot {...props} /></Suspense></PlotBoundary><ChartData {...props} /></figure>;
}

export default Chart;
