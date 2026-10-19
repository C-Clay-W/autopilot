/**
 * DiffSidebarDivider.tsx — 桌面端 Diff 侧边栏的可拖分隔条。
 * 参考 DS AppFrame DragHandle：Pointer Capture 锁定指针、rAF 节流上报位移、
 * 统一处理结束/取消/卸载；拖动取消时回滚到拖动前宽度，并支持左右方向键调宽。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface DiffSidebarDividerProps {
  /** 当前 Diff 侧边栏宽度（px），由父布局持有。 */
  width: number;
  /** 宽度变更回调；父布局负责钳制限值。 */
  onChange(width: number): void;
}

/** 桌面端分隔条：拖动改变右侧 Diff 面板宽度，窄屏（md 以下）不渲染。 */
export default function DiffSidebarDivider({ width, onChange }: DiffSidebarDividerProps) {
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

  /** 按下开始拖动：仅主键且桌面视口生效；记录起点与基准宽度并锁定指针。 */
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || capture.current !== null) return;
    if (!window.matchMedia("(min-width: 768px)").matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    capture.current = { element: event.currentTarget, id: event.pointerId };
    origin.current = event.clientX;
    latest.current = event.clientX;
    baseWidth.current = width;
    setDragging(true);
  }

  /** 拖动中：rAF 节流上报宽度（Diff 在右侧，指针左移为加宽）。 */
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    latest.current = event.clientX;
    if (frame.current === null) {
      frame.current = requestAnimationFrame(function reportDrag() {
        frame.current = null;
        callbacks.current.onChange(baseWidth.current - (latest.current - origin.current));
      });
    }
  }

  /** 松开结束拖动并提交最终宽度。 */
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    callbacks.current.onChange(baseWidth.current - (event.clientX - origin.current));
    endDrag(false);
  }

  /** 拖动被系统取消（如切换窗口）时回滚到拖动前宽度。 */
  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
    if (capture.current?.id !== event.pointerId) return;
    endDrag(true);
  }

  /** 键盘调宽：左方向键加宽（分隔条左移），右方向键收窄，步进 16px。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onChange(width + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onChange(width - step);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 Diff 侧边栏宽度"
      aria-valuenow={Math.round(width)}
      aria-valuemin={300}
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
      className="hidden w-2 shrink-0 cursor-col-resize md:block focus:outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
    />
  );
}
