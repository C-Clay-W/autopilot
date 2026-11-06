/** Intelligent UI 的惰性图形绘制适配；颜色只使用纸本设计 token。 */
"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { ChartProps } from "../context";

/** 合并图形坐标而不覆盖同名系列；数据表仍逐系列保留原始值。 */
export function createChartRows(series: ChartProps["series"]): Array<Record<string, number | null>> {
  const rows = new Map<number, Record<string, number | null>>();
  series.forEach(function addSeries(item, index) {
    item.points.forEach(function addPoint(point) { const row = rows.get(point.x) ?? { x: point.x }; row[`s${index}`] = point.y; rows.set(point.x, row); });
  });
  return [...rows.values()].sort(function order(a, b) { return Number(a.x) - Number(b.x); });
}

/** 图形关闭动画，并使用 token 与线型共同区分有限数量的系列。 */
export default function ChartPlot({ type, series, xLabel, yLabel, yMin, yMax }: ChartProps) {
  const chart = type === "LineChart";
  const Container = chart ? LineChart : BarChart;
  return <div className="h-56 w-full min-w-0 text-ink" role="img" aria-label={`${xLabel ?? "X"} / ${yLabel ?? "数值"}；下方提供完整数据表`}><ResponsiveContainer width="100%" height="100%" minWidth={0}><Container data={createChartRows(series)} accessibilityLayer><CartesianGrid stroke="var(--ink)" strokeOpacity={0.15} /><XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} stroke="var(--ink)" tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis domain={[yMin ?? "auto", yMax ?? "auto"]} stroke="var(--ink)" tick={{ fill: "var(--muted)", fontSize: 11 }} width={72} /><Legend />{series.map(function plot(item, index) { return chart ? <Line key={index} dataKey={`s${index}`} name={item.name} stroke={index === 0 ? "var(--accent)" : "var(--ink)"} strokeDasharray={[undefined, "6 3", "2 3", "8 3 2 3"][index]} dot={false} isAnimationActive={false} connectNulls={false} /> : <Bar key={index} dataKey={`s${index}`} name={item.name} fill={index === 0 ? "var(--accent)" : "var(--ink)"} fillOpacity={1 - index * 0.2} isAnimationActive={false} />; })}</Container></ResponsiveContainer></div>;
}
