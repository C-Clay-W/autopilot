/** Talk-Plan0813 TUI Step 2 定向测试：备用屏视口裁剪、滚轮锚定与应用自绘滚动条。 */

import { createElement } from "react";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { createInitialCliProjection } from "../src/event-projector.js";
import { createCliTuiStore, createTuiMouseInputSink, CliTuiApp, formatTuiViewportMarkdown } from "../src/tui.js";
import type { CliAction, CliController, CliControllerResult, CliProjection } from "../src/types.js";

/** 等待 Ink 将一次状态更新写入测试帧。 */
function waitForTuiFrame(): Promise<void> {
  return new Promise(function wait(resolve) { setTimeout(resolve, 80); });
}

/** 创建只满足视口渲染所需能力的 Controller 测试替身。 */
function createViewportController(projection: CliProjection): CliController {
  /** 返回不会触发 Runtime 的稳定结果。 */
  function result(): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection };
  }
  return {
    async dispatch(_action: CliAction): Promise<CliControllerResult> { return result(); },
    async consume(): Promise<CliControllerResult> { return result(); },
    async resume(): Promise<CliControllerResult> { return result(); },
    getProjection(): CliProjection { return projection; },
    setSession(): void {},
    setEventListener(): void {},
  };
}

describe("Talk-Plan0813 TUI Step 2", function tuiUpdateStep2Suite() {
  it("Esc 请求取消后丢弃在途输出，只接收 Runtime 终态", function suppressesTailEventsAfterCancellation() {
    const projection = createInitialCliProjection();
    projection.turnId = "turn-cancel-tail";
    projection.status = "running";
    const store = createCliTuiStore();
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: projection.turnId, delta: "取消前" }, projection);
    store.setCancellationRequested(true);
    store.acceptEvent({ type: "answer_delta", seq: 3, turnId: projection.turnId, delta: "取消后尾部" }, projection);
    store.acceptEvent({ type: "status", seq: 4, turnId: projection.turnId, status: "interrupted" }, { ...projection, status: "interrupted" });
    const snapshot = store.getSnapshot();
    expect(snapshot.liveEvents.some(function hasBefore(event) { return event.type === "answer_delta" && event.delta === "取消前"; })).toBe(true);
    expect(snapshot.liveEvents.some(function hasTail(event) { return event.type === "answer_delta" && event.delta === "取消后尾部"; })).toBe(false);
    expect(snapshot.status).toBe("interrupted");
  });

  it("info 只在下一次 prompt 发送前保留，提交后立即从输入区上方移除", async function consumesInfoWhenNextPromptIsSubmitted() {
    const projection = createInitialCliProjection();
    const store = createCliTuiStore();
    store.addNotice("model: deepseek/deepseek-v4-pro; 下一个 Turn 生效");
    store.recordPrompt("下一次请求");
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").not.toContain("info: model: deepseek/deepseek-v4-pro; 下一个 Turn 生效");
    rendered.unmount();
  });

  it("queue prompt 只在实际启动的 Turn 中出现，并在启动前清掉底部等待态", async function placesQueuedPromptAtConsumedTurn() {
    const firstProjection = createInitialCliProjection();
    firstProjection.status = "completed";
    firstProjection.turnId = "turn-queue-first";
    const store = createCliTuiStore();
    store.recordPrompt("主任务");
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-queue-first", stepCount: 0 }, { ...firstProjection, status: "running" });
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-queue-first", delta: "主任务输出" }, { ...firstProjection, status: "running" });
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-queue-first", status: "completed" }, firstProjection);
    store.addPendingPrompt("排队任务", { inputId: "queue-input-1", delivery: "queue" });

    store.markQueuedInputStarted({ inputId: "queue-input-1", turnId: "turn-queue-second", content: "排队任务", delivery: "queue" });
    const secondProjection = createInitialCliProjection();
    secondProjection.status = "running";
    secondProjection.turnId = "turn-queue-second";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-queue-second", stepCount: 0 }, secondProjection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-queue-second", delta: "排队任务输出" }, secondProjection);
    secondProjection.status = "completed";
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-queue-second", status: "completed" }, secondProjection);

    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(secondProjection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(store.getSnapshot().pendingInputs).toEqual([]);
    expect(frame).not.toContain("↳ [排队] you: 排队任务");
    expect(frame.split("排队任务").length - 1).toBe(2);
    expect(frame.indexOf("[排队] you: 排队任务")).toBeLessThan(frame.indexOf("排队任务输出"));
    expect(frame.indexOf("主任务输出")).toBeLessThan(frame.indexOf("[排队] you: 排队任务"));
    rendered.unmount();
  });

  it("备用屏收到 answer_reset 后不保留工具调用前的暂定回答", async function discardsProvisionalViewportAnswer() {
    const projection = createInitialCliProjection();
    projection.status = "running";
    projection.turnId = "turn-viewport-reset";
    const store = createCliTuiStore();
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: projection.turnId, delta: "备用屏暂定回答" }, projection);
    store.acceptEvent({ type: "answer_reset", seq: 3, turnId: projection.turnId }, projection);
    store.acceptEvent({ type: "tool_started", seq: 4, turnId: projection.turnId, toolName: "read_file", summary: "Reading todo.html" }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 5, turnId: projection.turnId, delta: "备用屏最终回答" }, projection);
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 6, turnId: projection.turnId, status: "completed" }, projection);

    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();

    expect(rendered.lastFrame() ?? "").not.toContain("备用屏暂定回答");
    expect(rendered.lastFrame() ?? "").toContain("备用屏最终回答");
    rendered.unmount();
  });

  it("备用屏保留既有品牌、CC 工具树、Autopilot 身份、耗时和输入上方 info，且活动 prompt 只显示一次", async function preservesExistingTuiSemantics() {
    const projection = createInitialCliProjection();
    projection.status = "running";
    projection.turnId = "turn-semantics";
    const store = createCliTuiStore();
    store.recordPrompt("检查当前工作区");
    store.addNotice("model: deepseek/deepseek-v4-pro; 下一个 Turn 生效");
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
    store.acceptEvent({ type: "reasoning_summary", seq: 2, turnId: projection.turnId, summary: "正在理解任务" }, projection);
    store.acceptEvent({ type: "tool_started", seq: 3, turnId: projection.turnId, toolName: "glob_files", summary: "Searching files: src/**" }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 4, turnId: projection.turnId, delta: "已找到相关文件。\n\n| 名称 | 版本 |\n| --- | --- |\n| cli | 1.0.0 |" }, projection);
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 5, turnId: projection.turnId, status: "completed" }, projection);
    const mouseInput = createTuiMouseInputSink();
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      mouseInput,
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();
    let frame = rendered.lastFrame() ?? "";
    mouseInput.dispatch({ code: 64, column: 1, row: 1, released: false, kind: "wheel_up" }, 999);
    await waitForTuiFrame();
    const brandFrame = rendered.lastFrame() ?? "";
    expect(brandFrame).toContain("Autopilot v1.0.0");
    const brandLines = brandFrame.split("\n");
    const brandInfoIndex = brandLines.findIndex(function findBrandInfo(line) { return line.includes("Autopilot v1.0.0"); });
    expect(brandLines.slice(brandInfoIndex - 1, brandInfoIndex).map(function normalizeBlank(line) { return line.slice(0, -1).trim(); })).toEqual([""]);
    mouseInput.dispatch({ code: 65, column: 1, row: 1, released: false, kind: "wheel_down" }, 999);
    await waitForTuiFrame();
    frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("├─ [查找文件]");
    expect(frame).toContain("• Autopilot");
    expect(frame).toContain("┌──────┬───────┐");
    expect(frame).toContain("* Cogitated for");
    expect(frame).toContain("info: model: deepseek/deepseek-v4-pro; 下一个 Turn 生效");
    expect(frame.match(/检查当前工作区/gu)).toHaveLength(1);
    expect(frame).not.toContain("> 检查当前工作区");
    rendered.unmount();
  });

  it("长表格在进入视口前按终端宽度同步换行，行边框不会被硬换行拆开", function keepsLongTableBordersAligned() {
    const table = formatTuiViewportMarkdown([
      "| 名称 | 说明 |",
      "| --- | --- |",
      "| mini-rag | 一个包含很长说明文字、英文标识和路径 app/page.tsx 的项目目录 |",
    ].join("\n"), 36);
    const tableLines = table.split("\n");
    const bodyLines = tableLines.filter(function isTableBody(line): boolean { return line.startsWith("│"); });

    expect(tableLines.every(function fitsViewport(line): boolean { return stringWidth(line) <= 36; })).toBe(true);
    expect(bodyLines).toHaveLength(5);
    expect(bodyLines.every(function keepsBothBorders(line): boolean { return line.endsWith("│"); })).toBe(true);
    expect(table).toContain("mini-rag");
    expect(table).toContain("app/page.tsx");
  });

  it("备用屏仅绘制视口，向上滚动后流式追加不拉回历史，并在 overscroll 后重回底部", async function keepsViewportAnchoredWhileStreaming() {
    const projection = createInitialCliProjection();
    projection.status = "running";
    projection.turnId = "turn-viewport";
    const store = createCliTuiStore();
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
    for (let index = 1; index <= 40; index += 1) {
      store.acceptEvent({ type: "answer_delta", seq: index + 1, turnId: projection.turnId, delta: `line-${String(index).padStart(2, "0")}\n` }, projection);
    }
    const mouseInput = createTuiMouseInputSink();
    const copied: string[] = [];
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      mouseInput,
      onCopyText: function onCopyText(text): void { copied.push(text); },
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-40");

    mouseInput.dispatch({ code: 0, column: 1, row: 1, released: false, kind: "button" });
    mouseInput.dispatch({ code: 32, column: 8, row: 1, released: false, kind: "drag" });
    mouseInput.dispatch({ code: 0, column: 8, row: 1, released: true, kind: "button" });
    await waitForTuiFrame();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^line-\d{2}$/u);

    mouseInput.dispatch({ code: 64, column: 1, row: 1, released: false, kind: "wheel_up" }, 99);
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-01");

    store.acceptEvent({ type: "answer_delta", seq: 42, turnId: projection.turnId, delta: "line-41\n" }, projection);
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-01");
    expect(rendered.lastFrame() ?? "").not.toContain("line-41");

    mouseInput.dispatch({ code: 65, column: 1, row: 1, released: false, kind: "wheel_down" }, 999);
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-41");
    rendered.unmount();
  });

  it("滚动条按住拖拽可直接定位视口，内容区点击不改变滚动位置", async function dragsScrollbarOnly() {
    const projection = createInitialCliProjection();
    projection.status = "running";
    projection.turnId = "turn-scrollbar";
    const store = createCliTuiStore();
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: projection.turnId, delta: Array.from({ length: 40 }, function createLine(_value, index) { return `row-${index + 1}\n`; }).join("") }, projection);
    const mouseInput = createTuiMouseInputSink();
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createViewportController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: false,
      renderMode: "alternate-screen",
      mouseInput,
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    await waitForTuiFrame();

    mouseInput.dispatch({ code: 0, column: 999, row: 1, released: false, kind: "button" });
    mouseInput.dispatch({ code: 32, column: 999, row: 1, released: false, kind: "drag" });
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("row-1");
    rendered.unmount();
  });
});
