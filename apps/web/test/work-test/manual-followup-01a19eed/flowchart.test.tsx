/** 本轮流程图几何回归：非敏感分支回路在TB/LR下保持正交、端口和可见标签。 */
import { describe, expect, it } from "vitest";
import { createFlowchartGeometry } from "../../../app/chat/components/interactive-ui/components/Flowchart";

const nodes = [
  { id: "start", label: "Start", kind: "terminal" as const },
  { id: "think", label: "Think" },
  { id: "decide", label: "Need Action", kind: "decision" as const },
  { id: "act", label: "Call Tool" },
  { id: "finish", label: "Final Answer", kind: "terminal" as const },
  { id: "observe", label: "Observe" },
  { id: "retry", label: "Retry", kind: "decision" as const },
  { id: "error", label: "Error" },
];
const edges = [
  ["start", "think"], ["think", "decide"], ["decide", "act", "Yes"], ["decide", "finish", "No"],
  ["act", "observe"], ["observe", "retry"], ["retry", "think", "Continue"], ["retry", "error", "Failed"], ["error", "act", "Retry"],
].map(function edge(item, index) { return { id: `edge-${index}`, from: item[0], to: item[1], label: item[2] }; });

for (const direction of ["TB", "LR"]) describe(direction, function directionTests() {
  it("九条连线轴对齐且不穿无关节点，分支和回路标签均有位置", function geometry() {
    const geometry = createFlowchartGeometry(nodes, edges, direction === "LR");
    expect(geometry.edges).toHaveLength(9);
    for (const item of geometry.edges) {
      expect(item.path).not.toMatch(/[CQ]/u);
      if (item.edge.label) expect(item.label, item.edge.id).toBeDefined();
      for (let index = 1; index < item.points.length; index++) {
        const a = item.points[index - 1]; const b = item.points[index];
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const node of nodes) {
          if ([item.edge.from, item.edge.to].includes(node.id)) continue;
          const p = geometry.positions.get(node.id)!;
          const hw = node.kind === "decision" ? 112 : 90;
          const hh = node.kind === "decision" ? 64 : 46;
          const crossed = a.x === b.x ? a.x > p.x - hw && a.x < p.x + hw && Math.max(a.y, b.y) > p.y - hh && Math.min(a.y, b.y) < p.y + hh : a.y > p.y - hh && a.y < p.y + hh && Math.max(a.x, b.x) > p.x - hw && Math.min(a.x, b.x) < p.x + hw;
          expect(crossed, `${item.edge.id} crosses ${node.id}`).toBe(false);
        }
      }
      const source = nodes.find(function source(node) { return node.id === item.edge.from; })!;
      const p = geometry.positions.get(source.id)!; const anchor = item.points[0];
      expect(direction === "LR" ? Math.abs(anchor.x - p.x) : Math.abs(anchor.y - p.y)).toBe(source.kind === "decision" ? direction === "LR" ? 112 : 64 : direction === "LR" ? 90 : 46);
    }
  });
});
