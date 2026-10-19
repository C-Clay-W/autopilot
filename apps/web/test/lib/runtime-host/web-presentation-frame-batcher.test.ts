/** Web Stage 4 帧合并合同：固定 200 delta/s 输入只按帧提交，边界事件先 flush 且顺序不变。 */

import { describe, expect, it } from "vitest";
import { createWebPresentationFrameBatcher } from "@/app/chat/web-presentation-frame-batcher";
import { reduceWebPresentationEvent } from "@/lib/runtime-host/web-presentation-adapter";
import { createPresentationState, type AgentPresentationState } from "@autopilot-agent/presentation";

interface FakeFrameScheduler {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  run(): void;
}

/** 提供可控的 requestAnimationFrame 替身，测试不依赖真实浏览器时钟。 */
function createFakeFrameScheduler(): FakeFrameScheduler {
  let nextHandle = 0;
  let pending: { handle: number; callback: () => void } | undefined;
  return {
    schedule(callback) {
      const handle = ++nextHandle;
      pending = { handle, callback };
      return handle;
    },
    cancel(handle) {
      if (pending?.handle === handle) pending = undefined;
    },
    run() {
      const callback = pending?.callback;
      pending = undefined;
      callback?.();
    },
  };
}

/** 创建不含回答正文的固定 delta 事件。 */
function createDelta(seq: number, turnId = "turn-stage4"): Record<string, unknown> {
  return { type: "answer_delta", turnId, seq, delta: "x" };
}

describe("Talk-Plan0922 Stage 4 Web Presentation 帧合并", function stage4FrameBatcherSuite() {
  it("连续 delta 在边界事件前一次性 flush，并保持 seq 顺序", function flushesBeforeBoundary() {
    const scheduler = createFakeFrameScheduler();
    const commits: number[][] = [];
    let presentation: AgentPresentationState = createPresentationState();
    const batcher = createWebPresentationFrameBatcher({
      onFlush: function recordCommit(events) {
        commits.push(events.map((event) => event.seq as number));
        presentation = events.reduce((state, event) => reduceWebPresentationEvent(state, event, "session-stage4"), presentation);
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });

    expect(batcher.enqueue(createDelta(1))).toBe(true);
    expect(batcher.enqueue(createDelta(2))).toBe(true);
    expect(batcher.enqueue({ type: "tool_started", turnId: "turn-stage4", seq: 3 })).toBe(false);
    batcher.flush();

    expect(commits).toEqual([[1, 2]]);
    expect(presentation.items.find((item) => item.kind === "assistant_answer")?.content).toBe("xx");
    expect(presentation.lastSeqByTurn["turn-stage4"]).toBe(2);
    scheduler.run();
    expect(commits).toEqual([[1, 2]]);
  });

  it("固定 200 delta/s 输入最多每帧提交一次，且切换 Turn 会先提交旧帧", function recordsStage4FrameBaseline() {
    const scheduler = createFakeFrameScheduler();
    const commits: number[][] = [];
    const batcher = createWebPresentationFrameBatcher({
      onFlush: function recordCommit(events) { commits.push(events.map((event) => event.seq as number)); },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });
    const deltaCount = 100;
    const intervalMs = 5;
    let elapsedMs = 0;
    let nextFrameAt = 16;
    const startedAt = performance.now();
    for (let index = 1; index <= deltaCount; index += 1) {
      batcher.enqueue(createDelta(index));
      elapsedMs += intervalMs;
      if (elapsedMs >= nextFrameAt) {
        scheduler.run();
        nextFrameAt += 16;
      }
    }
    batcher.enqueue(createDelta(deltaCount + 1, "turn-stage4-next"));
    batcher.flush();
    const measuredMs = performance.now() - startedAt;

    process.stdout.write(`WEB_STAGE4_FRAME_BASELINE ${JSON.stringify({ deltaCount, intervalMs, frameCommits: commits.length, maxEventsPerCommit: Math.max(...commits.map((commit) => commit.length)), measuredMs: Number(measuredMs.toFixed(3)) })}\n`);
    expect(commits.length).toBeLessThanOrEqual(Math.ceil((deltaCount * intervalMs) / 16) + 1);
    expect(commits.flat()).toEqual(Array.from({ length: deltaCount + 1 }, (_, index) => index + 1));
    expect(commits.at(-1)).toEqual([deltaCount + 1]);
  });
});
