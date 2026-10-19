/** Web 活动状态机测试：验证 CLI 同构阶段、answer_delta 实时响应与 stalled 边界。 */

import { describe, expect, it } from "vitest";
import { reduceWebActivityState, resolveWebActivityView } from "@/lib/runtime-host/web-activity";

describe("web activity state", function webActivitySuite() {
  it("收到 answer_delta 后立即进入输出中", function entersRespondingOnAnswerDelta() {
    const started = reduceWebActivityState(undefined, { type: "turn_started", turnId: "turn-1", timestamp: "2026-08-26T00:00:00.000Z" });
    const responding = reduceWebActivityState(started, { type: "answer_delta", turnId: "turn-1", timestamp: "2026-08-26T00:00:01.000Z" });

    expect(responding?.phase).toBe("responding");
    expect(resolveWebActivityView({ activity: responding!, running: true, now: Date.parse("2026-08-26T00:00:01.100Z") })?.label).toBe("正在输出回答");
  });

  it("工具过场先显示启动，超过边界后显示等待或 stalled", function settlesToolAndStallPhases() {
    const started = reduceWebActivityState(undefined, { type: "turn_started", turnId: "turn-1", timestamp: "2026-08-26T00:00:00.000Z" });
    const tool = reduceWebActivityState(started, { type: "tool_started", turnId: "turn-1", timestamp: "2026-08-26T00:00:01.000Z" });
    const waiting = resolveWebActivityView({ activity: tool!, running: true, now: Date.parse("2026-08-26T00:00:03.100Z") });
    const result = reduceWebActivityState(tool, { type: "tool_result", turnId: "turn-1", timestamp: "2026-08-26T00:00:04.000Z" });
    const stalled = resolveWebActivityView({ activity: result!, running: true, now: Date.parse("2026-08-26T00:00:25.100Z") });

    expect(waiting?.phase).toBe("waiting");
    expect(stalled?.phase).toBe("stalled");
  });

  it("终态停止活动视图", function stopsAtTerminalEvent() {
    const started = reduceWebActivityState(undefined, { type: "turn_started", turnId: "turn-1", timestamp: "2026-08-26T00:00:00.000Z" });
    const terminal = reduceWebActivityState(started, { type: "turn_completed", turnId: "turn-1", timestamp: "2026-08-26T00:00:01.000Z" });

    expect(resolveWebActivityView({ activity: terminal!, running: true, now: Date.parse("2026-08-26T00:00:02.000Z") })).toBeUndefined();
  });
});
