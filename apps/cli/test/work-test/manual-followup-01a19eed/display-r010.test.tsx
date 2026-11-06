/** r010回归：真实Ink组件只保留总耗时，Provider失败原因不被通用终态吞掉。 */
import { createElement, Fragment } from "react";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { createInitialCliActivityState, TuiActivityLine } from "../../../src/activity-animation.js";
import { createTuiAnimationClock } from "../../../src/animation-clock.js";
import { TuiStatusLine } from "../../../src/tui/status-line.js";
import { createCliTuiStore } from "../../../src/tui/store.js";
import { renderTimeline } from "../../../src/tui/timeline/static-timeline.js";
import { TuiLiveTurn } from "../../../src/tui/timeline/turn.js";
import { getTuiTerminationSummary } from "../../../src/tui/format.js";
import type { CliTuiTimelineEvent } from "../../../src/tui/types.js";

/** 构造仅含白名单安全字段的真实失败序列。 */
function failedEvents(): CliTuiTimelineEvent[] {
  return [{ type: "status", seq: 24, turnId: "test-turn", status: "failed", code: "PROVIDER_SERVER_ERROR", reason: "供应商服务暂时不可用", providerHttpStatus: 503, termination: { recoverable: false } }];
}

it("活动与底部用量不重复计时，历史只保留一条总耗时", function singleTotalDuration() {
  const clock = createTuiAnimationClock({ now: function now() { return 123_000; } });
  const snapshot = { ...createCliTuiStore().getSnapshot(), status: "running" as const };
  const activity = render(createElement(TuiActivityLine, { activity: createInitialCliActivityState(0), status: "running", waitingForApproval: false, useColor: false, screenReader: false, reducedMotion: true, animationActive: false, clock, elapsedMs: 123_000, runningSince: 0 }));
  const bottom = render(createElement(TuiStatusLine, { snapshot, statusView: { model: "test", effort: "medium", permissionMode: "ask", source: "runtime_default", turnUsage: { turnId: "test-turn", inputTokens: 12, outputTokens: 3, totalTokens: 15, elapsedMs: 123_000 } }, useColor: false, screenReader: false }));
  const history = render(createElement(Fragment, null, ...renderTimeline([{ type: "answer_delta", seq: 1, turnId: "test-turn", delta: "已完成" }], false, { thoughtDurationMs: 20_000, totalDurationMs: 123_000, status: "completed" })));
  try {
    expect(activity.lastFrame()).toContain("Still working");
    expect(activity.lastFrame()).not.toMatch(/no new event for|\d+s/);
    expect(bottom.lastFrame()).toContain("12 in / 3 out");
    expect(bottom.lastFrame()).not.toContain("2m 03s");
    expect(history.lastFrame()).toContain("Cogitated for 2m 03s");
    expect(history.lastFrame()).not.toContain("Thought for");
  } finally { activity.unmount(); bottom.unmount(); history.unmount(); clock.dispose(); }
});

it("503原因与不可继续在live和历史同时可见，恢复后不复活旧失败", function providerFailureVisible() {
  const events = failedEvents();
  const history = render(createElement(Fragment, null, ...renderTimeline(events, false, { status: "failed" })));
  const live = render(createElement(TuiLiveTurn, { turnId: "test-turn", events, status: "failed", approvalSelectedIndex: 0, useColor: false, screenReader: false, todoExpanded: false, maximumWidth: 160 }));
  try {
    for (const frame of [history.lastFrame(), live.lastFrame()]) {
      expect(frame).toContain("供应商服务暂时不可用");
      expect(frame).toContain("HTTP 状态：503");
      expect(frame).toContain("不可继续");
    }
    expect(getTuiTerminationSummary(events, "running")).toBeUndefined();
    expect(getTuiTerminationSummary([...events, { type: "status", seq: 25, turnId: "test-turn", status: "running" }])).toBeUndefined();
  } finally { history.unmount(); live.unmount(); }
});
