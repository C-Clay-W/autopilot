/**
 * 聊天视口智能滚动：用户停在底部时跟随新进展，主动上滚后保留阅读位置并累计未读进展。
 * 跟随意图与滚动位置分离：我们自己的跟随滚动不作为用户意图解读（DS use-scroll-follow 的 interrupt 思路）；
 * pinned 时除进展通知外，还按帧合并跟随内容与视口尺寸变化（卡片展开、Todo、输入区高度、Diff 拖动等）。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SmartScrollMode = "pinned" | "free";

export interface SmartScrollState {
  mode: SmartScrollMode;
  unreadCount: number;
}

interface SmartScrollUpdate {
  state: SmartScrollState;
  shouldScroll: boolean;
}

interface UseSmartScrollOptions {
  sessionId: string;
}

interface SmartScrollRuntimeState extends SmartScrollState {
  sessionId: string;
  updateVersion: number;
}

const bottomThreshold = 48;
/** 立即（auto）跟随滚动的窗口期：覆盖事件到达前的短暂延迟。 */
const programmaticFollowWindowMs = 120;
/** 平滑滚动（showLatest）的窗口期：动画期间的中间位置不重新分类。 */
const smoothScrollSettleMs = 800;

/** 根据容器与底部的距离判断用户是否仍停留在最新进展处。 */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= bottomThreshold;
}

/** 判断滚动事件是否仍处在我们自己触发的滚动窗口内；窗口内事件不作为用户意图解读。 */
export function isProgrammaticScrollWindow(now: number, programmaticUntil: number): boolean {
  return now < programmaticUntil;
}

/** 将用户滚动位置转换为 Pinned 或 FreeScroll，回到底部时清空未读计数。 */
export function getSmartScrollStateOnViewportChange(state: SmartScrollState, nearBottom: boolean): SmartScrollState {
  if (nearBottom) return { mode: "pinned", unreadCount: 0 };
  if (state.mode === "free") return state;
  return { ...state, mode: "free" };
}

/** 新进展只会在 Pinned 时触发自动跟随；FreeScroll 时统一累计未读。 */
export function getSmartScrollStateOnContentChange(state: SmartScrollState): SmartScrollUpdate {
  if (state.mode === "pinned") return { state, shouldScroll: true };
  return { state: { ...state, unreadCount: state.unreadCount + 1 }, shouldScroll: false };
}

/** 判断用户系统是否要求减少动态效果。 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 将视口定位到最新进展，并登记程序滚动窗口；用户主动点击时才保留平滑滚动。 */
function scrollToLatest(container: HTMLDivElement, behavior: ScrollBehavior, programmaticScrollUntil: { current: number }): void {
  container.scrollTo({ top: container.scrollHeight, behavior });
  programmaticScrollUntil.current = Date.now() + (behavior === "smooth" ? smoothScrollSettleMs : programmaticFollowWindowMs);
}

/** 为指定会话创建无未读的 Pinned 初始滚动状态。 */
function createInitialState(sessionId: string): SmartScrollRuntimeState {
  return { sessionId, mode: "pinned", unreadCount: 0, updateVersion: 0 };
}

/** 为当前渲染会话选择状态，切换会话时不读取或复用旧会话的未读进展。 */
function getCurrentState(state: SmartScrollRuntimeState, sessionId: string): SmartScrollRuntimeState {
  return state.sessionId === sessionId ? state : createInitialState(sessionId);
}

/** 管理单个聊天 Session 的 Pinned / FreeScroll 状态与未读进展计数。 */
export function useSmartScroll({ sessionId }: UseSmartScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 这是“惰性初始化函数”。React 在首次挂载时调用它，并把返回值作为 state；不是把函数本身存进去。相比先在外部执行再传值，它避免每次渲染都计算初始值。
  // added by clayw on 20260824
  const [state, setState] = useState<SmartScrollRuntimeState>(function createInitialSmartScrollState() {
    return createInitialState(sessionId);
  });
  const currentState = getCurrentState(state, sessionId);

  /** 程序滚动窗口截止时间；滚轮/触摸/键盘打断后立即归零。 */
  const programmaticScrollUntil = useRef(0);
  /** pinned 判定的镜像：ResizeObserver 回调读取，避免闭包拿到过期模式。 */
  const pinnedRef = useRef(currentState.mode === "pinned");
  useEffect(function syncPinnedRef() {
    pinnedRef.current = currentState.mode === "pinned";
  }, [currentState.mode, sessionId]);

  /** 用户主动滚动时仅依据真实容器距离切换模式；我们自己的跟随滚动在窗口内不做重新分类。 */
  const handleScroll = useCallback(function handleScroll(): void {
    const container = containerRef.current;
    if (!container) return;
    if (isProgrammaticScrollWindow(Date.now(), programmaticScrollUntil.current)) return;
    setState(function updateViewportState(previous) {
      const current = getCurrentState(previous, sessionId);
      return { ...getSmartScrollStateOnViewportChange(current, isNearBottom(container.scrollHeight, container.scrollTop, container.clientHeight)), sessionId, updateVersion: current.updateVersion };
    });
  }, [sessionId]);

  /** 用户滚轮/触摸/键盘操作立即接管滚动权，清除程序滚动窗口；随后的 scroll 事件恢复按用户意图分类。 */
  useEffect(function listenUserInterruption() {
    const container = containerRef.current;
    if (!container) return;
    const markUserInterruption = function markUserInterruption(): void {
      programmaticScrollUntil.current = 0;
    };
    container.addEventListener("wheel", markUserInterruption, { passive: true });
    container.addEventListener("touchstart", markUserInterruption, { passive: true });
    container.addEventListener("keydown", markUserInterruption);
    return function unbindUserInterruption() {
      container.removeEventListener("wheel", markUserInterruption);
      container.removeEventListener("touchstart", markUserInterruption);
      container.removeEventListener("keydown", markUserInterruption);
    };
  }, [sessionId]);

  /** pinned 时按帧合并跟随内容与视口尺寸变化；free 阅读历史时不强拉，只累计未读。 */
  useEffect(function followSizeChanges() {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const schedulePinnedFollow = function schedulePinnedFollow(): void {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(function followIfPinned() {
        frame = null;
        const target = containerRef.current;
        if (!target || !pinnedRef.current) return;
        scrollToLatest(target, "auto", programmaticScrollUntil);
      });
    };
    const observer = new ResizeObserver(schedulePinnedFollow);
    observer.observe(container);
    if (contentRef.current) observer.observe(contentRef.current);
    return function disconnectSizeObserver() {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [sessionId]);

  /** 用户选择查看最新进展后恢复 Pinned，并按系统动态效果偏好滚动。 */
  const showLatest = useCallback(function showLatest(): void {
    const container = containerRef.current;
    if (!container) return;
    setState(function pinLatestProgress(previous) {
      const current = getCurrentState(previous, sessionId);
      return { ...current, mode: "pinned", unreadCount: 0 };
    });
    scrollToLatest(container, prefersReducedMotion() ? "auto" : "smooth", programmaticScrollUntil);
  }, [sessionId]);

  /** 接收一次新的聊天进展；FreeScroll 只累计未读，Pinned 才在 DOM 更新后跟随到底部。 */
  const notifyNewProgress = useCallback(function notifyNewProgress(): void {
    setState(function updateProgressState(previous) {
      const current = getCurrentState(previous, sessionId);
      const update = getSmartScrollStateOnContentChange(current);
      return { ...update.state, sessionId, updateVersion: current.updateVersion + 1 };
    });
  }, [sessionId]);

  /** 在 React 提交消息 DOM 后，仅让仍处于 Pinned 状态的视口自动跟随。 */
  useEffect(function followContentUpdates() {
    const container = containerRef.current;
    if (!container || currentState.mode !== "pinned") return;
    const frame = window.requestAnimationFrame(function followPinnedViewport() {
      scrollToLatest(container, "auto", programmaticScrollUntil);
    });
    return function cancelPinnedViewportFrame() {
      window.cancelAnimationFrame(frame);
    };
  }, [currentState.mode, currentState.updateVersion, sessionId]);

  return { containerRef, contentRef, isPinned: currentState.mode === "pinned", unreadCount: currentState.unreadCount, handleScroll, showLatest, notifyNewProgress };
}
