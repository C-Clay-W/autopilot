/** 本任务 CLI 定向回归：真实投影/Store 在审批、中断和恢复间累计执行段且不重排 Prompt。 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@autopilot-agent/core";
import { createCliEventProjector } from "../../../src/event-projector.js";
import { createCliTuiStore } from "../../../src/tui/store.js";
import { getCliTuiExecutionMs } from "../../../src/tui/types.js";

/** 使用同一个可控权威时钟投影真实事件并交给 TUI Store。 */
function fixture() {
  let now = 0;
  const projector = createCliEventProjector({ sessionId: "s", now: function time() { return new Date(now); } });
  const store = createCliTuiStore();
  function feed(seconds: number, value: Record<string, unknown>) {
    now = seconds * 1000;
    vi.setSystemTime(now);
    const result = projector.project({ turnId: "t", ...value } as AgentEvent);
    const event = result.projection.events.at(-1)!;
    store.acceptEvent(event, result.projection);
  }
  return { projector, store, feed };
}

describe("manual CLI execution", function suite() {
  it("审批冻结、中断撤卡、恢复保留原累计并更新终态，Prompt 保留原顺序", function lifecycle() {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.store.recordPrompt("原任务");
      f.feed(0, { type: "turn_started", stepCount: 0 });
      f.feed(10, { type: "approval_required", stepId: "step", callId: "call", toolName: "write_file", result: { status: "approval_required", approval: { approvalId: "old", allowedDecisions: ["allow_once", "deny"] } } });
      expect(getCliTuiExecutionMs(f.store.getSnapshot().liveMetrics!, 90000)).toBe(10000);
      f.feed(100, { type: "turn_interrupted", checkpoint: { turnId: "t", status: "interrupted_recoverable" }, termination: { reason: "cancelled", recoverable: true } });
      expect(f.store.getSnapshot().pendingApproval).toBeUndefined();
      f.projector.restore({ sessionId: "s", turnId: "t", status: "interrupted_recoverable", recoverable: true, lastSeq: 3, activeSkills: [] });
      f.feed(200, { type: "turn_started", stepCount: 1 });
      expect(getCliTuiExecutionMs(f.store.getSnapshot().liveMetrics!, 205000)).toBe(15000);
      f.feed(220, { type: "answer_delta", stepId: "answer", delta: "已完成" });
      f.feed(230, { type: "turn_completed", checkpoint: { turnId: "t", status: "completed" } });
      const snapshot = f.store.getSnapshot();
      expect(getCliTuiExecutionMs(snapshot.liveMetrics!, 999000)).toBe(40000);
      const completed = snapshot.transcript.filter(function turn(item) { return item.kind === "turn"; });
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ status: "completed", totalDurationMs: 40000 });
      expect(snapshot.transcript[0]).toMatchObject({ kind: "prompt", content: "原任务" });
    } finally { vi.useRealTimers(); }
  });
});
