/** 受控基础流程图：宿主计算有界布局，以安全 SVG 文本和连线绘制，并保留文字关系。 */
"use client";

import { useId } from "react";
import type { InteractiveUiProps } from "../context";

interface FlowNode { id: string; label: string; kind?: "process" | "decision" | "terminal" }
interface FlowEdge { id: string; from: string; to: string; label?: string }

/** 从入度为零节点分层；已访问边不再推进层次，因此分支、回路和孤立节点都能有界布局。 */
function layoutNodes(nodes: FlowNode[], edges: FlowEdge[], horizontal: boolean) {
  const ranks = new Map<string, number>();
  const roots = nodes.filter(function root(node) { return !edges.some(function incoming(edge) { return edge.to === node.id && edge.from !== edge.to; }); });
  const queue = (roots.length ? roots : nodes.slice(0, 1)).map(function seed(node) { ranks.set(node.id, 0); return node.id; });
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const edge of edges) if (edge.from === id && !ranks.has(edge.to)) { ranks.set(edge.to, ranks.get(id)! + 1); queue.push(edge.to); }
  }
  let lastRank = Math.max(0, ...ranks.values());
  for (const node of nodes) if (!ranks.has(node.id)) ranks.set(node.id, ++lastRank);
  const counts = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const rank = ranks.get(node.id)!;
    const slot = counts.get(rank) ?? 0;
    counts.set(rank, slot + 1);
    positions.set(node.id, horizontal ? { x: 180 + rank * 360, y: 140 + slot * 240 } : { x: 180 + slot * 360, y: 140 + rank * 240 });
  }
  return positions;
}

interface Point { x: number; y: number }
interface Box { left: number; right: number; top: number; bottom: number }

/** 仅在单词边界或中文字符间折行，避免拆开 Final Answer 等短英文。 */
function labelLines(label: string): string[] {
  const words = label.match(/[A-Za-z0-9]{1,14}|[^A-Za-z0-9]/gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length > 14 && line.trim()) { lines.push(line.trim()); line = ""; }
    line += word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/** 检查轴对齐线段是否进入矩形内部；边界通道可安全共用。 */
function crosses(a: Point, b: Point, box: Box): boolean {
  return a.x === b.x
    ? a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom
    : a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right;
}

/** 在节点外沿构成的正交网格上寻最短路；只允许水平或竖直相邻点。 */
function route(start: Point, end: Point, boxes: Box[], lane: number): Point[] {
  const xs = [...new Set([start.x, end.x, lane, ...boxes.flatMap(function sides(box) { return [box.left, box.right]; })])].sort(function order(a, b) { return a - b; });
  const ys = [...new Set([start.y, end.y, lane, ...boxes.flatMap(function sides(box) { return [box.top, box.bottom]; })])].sort(function order(a, b) { return a - b; });
  const startId = ys.indexOf(start.y) * xs.length + xs.indexOf(start.x);
  const endId = ys.indexOf(end.y) * xs.length + xs.indexOf(end.x);
  const distances = new Map<number, number>([[startId, 0]]);
  const previous = new Map<number, number>();
  const open = new Set([startId]);
  /** 按网格索引恢复实际坐标。 */
  function point(id: number): Point { return { x: xs[id % xs.length], y: ys[Math.floor(id / xs.length)] }; }
  while (open.size) {
    let current = -1;
    let best = Infinity;
    for (const id of open) {
      const p = point(id);
      const score = distances.get(id)! + Math.abs(p.x - end.x) + Math.abs(p.y - end.y);
      if (score < best) { best = score; current = id; }
    }
    if (current === endId) {
      const path = [point(current)];
      while (previous.has(current)) { current = previous.get(current)!; path.unshift(point(current)); }
      return path;
    }
    open.delete(current);
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    for (const next of [x > 0 ? current - 1 : -1, x + 1 < xs.length ? current + 1 : -1, y > 0 ? current - xs.length : -1, y + 1 < ys.length ? current + xs.length : -1]) {
      if (next < 0) continue;
      const a = point(current);
      const b = point(next);
      if (boxes.some(function blocked(box) { return crosses(a, b, box); })) continue;
      const distance = distances.get(current)! + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (distance >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, distance); previous.set(next, current); open.add(next);
    }
  }
  throw new Error("流程图正交通道不可达");
}

/** 计算受控节点边界、正交避障线路及不覆盖任意线路的标签位置，供渲染和几何验收共用。 */
export function createFlowchartGeometry(nodes: FlowNode[], edges: FlowEdge[], horizontal: boolean) {
  const positions = layoutNodes(nodes, edges, horizontal);
  const boxes = nodes.map(function bounds(node) {
    const p = positions.get(node.id)!;
    const halfWidth = node.kind === "decision" ? 112 : 90;
    const halfHeight = node.kind === "decision" ? 64 : 46;
    return { left: p.x - halfWidth - 22, right: p.x + halfWidth + 22, top: p.y - halfHeight - 22, bottom: p.y + halfHeight + 22 };
  });
  const paths = edges.map(function edgePath(edge, index) {
    const a = positions.get(edge.from)!;
    const b = positions.get(edge.to)!;
    const source = nodes.find(function own(node) { return node.id === edge.from; })!;
    const target = nodes.find(function own(node) { return node.id === edge.to; })!;
    const forward = horizontal ? b.x > a.x : b.y > a.y;
    const sign = forward ? 1 : -1;
    const start = { x: a.x + (horizontal ? sign * (source.kind === "decision" ? 112 : 90) : 0), y: a.y + (horizontal ? 0 : sign * (source.kind === "decision" ? 64 : 46)) };
    const end = { x: b.x - (horizontal ? sign * (target.kind === "decision" ? 112 : 90) : 0), y: b.y - (horizontal ? 0 : sign * (target.kind === "decision" ? 64 : 46)) };
    const exit = { x: start.x + (horizontal ? sign * 22 : 0), y: start.y + (horizontal ? 0 : sign * 22) };
    const entry = { x: end.x - (horizontal ? sign * 22 : 0), y: end.y - (horizontal ? 0 : sign * 22) };
    return { edge, points: [start, ...route(exit, entry, boxes, 30 + index * 3), end] };
  });
  const occupied: Box[] = [...boxes];
  const routed = paths.map(function placeLabel(item) {
    let label: Point | undefined;
    if (item.edge.label) {
      const width = Array.from(item.edge.label).length * 12 + 12;
      for (let index = 1; index < item.points.length && !label; index++) {
        const a = item.points[index - 1]; const b = item.points[index];
        for (const side of [-1, 1]) {
          const center = { x: (a.x + b.x) / 2 + (a.x === b.x ? side * (width / 2 + 8) : 0), y: (a.y + b.y) / 2 + (a.y === b.y ? side * 20 : 0) };
          const box = { left: center.x - width / 2, right: center.x + width / 2, top: center.y - 9, bottom: center.y + 9 };
          if (box.left < 0 || box.top < 0 || occupied.some(function overlap(other) { return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top; })) continue;
          if (paths.some(function intersects(path) { return path.points.some(function segment(p, i) { return i > 0 && crosses(path.points[i - 1], p, box); }); })) continue;
          label = center; occupied.push(box); break;
        }
      }
    }
    return { ...item, label, path: item.points.map(function command(point, index) { return `${index ? "L" : "M"}${point.x},${point.y}`; }).join(" ") };
  });
  return { positions, edges: routed, width: Math.max(360, ...occupied.map(function right(box) { return box.right + 30; })), height: Math.max(240, ...occupied.map(function bottom(box) { return box.bottom + 30; })) };
}

/** 使用宿主固定几何样式渲染基本节点/分支/回路；超宽图只在自身容器滚动。 */
export default function Flowchart({ element }: InteractiveUiProps) {
  const { nodes, edges, direction, description } = element.props as unknown as { nodes: FlowNode[]; edges: FlowEdge[]; direction: "TB" | "LR"; description: string };
  const marker = `flow-${useId().replace(/:/g, "")}`;
  const horizontal = direction === "LR";
  const { positions, edges: routed, width, height } = createFlowchartGeometry(nodes, edges, horizontal);
  const labels = new Map(nodes.map(function label(node) { return [node.id, node.label]; }));
  return <figure className="min-w-0 space-y-2">
    <figcaption className="whitespace-pre-wrap break-words text-sm text-ink">{description}</figcaption>
    <div className="max-h-[36rem] max-w-full overflow-auto border-2 border-ink bg-bg p-2" tabIndex={0} role="region" aria-label="流程图，可滚动查看">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} className="max-w-none text-ink">
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {routed.map(function drawEdge(item) {
          return <g key={item.edge.id}><path d={item.path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${marker})`} />{item.label && <text x={item.label.x} y={item.label.y + 4} textAnchor="middle" className="fill-current text-xs">{item.edge.label}</text>}</g>;
        })}
        {nodes.map(function drawNode(node) {
          const point = positions.get(node.id)!;
          const lines = labelLines(node.label);
          return <g key={node.id} transform={`translate(${point.x},${point.y})`}>
            {node.kind === "decision" ? <path d="M0,-64 L112,0 L0,64 L-112,0 Z" className="fill-card stroke-ink" strokeWidth="2" /> : <rect x="-90" y="-46" width="180" height="92" rx={node.kind === "terminal" ? 44 : 0} className="fill-card stroke-ink" strokeWidth="2" />}
            <text textAnchor="middle" className="fill-current text-xs">{lines.map(function line(text, index) { return <tspan x="0" y={(index - (lines.length - 1) / 2) * 16 + 4} key={index}>{text}</tspan>; })}</text>
          </g>;
        })}
      </svg>
    </div>
    <details className="text-xs text-muted"><summary className="cursor-pointer">节点与连线文字说明</summary><ul className="mt-2 space-y-1">{nodes.map(function node(item) { return <li key={item.id}>{item.label}（{item.kind === "decision" ? "分支" : item.kind === "terminal" ? "起止" : "步骤"}）</li>; })}{edges.map(function relation(edge) { return <li key={`edge-${edge.id}`}>{labels.get(edge.from)} → {labels.get(edge.to)}{edge.label ? `：${edge.label}` : ""}</li>; })}</ul></details>
  </figure>;
}
