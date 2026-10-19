/** Stage 4 Web 分段诊断合同：验证 SSE enqueue、浏览器解析和 Presentation 帧提交只记录安全指标。 */

import type * as Core from "@autopilot-agent/core";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createSessionTaskController } from "@/app/chat/session-task-controller";
import { createWebPresentationFrameBatcher } from "@/app/chat/web-presentation-frame-batcher";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { clearWebPerformanceDiagnostics, readWebPerformanceDiagnostics } from "@/lib/runtime-host/web-performance-diagnostics";

interface DiagnosticSwitch {
  __AUTOPILOT_PERF_DIAGNOSTICS__?: boolean;
}

const diagnosticSwitch = globalThis as typeof globalThis & DiagnosticSwitch;

/** 创建固定 100 个 delta 的最小 Runtime，避免测试访问 Provider 或真实 Session。 */
function createFixtureRuntime(): Core.AgentRuntime {
  return {
    turns: {
      async *start() {
        for (let seq = 1; seq <= 100; seq += 1) {
          yield { type: "answer_delta", turnId: "turn-stage4-diagnostics", stepId: "step-1", delta: "x", seq };
        }
      },
    },
  } as unknown as Core.AgentRuntime;
}

/** 创建可读取的单帧 SSE Response。 */
function createSseResponse(payload: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream);
}

describe("Talk-Plan0922 Stage 4 Web 分段诊断", function webPerformanceDiagnosticsSuite() {
  beforeEach(function enableDiagnostics() {
    diagnosticSwitch.__AUTOPILOT_PERF_DIAGNOSTICS__ = true;
    clearWebPerformanceDiagnostics();
  });

  afterEach(function disableDiagnostics() {
    clearWebPerformanceDiagnostics();
    diagnosticSwitch.__AUTOPILOT_PERF_DIAGNOSTICS__ = false;
  });

  it("固定 Runtime 事件经过 SSE enqueue 后能在浏览器解析段留下安全记录", async function recordsServerAndBrowserSegments() {
    const stream = createRuntimeAgentStream({
      sessionId: "session-stage4-diagnostics",
      turnId: "turn-stage4-diagnostics",
      runtime: createFixtureRuntime(),
      mode: "start",
      requestSignal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    const encodedSse = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

    const events: Array<Record<string, unknown>> = [];
    const controller = createSessionTaskController("session-stage4-diagnostics", function collectEvent(_messageId, event) { events.push(event); });
    await controller.consume(createSseResponse(encodedSse), "message-stage4");

    const diagnostics = readWebPerformanceDiagnostics();
    expect(events).toHaveLength(100);
    expect(diagnostics.filter((record) => record.point === "sse_enqueue")).toHaveLength(100);
    expect(diagnostics.filter((record) => record.point === "browser_sse_parse")).toHaveLength(100);
    expect(diagnostics.filter((record) => record.point === "sse_enqueue").every((record) => record.eventType === "answer_delta")).toBe(true);
    expect(diagnostics.filter((record) => record.point === "browser_sse_parse").every((record) => record.eventType === "answer_delta")).toBe(true);
    expect(diagnostics.every((record) => record.point && record.eventType && !("content" in record))).toBe(true);
    expect(diagnostics.every((record) => record.durationMs === undefined || record.durationMs >= 0)).toBe(true);
  });

  it("固定 200 delta/s 帧基准为每次 Presentation dispatch 记录时刻与耗时", function recordsFrameSegments() {
    let nextHandle = 0;
    let pending: (() => void) | undefined;
    const commits: number[][] = [];
    const batcher = createWebPresentationFrameBatcher({
      onFlush(events) { commits.push(events.map((event) => event.seq as number)); },
      schedule(callback) { pending = callback; return ++nextHandle; },
      cancelSchedule() { pending = undefined; },
    });
    let elapsedMs = 0;
    let nextFrameAt = 16;
    for (let seq = 1; seq <= 100; seq += 1) {
      batcher.enqueue({ type: "answer_delta", turnId: "turn-stage4-diagnostics", seq, delta: "x" });
      elapsedMs += 5;
      if (elapsedMs >= nextFrameAt) {
        pending?.();
        pending = undefined;
        nextFrameAt += 16;
      }
    }
    batcher.enqueue({ type: "answer_delta", turnId: "turn-stage4-diagnostics-next", seq: 101, delta: "x" });
    batcher.flush();

    const dispatches = readWebPerformanceDiagnostics().filter((record) => record.point === "presentation_dispatch");
    expect(commits.length).toBe(32);
    expect(dispatches).toHaveLength(commits.length);
    expect(dispatches.every((record) => record.eventType === "frame" && typeof record.durationMs === "number")).toBe(true);
    expect(commits.flat()).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  });
});
