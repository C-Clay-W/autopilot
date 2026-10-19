/** 备用屏视口滚动/鼠标/划选状态 hook。 */

import { useEffect, useRef, useState } from "react";
import type { Key } from "ink";
import {
  createScrollViewportState,
  resizeScrollViewport,
  scrollViewportDown,
  scrollViewportToTop,
  scrollViewportUp,
  type ScrollViewportState,
} from "../../scroll-viewport.js";
import type { TimelineVisualLine } from "../../timeline-lines.js";
import type { TuiSgrMouseEvent } from "../../tui-input-router.js";
import {
  copyTuiSelectedText,
  getTuiSelectedText,
  resolveTuiVisualLineOffset,
  type TuiTextSelection,
  type TuiTextSelectionPoint,
} from "../viewport/selection.js";

/** 管理备用屏视口的滚动、鼠标事件与文字划选状态。 */
export function useViewport(input: {
  isViewportMode: boolean;
  columns: number;
  viewportLines: TimelineVisualLine[];
  viewportHeight: number;
  stdout: { write(chunk: string): void };
  onCopyText?: (text: string) => void;
}): {
  viewportState: ScrollViewportState;
  selection: TuiTextSelection;
  handleTuiMouseEvent: (event: TuiSgrMouseEvent, wheelNotches: number) => void;
  handleTuiViewportKey: (key: Key) => boolean;
} {
  const { isViewportMode, columns, viewportLines, viewportHeight, stdout, onCopyText } = input;
  const [selection, setSelection] = useState<TuiTextSelection>({});
  const selectionRef = useRef(selection);
  const scrollbarDraggingRef = useRef(false);
  const selectionDraggingRef = useRef(false);
  const [viewportState, setViewportState] = useState(function createInitialViewportState() {
    return createScrollViewportState(viewportLines.length, viewportHeight);
  });
  const viewportStateRef = useRef(viewportState);

  /** 同步保存视口状态，供 16ms 合并后的鼠标回调读取最新位置。 */
  function updateViewportState(next: ScrollViewportState): void {
    viewportStateRef.current = next;
    setViewportState(next);
  }

  /** 同步更新文字划选状态，确保鼠标 release 立即复制本次拖拽的最终范围。 */
  function updateTuiTextSelection(next: TuiTextSelection): void {
    selectionRef.current = next;
    setSelection(next);
  }

  /** 将视口内鼠标坐标转换成时间线来源坐标；固定输入区和滚动条不参与划选。 */
  function resolveTuiSelectionPoint(event: TuiSgrMouseEvent): TuiTextSelectionPoint | undefined {
    if (event.column >= columns || event.row < 1 || event.row > viewportStateRef.current.viewportHeight) return undefined;
    const line = viewportLines[viewportStateRef.current.scrollTop + event.row - 1];
    return line ? { itemId: line.itemId, sourceOffset: resolveTuiVisualLineOffset(line, event.column - 1) } : undefined;
  }

  /** 用鼠标滚轮或滚动条拖拽更新备用屏视口；内容区点击保留给文字划选。 */
  function handleTuiMouseEvent(event: TuiSgrMouseEvent, wheelNotches: number): void {
    if (!isViewportMode) return;
    if (event.kind === "move") return;
    const current = viewportStateRef.current;
    if (event.kind === "wheel_up") {
      updateViewportState(scrollViewportUp(current, 3 * wheelNotches));
      return;
    }
    if (event.kind === "wheel_down") {
      updateViewportState(scrollViewportDown(current, 3 * wheelNotches));
      return;
    }
    const hitsScrollbar = event.column >= columns;
    const selectionPoint = resolveTuiSelectionPoint(event);
    if (event.released && selectionDraggingRef.current) {
      if (selectionPoint) updateTuiTextSelection({ ...selectionRef.current, focus: selectionPoint });
      selectionDraggingRef.current = false;
      const text = getTuiSelectedText(viewportLines, selectionPoint ? { ...selectionRef.current, focus: selectionPoint } : selectionRef.current);
      if (text) {
        if (onCopyText) onCopyText(text);
        else copyTuiSelectedText(text, stdout);
      }
      return;
    }
    if (event.released) {
      scrollbarDraggingRef.current = false;
      return;
    }
    if (!hitsScrollbar && event.kind === "button" && selectionPoint) {
      selectionDraggingRef.current = true;
      updateTuiTextSelection({ anchor: selectionPoint, focus: selectionPoint });
      return;
    }
    if (!hitsScrollbar && event.kind === "drag" && selectionDraggingRef.current && selectionPoint) {
      updateTuiTextSelection({ ...selectionRef.current, focus: selectionPoint });
      return;
    }
    if (event.kind === "button") scrollbarDraggingRef.current = hitsScrollbar;
    if (!hitsScrollbar && !scrollbarDraggingRef.current) return;
    if (event.kind !== "button" && event.kind !== "drag") return;
    const maximumTop = Math.max(0, current.totalHeight - current.viewportHeight);
    const ratio = current.viewportHeight <= 1 ? 0 : Math.max(0, Math.min(1, (event.row - 1) / (current.viewportHeight - 1)));
    const scrollTop = Math.round(maximumTop * ratio);
    updateViewportState({ ...current, scrollTop, pinnedToBottom: scrollTop >= maximumTop });
  }

  /** 在真实备用屏中处理半视口与顶底跳转；picker 和审批由前置键位分支优先消费。 */
  function handleTuiViewportKey(key: Key): boolean {
    if (!isViewportMode) return false;
    const current = viewportStateRef.current;
    const jump = Math.max(1, Math.floor(current.viewportHeight / 2));
    if (key.pageUp) {
      updateViewportState(scrollViewportUp(current, jump));
      return true;
    }
    if (key.pageDown) {
      updateViewportState(scrollViewportDown(current, jump));
      return true;
    }
    if (key.ctrl && key.home) {
      updateViewportState(scrollViewportToTop(current));
      return true;
    }
    if (key.ctrl && key.end) {
      updateViewportState(scrollViewportDown(current, Number.MAX_SAFE_INTEGER));
      return true;
    }
    return false;
  }

  useEffect(function resizeTuiViewport() {
    if (!isViewportMode) return;
    updateViewportState(resizeScrollViewport(viewportStateRef.current, viewportLines.length, viewportHeight));
  }, [isViewportMode, viewportLines.length, viewportHeight]);

  return { viewportState, selection, handleTuiMouseEvent, handleTuiViewportKey };
}
