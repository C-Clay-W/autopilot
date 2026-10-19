/** Session controller 测试：锁定交错 SSE 永远回调到创建时绑定的 Session。 */
import { describe, expect, it } from "vitest";
import { createSessionTaskController, hasDurableTerminalTurn } from "@/app/chat/session-task-controller";

/** 创建可由测试逐段推送内容的 ReadableStream Response。 */
function createDeferredResponse(): { response: Response; push(chunk: string): void; close(): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) { controller = streamController; },
  });
  return {
    response: new Response(stream),
    push(chunk) { controller?.enqueue(new TextEncoder().encode(chunk)); },
    close() { controller?.close(); },
  };
}

describe("SessionTaskController", function sessionTaskControllerSuite() {
  it("交错消费 A/B SSE 时只写入各自目标 handler", async function isolatesInterleavedStreams() {
    const aEvents: Array<Record<string, unknown>> = [];
    const bEvents: Array<Record<string, unknown>> = [];
    const a = createSessionTaskController("a", function onAEvent(_messageId, event) { aEvents.push(event); });
    const b = createSessionTaskController("b", function onBEvent(_messageId, event) { bEvents.push(event); });
    const streamA = createDeferredResponse();
    const streamB = createDeferredResponse();
    const consumingA = a.consume(streamA.response, "message-a");
    const consumingB = b.consume(streamB.response, "message-b");

    streamA.push('data: {"type":"answer_delta","text":"A"}\n\n');
    streamB.push('data: {"type":"answer_delta","text":"B"}\n\n');
    streamA.close();
    streamB.close();
    await Promise.all([consumingA, consumingB]);

    expect(aEvents).toEqual([{ type: "answer_delta", text: "A" }]);
    expect(bEvents).toEqual([{ type: "answer_delta", text: "B" }]);
  });

  it("收到 [DONE] 后不等待底层连接迟迟 close", async function stopsAtSseDoneMarker() {
    const events: Array<Record<string, unknown>> = [];
    const controller = createSessionTaskController("session-a", function collectEvent(_messageId, event) { events.push(event); });
    const stream = createDeferredResponse();
    const consuming = controller.consume(stream.response, "message-a");
    stream.push('data: {"type":"turn_completed"}\n\n');
    stream.push("data: [DONE]\n\n");

    const result = await Promise.race([
      consuming.then(function resolveConsumed() { return "done" as const; }),
      new Promise<"timeout">(function waitForTimeout(resolve) { setTimeout(function resolveTimeout() { resolve("timeout"); }, 100); }),
    ]);
    expect(result).toBe("done");
    expect(events).toEqual([{ type: "turn_completed" }]);
  });

  it("收到明确 Turn 终态后不再依赖尾部 [DONE]", async function stopsAtTerminalEvent() {
    const events: Array<Record<string, unknown>> = [];
    const controller = createSessionTaskController("session-a", function collectEvent(_messageId, event) { events.push(event); });
    const stream = createDeferredResponse();
    const consuming = controller.consume(stream.response, "message-a");
    stream.push('data: {"type":"turn_completed","turnId":"turn-a"}\n\n');

    const result = await Promise.race([
      consuming.then(function resolveConsumed() { return "done" as const; }),
      new Promise<"timeout">(function waitForTimeout(resolve) { setTimeout(function resolveTimeout() { resolve("timeout"); }, 100); }),
    ]);

    expect(result).toBe("done");
    expect(events).toEqual([{ type: "turn_completed", turnId: "turn-a" }]);
  });

  it("SSE 尾流无终态且不关闭时用同 Turn 的持久终态收口", async function reconcilesHangingStream() {
    const checkedTurnIds: string[] = [];
    const appliedTurnIds: string[] = [];
    let cancelled = false;
    const controller = createSessionTaskController("session-a", function ignoreEvent() {});
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"type":"turn_started","turnId":"turn-a"}\n\n'));
      },
      cancel() { cancelled = true; },
    });

    const consuming = controller.consume(new Response(stream), "message-a", {
      idleTimeoutMs: 5,
      async getTerminalSnapshot(turnId) {
        checkedTurnIds.push(turnId);
        return { presentation: { turnSummary: { turnId, state: "completed" } } };
      },
      async applyTerminalSnapshot(turnId) {
        appliedTurnIds.push(turnId);
        return true;
      },
    });
    const result = await Promise.race([
      consuming.then(function resolveConsumed() { return "done" as const; }),
      new Promise<"timeout">(function waitForTimeout(resolve) { setTimeout(function resolveTimeout() { resolve("timeout"); }, 100); }),
    ]);

    expect(result).toBe("done");
    expect(checkedTurnIds).toEqual(["turn-a"]);
    expect(appliedTurnIds).toEqual(["turn-a"]);
    expect(cancelled).toBe(true);
  });

  /** 尾部大事件被拆成持续字节流时，按完整事件空闲时间触发 History 校准。 */
  it("持续收到不完整 SSE 字节时仍会校准持久终态", async function reconcilesIncompleteTrailingEvent() {
    const checkedTurnIds: string[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let fragmentTimer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('data: {"type":"turn_started","turnId":"turn-a"}\n\n'));
        fragmentTimer = setInterval(function pushIncompleteTerminalFragment() {
          controller.enqueue(new TextEncoder().encode(" "));
        }, 2);
      },
      cancel() {
        if (fragmentTimer) clearInterval(fragmentTimer);
      },
    });
    const controller = createSessionTaskController("session-a", function ignoreEvent() {});
    const consuming = controller.consume(new Response(stream), "message-a", {
      idleTimeoutMs: 20,
      async getTerminalSnapshot(turnId) {
        checkedTurnIds.push(turnId);
        return { presentation: { turnSummary: { turnId, state: "completed" } } };
      },
    });
    const result = await Promise.race([
      consuming.then(function resolveConsumed() { return "done" as const; }),
      new Promise<"timeout">(function waitForTimeout(resolve) { setTimeout(function resolveTimeout() { resolve("timeout"); }, 60); }),
    ]);
    if (result === "timeout") {
      if (fragmentTimer) clearInterval(fragmentTimer);
      streamController?.close();
      await consuming;
    }

    expect(result).toBe("done");
    expect(checkedTurnIds).toEqual(["turn-a"]);
  });

  it("reader.cancel 永不完成时仍在 [DONE] 后立即收口", async function ignoresHangingReaderCancel() {
    const events: Array<Record<string, unknown>> = [];
    const controller = createSessionTaskController("session-a", function collectEvent(_messageId, event) { events.push(event); });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"type":"turn_completed"}\n\ndata: [DONE]\n\n'));
      },
      cancel() {
        return new Promise<void>(function neverResolve() {});
      },
    });
    const consuming = controller.consume(new Response(stream), "message-a");
    const result = await Promise.race([
      consuming.then(function resolveConsumed() { return "done" as const; }),
      new Promise<"timeout">(function waitForTimeout(resolve) { setTimeout(function resolveTimeout() { resolve("timeout"); }, 100); }),
    ]);

    expect(result).toBe("done");
    expect(events).toEqual([{ type: "turn_completed" }]);
  });

  it("History 请求代次与其他 Session 无关", function keepsHistoryVersionsPerController() {
    const a = createSessionTaskController("a", function ignoreAEvent() {});
    const b = createSessionTaskController("b", function ignoreBEvent() {});
    const firstA = a.beginHistoryRequest();
    const secondA = a.beginHistoryRequest();
    const firstB = b.beginHistoryRequest();

    expect(a.isLatestHistoryRequest(firstA)).toBe(false);
    expect(a.isLatestHistoryRequest(secondA)).toBe(true);
    expect(b.isLatestHistoryRequest(firstB)).toBe(true);
  });

  it("仅接受当前 Turn 的真实终态 Summary", function matchesDurableTerminalSummary() {
    expect(hasDurableTerminalTurn({ meta: { runtimeStatus: "running" }, presentation: { turnSummary: { turnId: "turn-a", state: "interrupted" } } }, "turn-a")).toBe(false);
    expect(hasDurableTerminalTurn({ presentation: { turnSummary: { turnId: "turn-a", state: "completed" } } }, "turn-a")).toBe(true);
    expect(hasDurableTerminalTurn({ presentation: { turnSummary: { turnId: "turn-old", state: "completed" } } }, "turn-a")).toBe(false);
    expect(hasDurableTerminalTurn({ presentation: { turnSummary: { turnId: "turn-a", state: "awaiting_approval" } } }, "turn-a")).toBe(false);
  });
});
