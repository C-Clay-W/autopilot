/**
 * DiffSidebarDivider.tsx — 桌面端 Diff 侧边栏的可拖分隔条。
 * 参考 DS AppFrame DragHandle：Pointer Capture 锁定指针、rAF 节流上报位移、
 * 统一处理结束/取消/卸载；拖动取消时回滚到拖动前宽度，并支持左右方向键调宽。
 * 方向按被控面板所在侧统一：右栏（Diff，widenOn=left）指针左移加宽、ArrowLeft 加宽；
 * 左栏（预览，widenOn=right）指针右移加宽、ArrowRight 加宽。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 被控面板所在侧：左栏（widenOn=right）右移加宽，右栏（widenOn=left）左移加宽。 */
type WidenOn = "left" | "right";

/**
 * 指针右移时受控宽度的变化方向。
 * 右栏面板指针左移加宽 → -1；左栏面板指针右移加宽 → +1。
 */
function widthDirection(widenOn: WidenOn): 1 | -1 {
  return widenOn === "left" ? -1 : 1;
}

/** 拖动换算：把指针水平位移换算成受控宽度；方向由被控面板所在侧决定。 */
export function dividerWidthFromDrag(baseWidth: number, deltaX: number, widenOn: WidenOn = "left"): number {
  return baseWidth + widthDirection(widenOn) * deltaX;
}

/** 键盘换算：ArrowLeft/ArrowRight 按加宽方向调整；其余按键返回 undefined 交由调用方处理。 */
export function dividerWidthFromKey(width: number, key: string, stepPx: number, widenOn: WidenOn = "left"): number | undefined {
  const direction = widthDirection(widenOn);
  if (key === "ArrowLeft") return width - direction * stepPx;
  if (key === "ArrowRight") return width + direction * stepPx;
  return undefined;
}

interface DiffSidebarDividerProps {
  /** 当前受控面板宽度（px）：Diff 为右栏宽度，预览为左栏宽度；由父布局持有。 */
  width: number;
  /** 宽度变更回调；父布局负责钳制限值。 */
  onChange(width: number): void;
  /** 分隔条可访问名称；预览区域复用时覆盖。 */
  label?: string;
  /** 键盘步进像素；默认 16（Shift 加速三倍）。 */
  stepPx?: number;
  /** 左方向键是否为加宽方向；Diff（右栏）默认 left，预览（左栏）传 right。 */
  widenOn?: WidenOn;
  /** 提供 Home/End 极值与钳制边界。 */
  bounds?: { minPx: number; maxPx: number };
  /** 覆盖 aria-valuenow/min/max（预览按左栏宽度百分比上报）。 */
  ariaValue?: { now: number; min: number; max: number };
  /** 是否受桌面视口（≥768px）约束：Diff 默认 true，预览按容器能力自行决定并传 false。 */
  viewportGated?: boolean;
}

/** 桌面端分隔条：拖动改变受控面板宽度，窄屏（md 以下）不渲染；Diff 默认行为不变。 */
export default function DiffSidebarDivider({ width, onChange, label = "调整 Diff 侧边栏宽度", stepPx: stepBase = 16, widenOn = "left", bounds, ariaValue, viewportGated = true }: DiffSidebarDividerProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const baseWidth = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null);
  const callbacks = useRef({ onChange });
  callbacks.current = { onChange };

  /** 统一结束拖动：释放指针捕获、取消未执行的 rAF、清理捕获状态并回调结束。 */
  const endDrag = useCallback(function endDrag(revert: boolean) {
    const active = capture.current;
    if (active === null) return;
    capture.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
    if (revert) callbacks.current.onChange(baseWidth.current);
  }, []);

  /** 组件卸载时结束拖动，防止捕获泄漏。 */
  useEffect(function endDragOnUnmount() {
    return function unbind() {
      endDrag(false);
    };
  }, [endDrag]);

  /** 按下开始拖动：仅主键生效；视口受限时（Diff）要求桌面宽度，预览由容器能力决定。 */
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || capture.current !== null) return;
    if (viewportGated && !window.matchMedia("(min-width: 768px)").matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    capture.current = { element: event.currentTarget, id: event.pointerId };
    origin.current = event.clientX;
    latest.current = event.clientX;
    baseWidth.current = width;
    setDragging(true);
  }

  /** 拖动中：rAF 节流上报宽度；方向由 widenOn 决定。 */
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    latest.current = event.clientX;
    if (frame.current === null) {
      frame.current = requestAnimationFrame(function reportDrag() {
        frame.current = null;
        callbacks.current.onChange(dividerWidthFromDrag(baseWidth.current, latest.current - origin.current, widenOn));
      });
    }
  }

  /** 松开结束拖动并提交最终宽度。 */
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    callbacks.current.onChange(dividerWidthFromDrag(baseWidth.current, event.clientX - origin.current, widenOn));
    endDrag(false);
  }

  /** 拖动被系统取消（如切换窗口）时回滚到拖动前宽度。 */
  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    endDrag(true);
  }

  /** 键盘调宽：ArrowLeft/ArrowRight 使用与被控面板一致的方向，Home/End 到极值。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? stepBase * 3 : stepBase;
    const nextWidth = dividerWidthFromKey(width, event.key, step, widenOn);
    if (nextWidth !== undefined) {
      event.preventDefault();
      onChange(nextWidth);
    } else if (bounds && event.key === "Home") {
      event.preventDefault();
      onChange(bounds.minPx);
    } else if (bounds && event.key === "End") {
      event.preventDefault();
      onChange(bounds.maxPx);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(ariaValue ? ariaValue.now : width)}
      aria-valuemin={Math.round(ariaValue ? ariaValue.min : 300)}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={function handleLostCapture() {
        if (capture.current !== null) endDrag(true);
      }}
      onKeyDown={handleKeyDown}
      className={(viewportGated ? "hidden md:block " : "") + "w-2 shrink-0 cursor-col-resize focus:outline-none hover:bg-accent/30 focus-visible:bg-accent/40"}
    />
  );
}
