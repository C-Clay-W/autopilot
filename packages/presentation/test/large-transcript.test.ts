/** Stage 6 大转录回归：冻结共享 reducer 的规模、回放时间与采样 RSS 峰值门槛。 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createPresentationState, reducePresentationInput, selectTimeline, selectToolCalls } from "../src/index.js";
import { createLargeTranscriptFixture } from "./large-transcript.fixture.js";

const MAX_REPLAY_MS = 3_000;
const MAX_SAMPLED_RSS_MIB = 512;

/** 将字节数转换为二进制 MiB，供稳定的门禁输出与断言复用。 */
function toMib(bytes: number): number {
  return bytes / 1024 / 1024;
}

describe("Presentation large transcript", function largeTranscriptSuite() {
  it("在冻结规模下保持 callId、grouping 与回放资源门槛", function replaysLargeTranscript() {
    const fixture = createLargeTranscriptFixture();
    let state = createPresentationState();
    let peakRssBytes = process.memoryUsage().rss;
    const startedAt = performance.now();

    for (const input of fixture) {
      state = reducePresentationInput(state, input);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }

    const replayMs = performance.now() - startedAt;
    const timeline = selectTimeline(state);
    const toolCount = selectToolCalls(state, "turn-large-transcript").length;
    const groupCount = timeline.filter(function isToolGroup(item) { return item.kind === "tool_group"; }).length;
    const answerCount = state.items.filter(function isAnswer(item) { return item.kind === "assistant_answer"; }).length;
    const thinkingCount = state.items.filter(function isThinking(item) { return item.kind === "thinking"; }).length;
    const jobCount = state.items.filter(function isJob(item) { return item.kind === "job"; }).length;
    const peakRssMib = toMib(peakRssBytes);

    console.info(`large-transcript: inputs=${fixture.length} replay_ms=${replayMs.toFixed(1)} sampled_peak_rss_mib=${peakRssMib.toFixed(1)}`);
    expect(answerCount).toBe(500);
    expect(toolCount).toBe(1_000);
    expect(groupCount).toBe(100);
    expect(thinkingCount).toBe(200);
    expect(jobCount).toBe(50);
    expect(replayMs).toBeLessThanOrEqual(MAX_REPLAY_MS);
    expect(peakRssMib).toBeLessThanOrEqual(MAX_SAMPLED_RSS_MIB);
  });
});
