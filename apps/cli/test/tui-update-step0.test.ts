/** Talk-Plan0813 TUI Step 0 契约测试：滚动、原始输入、视觉行和历史均保持纯状态。 */

import { describe, expect, it } from "vitest";
import { createScrollViewportState, resizeScrollViewport, scrollViewportDown, scrollViewportToBottom, scrollViewportUp } from "../src/scroll-viewport.js";
import { createTimelineVisualLines } from "../src/timeline-lines.js";
import { createTuiInputRouter } from "../src/tui-input-router.js";
import { canNavigateTuiInputHistory, createTuiInputHistoryState, navigateTuiInputHistory, recordTuiInputHistory, updateTuiInputHistoryDraft } from "../src/tui-input-history.js";

describe("Talk-Plan0813 TUI Step 0", function tuiUpdateStep0Suite() {
  it("上滚解除钉底，overscroll 后重新钉底，并始终 clamp", function controlsViewportFollowMode() {
    let state = createScrollViewportState(20, 5);
    state = scrollViewportUp(state, 3);
    expect(state).toMatchObject({ scrollTop: 12, pinnedToBottom: false });
    state = scrollViewportDown(state, 3);
    expect(state).toMatchObject({ scrollTop: 15, pinnedToBottom: false });
    state = scrollViewportDown(state, 1);
    expect(state).toMatchObject({ scrollTop: 15, pinnedToBottom: true });
    expect(scrollViewportUp(state, 999)).toMatchObject({ scrollTop: 0, pinnedToBottom: false });
    expect(scrollViewportToBottom(state)).toMatchObject({ scrollTop: 15, pinnedToBottom: true });
  });

  it("resize 以当前可见首行为锚，钉底状态才跟随新的底部", function anchorsViewportResize() {
    const unpinned = resizeScrollViewport(scrollViewportUp(createScrollViewportState(30, 10), 7), 40, 8);
    expect(unpinned).toMatchObject({ scrollTop: 13, totalHeight: 40, viewportHeight: 8, pinnedToBottom: false });
    expect(resizeScrollViewport(unpinned, 15, 8)).toMatchObject({ scrollTop: 7, pinnedToBottom: false });
    expect(resizeScrollViewport(createScrollViewportState(30, 10), 40, 8)).toMatchObject({ scrollTop: 32, pinnedToBottom: true });
  });

  it("SGR 鼠标报文支持拆包和粘包，并不泄漏到普通键盘输入", function routesSgrMouseInput() {
    const router = createTuiInputRouter();
    expect(router.push("hello\u001b[<64;10")).toEqual({ passthrough: "hello", mouseEvents: [], diagnostics: [] });
    expect(router.push(";4M\u001b[<65;11;4Mworld")).toEqual({
      passthrough: "world",
      mouseEvents: [
        { code: 64, column: 10, row: 4, released: false, kind: "wheel_up" },
        { code: 65, column: 11, row: 4, released: false, kind: "wheel_down" },
      ],
      diagnostics: [],
    });
    expect(router.push("\u001b[Ax")).toEqual({ passthrough: "\u001b[Ax", mouseEvents: [], diagnostics: [] });
  });

  it("兼容 CC 同时保留的 X10 鼠标回退报文，滚轮和拖拽都不进入 prompt", function routesX10MouseInput() {
    const router = createTuiInputRouter();
    expect(router.push("before\u001b[M")).toEqual({ passthrough: "before", mouseEvents: [], diagnostics: [] });
    expect(router.push("`*%\u001b[M@*'after")).toEqual({
      passthrough: "after",
      mouseEvents: [
        { code: 64, column: 10, row: 5, released: false, kind: "wheel_up" },
        { code: 32, column: 10, row: 7, released: false, kind: "drag" },
      ],
      diagnostics: [],
    });
  });

  it("1003 无按键移动与按住拖拽分流，悬停不会误拖动滚动条", function distinguishesMouseMoveFromDrag() {
    const router = createTuiInputRouter();
    expect(router.push("\u001b[<35;20;8M\u001b[<32;20;9M")).toEqual({
      passthrough: "",
      mouseEvents: [
        { code: 35, column: 20, row: 8, released: false, kind: "move" },
        { code: 32, column: 20, row: 9, released: false, kind: "drag" },
      ],
      diagnostics: [],
    });
  });

  it("残缺或未知 SGR 前缀只产生稳定诊断，永不进入 prompt", function dropsInvalidSgrInput() {
    const invalid = createTuiInputRouter();
    expect(invalid.push("\u001b[<oopsMprompt")).toEqual({ passthrough: "prompt", mouseEvents: [], diagnostics: ["invalid_sgr_mouse"] });
    const incomplete = createTuiInputRouter();
    incomplete.push("\u001b[<64;1");
    expect(incomplete.finish()).toEqual({ passthrough: "", mouseEvents: [], diagnostics: ["invalid_sgr_mouse"] });
  });

  it("视觉行复用终端宽度计算并保留中文、emoji 与样式坐标", function mapsTimelineVisualLines() {
    const lines = createTimelineVisualLines([{ itemId: "answer-1", text: "中a👩🏽‍💻文", spans: [{ start: 1, end: 2, style: "bold" }] }], 4);
    expect(lines.map(function text(line) { return line.text; })).toEqual(["中a", "👩🏽‍💻文"]);
    expect(lines.map(function width(line) { return line.displayWidth; })).toEqual([3, 4]);
    expect(lines[0]?.spans).toEqual([{ start: 1, end: 2, style: "bold" }]);
  });

  it("历史仅在视觉边界启用，保存草稿、隔离 picker 并按 FIFO 截断", function preservesHistoryContract() {
    let state = createTuiInputHistoryState();
    state = recordTuiInputHistory(state, "first", 2);
    state = recordTuiInputHistory(state, "second", 2);
    state = recordTuiInputHistory(state, "third", 2);
    expect(state.entries).toEqual(["second", "third"]);
    expect(canNavigateTuiInputHistory("up", 1, 2, false, false)).toBe(false);
    expect(canNavigateTuiInputHistory("up", 0, 2, false, true)).toBe(false);
    expect(canNavigateTuiInputHistory("up", 0, 2, false, false)).toBe(true);
    let navigation = navigateTuiInputHistory(state, "up", "draft");
    expect(navigation.input).toBe("third");
    navigation = navigateTuiInputHistory(navigation.state, "up", navigation.input);
    expect(navigation.input).toBe("second");
    navigation = navigateTuiInputHistory(navigation.state, "down", navigation.input);
    navigation = navigateTuiInputHistory(navigation.state, "down", navigation.input);
    expect(navigation.input).toBe("draft");
    expect(updateTuiInputHistoryDraft(navigation.state, "edited")).toMatchObject({ draft: "edited", index: undefined });
  });
});
