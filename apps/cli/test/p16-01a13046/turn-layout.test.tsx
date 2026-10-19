/** P16 组合回归：真实 Store 与 Presentation 的跨轮布局、输入竞态及共享活动时钟。 */
import { createElement } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@autopilot-agent/core";
import { createCliEventProjector } from "../../src/event-projector.js";
import { createCliTuiStore } from "../../src/tui/store.js";
import { CliTuiApp } from "../../src/tui/app.js";
import { TuiLiveTurn } from "../../src/tui/timeline/turn.js";
import { renderTimeline } from "../../src/tui/timeline/static-timeline.js";
import { createTuiViewportSourceCache, createTuiViewportSources } from "../../src/tui/viewport/sources.js";
import { createTuiAnimationClock } from "../../src/animation-clock.js";
import { createInitialCliActivityState, TuiActivityLine } from "../../src/activity-animation.js";
import type { CliController, CliControllerResult } from "../../src/controller.js";

/** 将公开事件交给真实投影器与 Store，不读取 checkpoint 正文。 */
function createHarness() {
  const store = createCliTuiStore();
  const projector = createCliEventProjector({ sessionId: "p16" });
  function emit(event: Record<string, unknown>): void {
    const before = projector.getProjection().events.length;
    projector.project(event as unknown as AgentEvent);
    const projection = projector.getProjection();
    for (const publicEvent of projection.events.slice(before)) store.acceptEvent(publicEvent, projection);
  }
  function text(cached = false): string {
    const snapshot = store.getSnapshot();
    const sources = cached ? createTuiViewportSourceCache().getSources(snapshot, undefined, 0, 100) : createTuiViewportSources(snapshot, undefined, 0, 100);
    return sources.map(function line(source) { return source.text; }).join("\n");
  }
  function finish(turnId: string, status = "completed"): void {
    emit({ type: status === "completed" ? "turn_completed" : status === "failed" ? "turn_failed" : "turn_interrupted", turnId, checkpoint: { turnId, status, stepCount: 1, completedCallIds: [], consumedInputIds: [] } });
  }
  return { store, projector, emit, text, finish };
}

/** 比较实际文本的顺序与唯一性，覆盖跨渲染出口的用户可见事实。 */
function expectOrder(text: string, parts: string[]): void {
  let previous = -1;
  for (const part of parts) {
    const current = text.indexOf(part);
    expect(current, part).toBeGreaterThan(previous);
    previous = current;
  }
}

describe("P16 Turn layout", function p16Suite() {
  it("多引导回调反序仍按提交位置拆分回答且原文只出现一次", function preservesSubmissionOrder() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "第一段" });
    const first = h.store.captureInputPosition();
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "第二段" });
    const second = h.store.captureInputPosition();
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "第三段" });
    h.store.addPendingPrompt("引导二\n@docs/b.md", { inputId: "two", delivery: "steer" }, second);
    h.store.addPendingPrompt("  引导一\n@docs/a.md  ", { inputId: "one", delivery: "steer" }, first);
    for (const cached of [false, true]) {
      const text = h.text(cached);
      expectOrder(text, ["第一段", "引导一", "第二段", "引导二", "第三段"]);
      expect(text.split("引导一")).toHaveLength(2);
    }
    const snapshot = h.store.getSnapshot();
    const ink = render(createElement(TuiLiveTurn, { turnId: "A", events: snapshot.liveEvents, presentation: snapshot.livePresentation, status: "running", approvalSelectedIndex: 0, useColor: false, screenReader: true, todoExpanded: false, maximumWidth: 100 }));
    expectOrder(ink.lastFrame() ?? "", ["第一段", "引导一", "第二段", "引导二", "第三段"]);
    ink.unmount();
    const fallback = render(createElement(Box, { flexDirection: "column" }, ...renderTimeline(snapshot.liveEvents, false, undefined, 100, true)));
    expectOrder(fallback.lastFrame() ?? "", ["第一段", "引导一", "第二段", "引导二", "第三段"]);
    fallback.unmount();
    const hosts = snapshot.liveEvents.filter(function host(event): event is Extract<typeof event, { type: "tui_input_consumed" }> { return event.type === "tui_input_consumed"; });
    expect(hosts.map(function id(event) { return event.inputId; })).toEqual(["one", "two"]);
  });

  it("同一边界多引导回调反序不倒排，消费后保持原位", function sameBoundary() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    const first = h.store.captureInputPosition();
    const second = h.store.captureInputPosition();
    h.store.addPendingPrompt("第二引导", { inputId: "two", delivery: "steer" }, second);
    h.store.addPendingPrompt("第一引导", { inputId: "one", delivery: "steer" }, first);
    h.emit({ type: "input_consumed", turnId: "A", inputId: "one", checkpoint: { turnId: "A", status: "running", stepCount: 1, messages: [], completedCallIds: [], consumedInputIds: ["one"] } });
    h.emit({ type: "input_consumed", turnId: "A", inputId: "two", checkpoint: { turnId: "A", status: "running", stepCount: 1, messages: [], completedCallIds: [], consumedInputIds: ["one", "two"] } });
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "后续回答" });
    expectOrder(h.text(), ["第一引导", "第二引导", "后续回答"]);
    expect(h.store.getSnapshot().pendingInputs).toEqual([]);
  });

  it("终态及下一轮早于确认回调时仍修补原轮历史", function lateConfirmation() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "原轮前文" });
    const position = h.store.captureInputPosition();
    h.emit({ type: "input_consumed", turnId: "A", inputId: "late", checkpoint: { turnId: "A", status: "running", stepCount: 1, messages: [], completedCallIds: [], consumedInputIds: ["late"] } });
    h.finish("A");
    h.emit({ type: "turn_started", turnId: "B", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "B", stepId: "s", delta: "下一轮正文" });
    h.store.addPendingPrompt("晚确认原文", { inputId: "late", delivery: "steer" }, position);
    h.store.addPendingPrompt("晚确认原文", { inputId: "late", delivery: "steer" }, position);
    expectOrder(h.text(true), ["原轮前文", "晚确认原文", "Cogitated for", "下一轮正文"]);
    expect(h.text().split("晚确认原文")).toHaveLength(2);
    expect(h.store.getSnapshot().pendingInputs).toEqual([]);
  });

  it("queue 等待显示原文，提前领取后只在新轮首条输入呈现原文", function earlyQueueClaim() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    const position = h.store.captureInputPosition();
    h.store.markQueuedInputStarted({ inputId: "queue", delivery: "queue", turnId: "B", content: "PRIVATE_ATTACHMENT_EXPANSION" });
    h.emit({ type: "turn_started", turnId: "B", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "B", stepId: "s", delta: "新轮回答" });
    h.store.addPendingPrompt("队列原文 @docs/a.md", { inputId: "queue", delivery: "queue" }, position);
    expectOrder(h.text(), ["队列原文", "新轮回答"]);
    expect(h.text()).not.toContain("PRIVATE_ATTACHMENT_EXPANSION");
    expect(h.store.getSnapshot().pendingInputs).toEqual([]);
  });

  it("queue 确认后在等待区可见，领取后等待区移除且新轮只保留一份", function normalQueue() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    h.store.addPendingPrompt("等待队列原文", { inputId: "queue", delivery: "queue" }, h.store.captureInputPosition());
    expect(h.text()).toContain("等待队列原文\n[排队]");
    h.finish("A");
    h.store.markQueuedInputStarted({ inputId: "queue", delivery: "queue", turnId: "B", content: "附件展开不显示" });
    h.emit({ type: "turn_started", turnId: "B", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "B", stepId: "s", delta: "队列开始正文" });
    expectOrder(h.text(true), ["Cogitated for", "等待队列原文", "队列开始正文"]);
    expect(h.text().split("等待队列原文")).toHaveLength(2);
    expect(h.text()).not.toContain("等待当前步骤结束");
  });

  it("Esc 后晚确认引导仍归原轮并标为取消，不恢复等待态", function cancelledLateInput() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    const position = h.store.captureInputPosition();
    h.store.setCancellationRequested(true);
    h.finish("A", "interrupted");
    h.emit({ type: "turn_started", turnId: "B", stepCount: 0 });
    h.store.addPendingPrompt("取消前提交原文", { inputId: "cancel", delivery: "steer" }, position);
    expect(h.text()).toContain("取消前提交原文");
    expect(h.text()).toContain("已取消");
    expect(h.store.getSnapshot().pendingInputs).toEqual([]);
  });

  it.each(["completed", "failed", "interrupted"])("%s 历史 Todo 位于终态摘要前且下一轮清空不覆盖它", function freezesTodo(status) {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    h.emit({ type: "todo_updated", turnId: "A", todoChainId: "chain", todos: [{ content: "原轮任务", activeForm: "处理原轮任务", status: "completed" }], counts: { completed: 1, pending: 0, inProgress: 0 } });
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "原轮回答" });
    h.finish("A", status);
    h.emit({ type: "turn_started", turnId: "B", stepCount: 0 });
    const before = h.text();
    expectOrder(before, ["原轮回答", "Todo 1/1", "tools", "Cogitated for"]);
    h.emit({ type: "todo_updated", turnId: "B", todoChainId: "chain", todos: [], counts: { completed: 0, pending: 0, inProgress: 0 } });
    expect(h.text(true).split("Todo 1/1")).toHaveLength(2);
    const history = h.store.getSnapshot().transcript.find(function turn(item) { return item.kind === "turn"; });
    if (history?.kind !== "turn") throw new Error("history missing");
    const ink = render(createElement(Box, { flexDirection: "column" }, ...renderTimeline(history.events, false, history, 100, true)));
    expectOrder(ink.lastFrame() ?? "", ["原轮回答", "Todo 1/1", "tools", "Cogitated for"]);
    expect(ink.lastFrame()).not.toContain("Ctrl+O");
    ink.unmount();
  });

  it("完整 App 显示所属轮引导原文且输入上方活动行独占累计时间", function fullApp() {
    const h = createHarness();
    h.emit({ type: "turn_started", turnId: "A", stepCount: 0 });
    h.emit({ type: "answer_delta", turnId: "A", stepId: "s", delta: "工具前正文" });
    const position = h.store.captureInputPosition();
    h.store.addPendingPrompt("App 独特引导", { inputId: "app", delivery: "steer" }, position);
    const projection = h.projector.getProjection();
    const result: CliControllerResult = { kind: "ok", exitCode: 0, lines: [], projection };
    const controller: CliController = { async dispatch() { return result; }, async consume() { return result; }, async resume() { return result; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const ink = render(createElement(CliTuiApp, { store: h.store, controller, closeWhenIdle: false, useColor: false, screenReader: true, onResult: function ignore() {}, onRequestInterrupt: function ignore() {}, onRequestCancel: function ignore() {}, onEof: function ignore() {}, onAppExit: function ignore() {} }));
    const frame = ink.lastFrame() ?? "";
    expectOrder(frame, ["工具前正文", "App 独特引导"]);
    expect(frame.split("App 独特引导")).toHaveLength(2);
    expect(frame).not.toContain("Thinking for");
    ink.unmount();
  });

  it("读屏禁动画仍共用活动时钟刷新累计秒数，终态停止订阅", async function accessibleClock() {
    let now = 1000;
    const clock = createTuiAnimationClock({ now: function read() { return now; }, schedule: function fake() { return 1; }, cancel: function ignore() {} });
    const props = { activity: createInitialCliActivityState(1000), status: "running" as const, waitingForApproval: false, useColor: false, screenReader: true, reducedMotion: true, animationActive: false, clock, startedAt: 1000 };
    const ink = render(createElement(TuiActivityLine, props));
    await new Promise(function frame(resolve) { setTimeout(resolve, 10); });
    now = 4000;
    clock.tick();
    await new Promise(function frame(resolve) { setTimeout(resolve, 10); });
    expect(ink.lastFrame()).toContain("3s");
    ink.rerender(createElement(TuiActivityLine, { ...props, status: "completed" }));
    expect(ink.lastFrame()).toBe("");
    ink.unmount();
    clock.dispose();
  });
});
