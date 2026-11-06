/** r006主子交互标签、底部状态与r005会话标题回归。 */
import { expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getCliInteractionLabel } from "../../../src/tui/session-manager.js";
import { TuiStatusLine } from "../../../src/tui/status-line.js";
it.each(["approved", "denied"] as const)("r006 %s失败和等待恢复不显示待审批，标题保留", async function decidedLabel(decision) {
 for (const state of ["failed", "pending", "claimed"] as const) {
  const view: any = { interaction: { state: "decided", decision, continuation: { state } } };
  const label = getCliInteractionLabel(view)!;
  expect(label).toBe(`${decision === "approved" ? "已批准" : "决定已保存"}，${state === "failed" ? "恢复失败" : "等待恢复"}`);
  const ink = render(<TuiStatusLine snapshot={{ status: "waiting_approval" } as any} interactionLabel={label} sessionTitle="r005会话标题" screenReader={false} useColor={false} />);
  try { await new Promise(function frame(resolve) { setTimeout(resolve, 30); }); expect(ink.lastFrame()).toContain(label); expect(ink.lastFrame()).toContain("会话：r005会话标题"); expect(ink.lastFrame()).not.toContain("Waiting approval"); } finally { ink.unmount(); }
 }
 expect(getCliInteractionLabel({ interaction: { state: "pending" } } as any)).toBeUndefined();
});
