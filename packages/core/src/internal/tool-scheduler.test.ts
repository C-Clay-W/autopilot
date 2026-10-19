/**
 * internal/tool-scheduler.test.ts — 工具调度取消时的配对闭合契约。
 *
 * 验证资源串行队列收到取消后不再 dispatch 后续调用，而是以确定性 error result
 * 交给 Kernel 写入对应 canonical tool-result。
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolScheduler } from "./tool-scheduler";
import { ToolRegistry } from "./tools/tool-registry";

/** 创建两个共享同一资源的最小只读工具定义，按用例选择并发与安全重试。 */
function createSerialRegistry(concurrency = 1, retrySafe = false): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ["first", "second"]) {
    registry.register({
      name,
      description: "fixture",
      inputSchema: z.object({}),
      metadata: { effect: "none", destructive: false, concurrency: { max: concurrency, resourceKey: "fixture" }, retry: retrySafe ? { safe: true, maxRetries: 1 } : { safe: false } },
      createActionFacts: function createFacts() { return { toolName: name, effect: "none", destructive: false, operation: "fixture" }; },
      execute: async function executeFixture() { return {}; },
      serializeOutput: function serializeFixture(output) { return output; },
    });
  }
  return registry;
}

describe("ToolScheduler cancellation", function schedulerCancellationSuite() {
  it("取消后为尚未 dispatch 的调用生成 TOOL_ABORTED_BEFORE_DISPATCH", async function closesUndispatchedCall() {
    const controller = new AbortController();
    let markFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(function waitForFirst(resolve) { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>(function waitForRelease(resolve) { releaseFirst = resolve; });
    const notified: string[] = [];
    const scheduler = createToolScheduler(createSerialRegistry(), async function executeFixture(request) {
      if (request.callId === "first") {
        markFirstStarted?.();
        await firstReleased;
        return { status: "success", callId: request.callId, toolName: request.toolName, output: {}, meta: { durationMs: 0, inputHash: "fixture" } };
      }
      throw new Error("取消后不应 dispatch second");
    });

    const resultsPromise = scheduler.executeCalls([
      { id: "first", name: "first", input: {} },
      { id: "second", name: "second", input: {} },
    ], { signal: controller.signal, onResult: function completed(item) { notified.push(item.call.id); } });
    await firstStarted;
    controller.abort();
    releaseFirst?.();

    const results = await resultsPromise;
    expect(results[0]?.result.status).toBe("success");
    expect(results[1]).toMatchObject({
      call: { id: "second" },
      result: { status: "error", error: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } },
    });
    expect(notified).toEqual(["first", "second"]);
  });

  it("乱序完成通知立即交付，executeCalls 数组仍按调用原顺序", async function keepsOrderedArrayWithLiveResults() {
    let releaseFirst!: () => void;
    let notifySecond!: () => void;
    const firstGate = new Promise<void>(function gate(resolve) { releaseFirst = resolve; });
    const secondDone = new Promise<void>(function done(resolve) { notifySecond = resolve; });
    const notified: string[] = [];
    const scheduler = createToolScheduler(createSerialRegistry(2), async function execute(request) {
      if (request.callId === "first") await firstGate;
      return { status: "success", callId: request.callId, toolName: request.toolName, output: {}, meta: { durationMs: 0, inputHash: "fixture" } };
    });
    const executing = scheduler.executeCalls([{ id: "first", name: "first", input: {} }, { id: "second", name: "second", input: {} }], {
      onResult: function completed(item) { notified.push(item.call.id); if (item.call.id === "second") notifySecond(); },
    });
    try {
      await secondDone;
      expect(notified).toEqual(["second"]);
    } finally {
      releaseFirst();
    }
    expect((await executing).map(function id(item) { return item.call.id; })).toEqual(["first", "second"]);
    expect(notified).toEqual(["second", "first"]);
  });

  it("安全重试只通知最终结果一次并继续转发工具进度", async function notifiesAfterFinalRetry() {
    let attempts = 0;
    const notifications: number[] = [];
    const progress: string[] = [];
    const scheduler = createToolScheduler(createSerialRegistry(1, true), async function execute(request, options) {
      attempts++;
      options?.onProgress?.(request.callId, `attempt:${attempts}`);
      if (attempts === 1) return { status: "error", callId: request.callId, toolName: request.toolName, error: { code: "TOOL_EXECUTION_FAILED", message: "retryable" } };
      return { status: "success", callId: request.callId, toolName: request.toolName, output: {}, meta: { durationMs: 0, inputHash: "fixture" } };
    });
    const results = await scheduler.executeCalls([{ id: "first", name: "first", input: {} }], {
      maxRetries: 1,
      onResult: function completed(item) { notifications.push(item.retryCount); },
      onProgress: function chunk(_id, tail) { progress.push(tail); },
    });
    expect(attempts).toBe(2);
    expect(notifications).toEqual([1]);
    expect(progress).toEqual(["attempt:1", "attempt:2"]);
    expect(results[0].result.status).toBe("success");
  });
});
