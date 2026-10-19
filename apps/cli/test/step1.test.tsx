/**
 * Talk-Plan0805 Step1 测试：增量 live timeline、输入框外壳与活动状态时钟。
 *
 * 测试只使用安全 CliPublicEvent 和 TUI Store，不启动真实 Runtime、Provider 或 Web。
 */

import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTuiAnimationClock } from "../src/animation-clock.js";
import {
  CLI_ACTIVITY_STALLED_AFTER_MS,
  CLI_ACTIVITY_TRANSITION_MS,
  createInitialCliActivityState,
  getCliActivityFrame,
  reduceCliActivityState,
  resolveCliActivityView,
  settleCliActivityState,
} from "../src/activity-animation.js";
import { createInitialCliProjection } from "../src/event-projector.js";
import type { CliController, CliControllerResult } from "../src/controller.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import type { CliAction, CliProjection, CliPublicEvent } from "../src/types.js";

/** 创建只返回安全空投影的 TUI Controller double。 */
function createIdleController(): CliController {
  const projection = createInitialCliProjection();
  let listener: ((event: CliPublicEvent, nextProjection: CliProjection) => void) | undefined;

  /** 生成不触碰 Runtime 的最小 Controller 结果。 */
  function result(kind: CliControllerResult["kind"] = "ok"): CliControllerResult {
    return { kind, exitCode: 0, lines: [], projection };
  }

  return {
    async dispatch(_action: CliAction): Promise<CliControllerResult> {
      return result();
    },
    async consume(_events: AsyncIterable<never>): Promise<CliControllerResult> {
      return result();
    },
    async resume(): Promise<CliControllerResult> {
      return result();
    },
    getProjection(): CliProjection {
      return projection;
    },
    setSession(_sessionId: string): void {},
    setEventListener(nextListener): void {
      listener = nextListener;
    },
  };
}

/** 创建只进入 running 状态的 Controller double，供 Esc 回填输入回归使用。 */
function createRunningController(calls: CliAction[]): CliController {
  const projection = createInitialCliProjection();
  let listener: ((event: CliPublicEvent, nextProjection: CliProjection) => void) | undefined;

  /** 返回当前安全投影，不触碰 Runtime。 */
  function result(): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection };
  }

  return {
    async dispatch(action: CliAction): Promise<CliControllerResult> {
      calls.push(action);
      if (action.type === "submit_prompt") {
        projection.turnId = "turn-escape-restore";
        projection.status = "running";
        listener?.({ type: "turn_started", seq: 1, turnId: "turn-escape-restore", stepCount: 0 }, projection);
      }
      return result();
    },
    async consume(_events: AsyncIterable<never>): Promise<CliControllerResult> {
      return result();
    },
    async resume(): Promise<CliControllerResult> {
      return result();
    },
    getProjection(): CliProjection {
      return projection;
    },
    setSession(_sessionId: string): void {},
    setEventListener(nextListener): void {
      listener = nextListener;
    },
  };
}

/** 渲染 Step1 TUI，关闭真实动画以便快照只验证稳定文本。 */
function renderStep1Tui(store = createCliTuiStore(), controller: CliController = createIdleController()): { lastFrame: () => string | undefined; unmount: () => void; stdin: { write(value: string): void }; store: ReturnType<typeof createCliTuiStore> } {
  controller.setEventListener(function receiveEvent(event, projection): void {
    store.acceptEvent(event, projection);
  });
  const result = render(
    createElement(CliTuiApp, {
      store,
      controller,
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      reducedMotion: true,
      onResult: function syncResult(controllerResult): void { store.syncProjection(controllerResult.projection); },
      onRequestInterrupt: function ignoreInterrupt(): void {},
      onRequestCancel: function ignoreCancel(): void {},
      onEof: function ignoreEof(): void {},
      onAppExit: function ignoreExit(): void {},
    }),
  );
  return { lastFrame: result.lastFrame, unmount: result.unmount, stdin: result.stdin, store };
}

describe("Talk-Plan0805 Step1", function step1Suite() {
  it("shared animation clock can pause, resume and dispose its only timer", function controlsSharedClock() {
    let now = 0;
    let scheduled: (() => void) | undefined;
    let cancelled = 0;
    const clock = createTuiAnimationClock({
      now: function readFakeTime(): number { return now; },
      schedule: function captureSchedule(listener): object {
        scheduled = listener;
        return {};
      },
      cancel: function captureCancel(): void {
        cancelled += 1;
      },
    });
    const observed: number[] = [];
    const unsubscribe = clock.subscribe(function observeTime(time: number): void { observed.push(time); });

    now = 50;
    clock.tick();
    expect(observed).toEqual([50]);
    clock.setActive(false);
    now = 100;
    clock.tick();
    expect(observed).toEqual([50]);
    clock.setActive(true);
    expect(scheduled).toBeDefined();
    clock.tick();
    expect(observed).toEqual([50, 100]);
    unsubscribe();
    expect(cancelled).toBeGreaterThan(0);
    clock.dispose();
  });

  it("采用 CC 风格单 glyph，并按正向再反向顺序推进", function rendersPingPongFrames() {
    const frames = [0, 120, 240, 360, 480, 600, 720, 840, 960, 1_080, 1_200, 1_320].map(function readFrame(time): string { return getCliActivityFrame("requesting", time); });
    expect(frames).toEqual(["·", "✢", "*", "✶", "✻", "✽", "✽", "✻", "✶", "*", "✢", "·"]);
    expect(new Set(frames.map(function getWidth(frame): number { return frame.length; }))).toEqual(new Set([1]));
  });

  it("Still working 使用同一组 spinner，不再显示生硬感叹号", function animatesStalledFrame() {
    const frames = [0, 120, 240, 360].map(function readFrame(time): string { return getCliActivityFrame("stalled", time); });
    expect(frames).toEqual(["·", "✢", "*", "✶"]);
    expect(frames).not.toContain("!");
  });

  it("活动状态覆盖 requesting、tool 过场、stalled、审批等待和终态", function resolvesActivityStates() {
    let activity = createInitialCliActivityState(0);
    activity = reduceCliActivityState(activity, { type: "turn_started" }, 10);
    expect(resolveCliActivityView({ activity, status: "running", now: 10 })?.phase).toBe("requesting");

    activity = reduceCliActivityState(activity, { type: "tool_started" }, 100);
    expect(resolveCliActivityView({ activity, status: "running", now: 100 })?.phase).toBe("transition");
    expect(resolveCliActivityView({ activity, status: "running", now: 100 + CLI_ACTIVITY_TRANSITION_MS })?.phase).toBe("waiting");

    activity = reduceCliActivityState(activity, { type: "tool_result" }, 3_000);
    expect(resolveCliActivityView({ activity, status: "running", now: 3_000 + CLI_ACTIVITY_TRANSITION_MS })?.phase).toBe("thinking");
    const stalled = resolveCliActivityView({ activity, status: "running", now: 3_000 + CLI_ACTIVITY_STALLED_AFTER_MS });
    expect(stalled?.phase).toBe("stalled");
    expect(stalled?.label).toContain("no new event for 20s");

    activity = reduceCliActivityState(activity, { type: "approval_required" }, 7_000);
    expect(resolveCliActivityView({ activity, status: "waiting_approval", now: 70_000, waitingForApproval: true })).toMatchObject({ phase: "waiting", label: "Waiting for approval" });
    activity = settleCliActivityState(activity, "completed", 71_000);
    expect(resolveCliActivityView({ activity, status: "completed", now: 71_000 })).toMatchObject({ phase: "terminal" });
  });

  it("输入框具备直角边框，screen reader 仍获得稳定 loading 文案", async function exposesPromptAndActivity() {
    const rendered = renderStep1Tui();
    const initialFrame = rendered.lastFrame() ?? "";
    expect(initialFrame).toContain("┌");
    expect(initialFrame).toContain("└");
    expect(initialFrame).toContain("›");
    expect(initialFrame).toContain("Ready");

    const projection = createInitialCliProjection();
    projection.turnId = "turn-step1";
    projection.status = "running";
    rendered.store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-step1", stepCount: 0 }, projection);
    await new Promise<void>(function waitForActivityFrame(resolve) { setTimeout(resolve, 20); });
    const runningFrame = rendered.lastFrame() ?? "";
    expect(runningFrame).toContain("Preparing");
    expect(runningFrame).not.toContain("activity:");
    expect(runningFrame).not.toContain("[>");
    expect(runningFrame).not.toContain("\u001b[");
    rendered.unmount();
  });

  it("活动 Turn 按 Esc 后把最后发送的 prompt 回填到输入框", async function restoresLastPromptOnEscape() {
    const calls: CliAction[] = [];
    const controller = createRunningController(calls);
    const rendered = renderStep1Tui(createCliTuiStore(), controller);
    rendered.stdin.write("取消后继续");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForRunningPrompt(resolve) { setTimeout(resolve, 30); });

    expect(calls).toEqual([{ type: "submit_prompt", content: "取消后继续" }]);
    rendered.store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-escape-restore", delta: "已经产生的回答" }, controller.getProjection());
    expect(rendered.store.getSnapshot().liveEvents.some(function hasAnswer(event) { return event.type === "answer_delta" && event.delta === "已经产生的回答"; })).toBe(true);
    rendered.stdin.write("\u001b");
    await new Promise<void>(function waitForRestoredPrompt(resolve) { setTimeout(resolve, 30); });

    expect(rendered.lastFrame() ?? "").toContain("› 取消后继续▏");
    rendered.unmount();
  });

  it("20,000+ live event/diff/answer delta 合成时间线保持可渲染且不丢尾部回答", async function rendersLongLiveTimeline() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-long-step1";
    projection.status = "running";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-long-step1", stepCount: 70 }, projection);
    for (let index = 0; index < 20_100; index += 1) {
      const seq = index + 2;
      const event: CliPublicEvent = index % 7 === 0
        ? { type: "tool_result", seq, turnId: "turn-long-step1", toolName: "edit_file", status: "success", summary: "updated", diff: "@@\n-old\n+new" }
        : { type: "answer_delta", seq, turnId: "turn-long-step1", delta: `token-${index} ` };
      store.acceptEvent(event, projection);
    }
    const rendered = renderStep1Tui(store);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("token-20099");
    rendered.stdin.write("x");
    await new Promise<void>(function waitForInputFrame(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("› x");
    rendered.unmount();
  }, 30_000);

  it("终态切换到 Static 时保留最后一段 assistant 回复", async function keepsFinalAnswerWhenTurnSettles() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-final-answer";
    projection.status = "running";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-final-answer", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-final-answer", delta: "Clay 的最终回复" }, projection);
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-final-answer", status: "completed" }, { ...projection, status: "completed" });

    const rendered = renderStep1Tui(store);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Clay 的最终回复");
    expect(store.getSnapshot().liveEvents.some(function hasAnswer(event) { return event.type === "answer_delta"; })).toBe(true);
    rendered.unmount();
  });
});
