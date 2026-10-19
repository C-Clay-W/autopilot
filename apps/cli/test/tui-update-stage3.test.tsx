/** Talk-Plan0922 Stage 3 定向测试：输入隔离后的 source 与 visual-line 增量缓存合同。 */

import { describe, expect, it } from "vitest";
import { createTimelineVisualLineCache, type TimelineLineSource } from "../src/timeline-lines.js";
import { createCliTuiStore } from "../src/tui/store.js";
import { createTuiViewportSourceCache } from "../src/tui/viewport/sources.js";
import type { CliTuiSnapshot, CliTuiTimelineEvent, CliTuiTranscriptItem } from "../src/tui/types.js";

/** 创建可复用的历史与 live tail 快照；各数组引用保持稳定以模拟普通 prompt 输入。 */
function createViewportSnapshot(): CliTuiSnapshot {
  const base = createCliTuiStore().getSnapshot();
  const historyEvents: CliTuiTimelineEvent[] = [{ type: "answer_delta", seq: 1, turnId: "turn-history", stepId: "step-history", delta: "历史回答" }];
  const liveEvents: CliTuiTimelineEvent[] = [{ type: "answer_delta", seq: 1, turnId: "turn-live", stepId: "step-live", delta: "当前回答" }];
  const historyTurn: CliTuiTranscriptItem = { kind: "turn", key: "turn:history", turnId: "turn-history", events: historyEvents, status: "completed" };
  return {
    ...base,
    transcript: [{ kind: "prompt", key: "prompt:history", content: "历史请求" }, historyTurn],
    liveTurnId: "turn-live",
    liveEvents,
    liveMetrics: { startedAt: 1 },
    status: "running",
  };
}

/** 从 source 列表取指定 item 的首个对象，用于验证对象级缓存复用。 */
function findSource(sources: TimelineLineSource[], itemId: string): TimelineLineSource | undefined {
  return sources.find(function matchSource(source): boolean { return source.itemId === itemId; });
}

describe("Talk-Plan0922 Stage 3 增量缓存", function stage3CacheSuite() {
  it("普通输入不改变历史 source，只有 live tail 变化时才重建尾部", function reusesHistoryAndRebuildsLiveTail() {
    const cache = createTuiViewportSourceCache();
    const firstSnapshot = createViewportSnapshot();
    const first = cache.getSources(firstSnapshot, undefined, 0, 40);
    const firstStats = cache.getStats();
    expect(firstStats.historyBuilds).toBe(2);
    expect(firstStats.liveBuilds).toBe(1);

    const second = cache.getSources({ ...firstSnapshot }, undefined, 0, 40);
    const secondStats = cache.getStats();
    expect(secondStats.historyBuilds).toBe(2);
    expect(secondStats.historyHits).toBe(2);
    expect(secondStats.liveBuilds).toBe(1);
    expect(secondStats.liveHits).toBe(1);

    const thirdSnapshot: CliTuiSnapshot = {
      ...firstSnapshot,
      liveEvents: [...firstSnapshot.liveEvents, { type: "answer_delta", seq: 2, turnId: "turn-live", stepId: "step-live", delta: "新增尾部" }],
    };
    const third = cache.getSources(thirdSnapshot, undefined, 0, 40);
    const thirdStats = cache.getStats();
    expect(thirdStats.historyBuilds).toBe(2);
    expect(thirdStats.liveBuilds).toBe(2);
    expect(findSource(first, "turn:history:answer:0")).toBe(findSource(third, "turn:history:answer:0"));
    expect(findSource(second, "turn-live:answer:0")).not.toBe(findSource(third, "turn-live:answer:0"));

    const changedHistory: CliTuiTranscriptItem = {
      ...(firstSnapshot.transcript[1] as Extract<CliTuiTranscriptItem, { kind: "turn" }>),
      events: [{ type: "answer_delta", seq: 1, turnId: "turn-history", stepId: "step-history", delta: "历史回答已变更" }],
    };
    cache.getSources({ ...thirdSnapshot, transcript: [firstSnapshot.transcript[0]!, changedHistory] }, undefined, 0, 40);
    expect(cache.getStats().historyBuilds).toBe(3);
  });

  it("visual lines 只重算文本或样式变化的 item，终端宽度变化使缓存失效", function cachesVisualLinesBySourceIdentity() {
    const cache = createTimelineVisualLineCache();
    const history: TimelineLineSource = { itemId: "history", text: "history text" };
    const live: TimelineLineSource = { itemId: "live", text: "live text" };
    const first = cache.getLines([history, live], 20);
    expect(cache.getStats().builds).toBe(2);

    const changedLive: TimelineLineSource = { itemId: "live", text: "live text + tail" };
    const second = cache.getLines([history, changedLive], 20);
    expect(cache.getStats().builds).toBe(3);
    expect(cache.getStats().hits).toBe(1);
    expect(second.find(function findHistory(line) { return line.itemId === "history" })).toBe(first.find(function findHistory(line) { return line.itemId === "history" }));
    expect(second.find(function findLive(line) { return line.itemId === "live" })).not.toBe(first.find(function findLive(line) { return line.itemId === "live" }));

    cache.getLines([history, changedLive], 30);
    expect(cache.getStats().widthInvalidations).toBeGreaterThan(0);
    expect(cache.getStats().builds).toBe(5);
  });
});
