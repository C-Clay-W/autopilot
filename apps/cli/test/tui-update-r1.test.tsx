/** Talk-Plan0813 TUI R1：inline Static 固化、终态一次性移交与动态区边界。 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInitialCliProjection } from "../src/event-projector.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import type { CliController, CliControllerResult } from "../src/controller.js";
import type { CliProjection, CliPublicEvent } from "../src/types.js";

/** 创建只用于渲染边界测试的 Controller double，不连接 Runtime 或持久化 Store。 */
function createInlineController(projection: CliProjection): CliController {
  let listener: ((event: CliPublicEvent, nextProjection: CliProjection) => void) | undefined;
  function result(): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection };
  }
  return {
    async dispatch(): Promise<CliControllerResult> { return result(); },
    async consume(): Promise<CliControllerResult> { return result(); },
    async resume(): Promise<CliControllerResult> { return result(); },
    getProjection(): CliProjection { return projection; },
    setSession(): void {},
    setEventListener(nextListener): void { listener = nextListener; },
  };
}

/** 统计当前帧中的完整文本出现次数，避免把同一历史项误判为重复渲染。 */
function countText(frame: string, text: string): number {
  return frame.split(text).length - 1;
}

/** 渲染 inline TUI，并让事件直接进入同一个本地 Store。 */
function renderInlineTui(store: ReturnType<typeof createCliTuiStore>, projection: CliProjection): ReturnType<typeof render> {
  const controller = createInlineController(projection);
  controller.setEventListener(function acceptEvent(event, nextProjection): void {
    store.acceptEvent(event, nextProjection);
  });
  return render(
    <CliTuiApp
      store={store}
      controller={controller}
      closeWhenIdle={false}
      useColor={false}
      screenReader={true}
      onResult={function syncProjection(result): void { store.syncProjection(result.projection); }}
      onRequestInterrupt={function ignoreInterrupt(): void {}}
      onRequestCancel={function ignoreCancel(): void {}}
      onEof={function ignoreEof(): void {}}
      onAppExit={function ignoreAppExit(): void {}}
    />,
  );
}

/** 等待 Ink 将本轮 Store 变更提交到测试帧。 */
async function waitForTuiFrame(): Promise<void> {
  await new Promise<void>(function resolveNextFrame(resolve): void { setTimeout(resolve, 40); });
}

describe("Talk-Plan0813 TUI R1 inline Static", function tuiUpdateR1Suite() {
  it("完成 Turn 将 prompt 与最终答案一次性移交 Static，后续临时 info 不重复历史", async function transfersTerminalTurnOnce() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-r1-once";
    projection.status = "running";
    store.recordPrompt("prompt-r1-once");
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-r1-once", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-r1-once", delta: "answer-r1-once" }, projection);
    const rendered = renderInlineTui(store, projection);
    await waitForTuiFrame();

    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-r1-once", status: "completed" }, projection);
    await waitForTuiFrame();
    store.addNotice("temporary-r1-info");
    await waitForTuiFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("prompt-r1-once");
    expect(frame).toContain("answer-r1-once");
    expect(frame).toContain("temporary-r1-info");
    expect(countText(frame, "prompt-r1-once")).toBe(1);
    expect(countText(frame, "answer-r1-once")).toBe(1);
    rendered.unmount();
  });

  it("当前流式 Turn 保持动态，终态帧才进入 Static，不把活动答案提前固化", async function keepsLiveTurnDynamic() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-r1-live";
    projection.status = "running";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-r1-live", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-r1-live", delta: "live-r1-part" }, projection);
    const rendered = renderInlineTui(store, projection);
    await waitForTuiFrame();

    expect(rendered.lastFrame() ?? "").toContain("live-r1-part");
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-r1-live", status: "completed" }, projection);
    await waitForTuiFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(countText(frame, "live-r1-part")).toBe(1);
    expect(store.getSnapshot().transcript.filter(function isTurn(item): boolean { return item.kind === "turn"; })).toHaveLength(1);
    rendered.unmount();
  });

  it("Core answer_reset 会撤销工具调用前的暂定回答，实时与完成历史都只保留最终回答", async function discardsProvisionalAnswerAcrossTimelineModes() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-r1-reset";
    projection.status = "running";
    store.recordPrompt("分析文件");
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-r1-reset", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-r1-reset", delta: "暂定报告，不应保留" }, projection);
    store.acceptEvent({ type: "answer_reset", seq: 3, turnId: "turn-r1-reset" }, projection);
    store.acceptEvent({ type: "tool_started", seq: 4, turnId: "turn-r1-reset", toolName: "read_file", summary: "Reading todo.html" }, projection);
    store.acceptEvent({ type: "tool_result", seq: 5, turnId: "turn-r1-reset", toolName: "read_file", status: "success", summary: "Read 10 lines" }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 6, turnId: "turn-r1-reset", delta: "最终报告，应保留" }, projection);
    const rendered = renderInlineTui(store, projection);
    await waitForTuiFrame();

    expect(rendered.lastFrame() ?? "").not.toContain("暂定报告，不应保留");
    expect(rendered.lastFrame() ?? "").toContain("最终报告，应保留");

    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 7, turnId: "turn-r1-reset", status: "completed" }, projection);
    await waitForTuiFrame();

    expect(rendered.lastFrame() ?? "").not.toContain("暂定报告，不应保留");
    expect(rendered.lastFrame() ?? "").toContain("最终报告，应保留");
    rendered.unmount();
  });
});
