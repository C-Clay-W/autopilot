/** r006 Web只验证共享Core非终态等待事件的既有活动/说明投影，不启动浏览器。 */
import { expect, it } from "vitest";
import { reduceWebActivityState, resolveWebActivityView } from "@/lib/runtime-host/web-activity";
import { projectEvents } from "@/lib/runtime-host/web-message-projection";
import type { AgentEventEnvelope } from "@autopilot-agent/core";

it("同Turn协作等待说明保持非终态活动，子结果到达后才以父终态收口", function sharedWaitProjection() {
  const waiting = [
    { seq: 1, sessionId: "parent", turnId: "parent-turn", timestamp: new Date(1).toISOString(), event: { type: "turn_started", turnId: "parent-turn", stepCount: 0 } },
    { seq: 2, sessionId: "parent", turnId: "parent-turn", timestamp: new Date(2).toISOString(), event: { type: "reasoning_summary", turnId: "parent-turn", stepId: "s", summary: "正在持续观察协作任务；等待审批期间可取消或补充要求" } },
  ] as AgentEventEnvelope[];
  let activity; for (const envelope of waiting) activity = reduceWebActivityState(activity, envelope.event);
  expect(resolveWebActivityView({ activity: activity!, running: true, now: 100 })?.phase).not.toBe("terminal");
  expect(projectEvents(waiting).processSteps.some(function wait(step) { return step.message.includes("等待审批"); })).toBe(true);
  activity = reduceWebActivityState(activity, { type: "turn_completed", turnId: "parent-turn" });
  expect(resolveWebActivityView({ activity: activity!, running: false, now: 200 })).toBeUndefined();
});
