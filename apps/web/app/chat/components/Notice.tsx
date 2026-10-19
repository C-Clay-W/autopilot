/**
 * 全局纸本通知：提供 success/error/warning 状态、顶部弹出反馈和 useNotice 调用入口。
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type NoticeStatus = "success" | "error" | "warning";

export interface NoticeApi {
  /** 显示成功通知，可传入自定义文案。 */
  success(message?: string): void;
  /** 显示失败通知，可传入自定义文案。 */
  error(message?: string): void;
  /** 显示警告通知，可传入自定义文案。 */
  warning(message?: string): void;
  /** 立即关闭当前通知。 */
  dismiss(): void;
}

interface NoticeProps {
  status: NoticeStatus;
  message: string;
  onDismiss?: () => void;
}

interface ActiveNotice extends NoticeProps {
  id: number;
}

const DEFAULT_MESSAGES: Record<NoticeStatus, string> = {
  success: "操作成功",
  error: "操作失败",
  warning: "请注意当前操作",
};

const NoticeContext = createContext<NoticeApi | null>(null);
let nextNoticeId = 0;

/** 根据通知状态绘制紧凑状态图标，统一使用纸本设计 token。 */
function NoticeIcon({ status }: { status: NoticeStatus }) {
  if (status === "success") return <svg className="h-4 w-4 shrink-0 text-accent" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="m2.5 8.25 3.25 3.25 7.75-7.5" /></svg>;
  if (status === "warning") return <svg className="h-4 w-4 shrink-0 text-accent" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="M8 2.25 14 13.5H2z" /><path d="M8 5.5v3.5M8 11.25v.25" /></svg>;
  return <svg className="h-4 w-4 shrink-0 text-error" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true"><path d="m3.25 3.25 9.5 9.5M12.75 3.25l-9.5 9.5" /></svg>;
}

/** 渲染固定在页面顶部的短暂通知，不参与消息流布局并保留可访问语义。 */
export default function Notice({ status, message, onDismiss }: NoticeProps) {
  const isError = status === "error";
  const toneClass = isError ? "border-error text-error" : status === "warning" ? "border-accent text-accent" : "border-ink text-ink";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex justify-center px-4" data-notice-status={status}>
      <div className={`notice-enter pointer-events-auto flex max-w-md items-center gap-3 border-2 bg-card px-4 py-3 text-xs shadow-[4px_4px_0_var(--ink)] ${toneClass}`} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"}>
        <NoticeIcon status={status} />
        <span className="min-w-0 flex-1">{message}</span>
        {onDismiss && <button type="button" onClick={onDismiss} className="shrink-0 border-l border-ink/20 pl-3 text-ink hover:text-accent" aria-label="关闭通知">×</button>}
      </div>
    </div>
  );
}

/** 提供全局通知状态、自动关闭计时和 success/error/warning 命令式 API。 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [activeNotice, setActiveNotice] = useState<ActiveNotice | null>(null);
  const timeoutRef = useRef<number | null>(null);

  /** 清除当前通知定时器，避免旧通知在新通知显示后提前关闭。 */
  const clearTimer = useCallback(function clearNoticeTimer(): void {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  /** 立即关闭当前通知并释放其自动关闭计时器。 */
  const dismiss = useCallback(function dismissNotice(): void {
    clearTimer();
    setActiveNotice(null);
  }, [clearTimer]);

  /** 显示一条顶部通知；连续调用时最新结果替换旧结果。 */
  const show = useCallback(function showNotice(status: NoticeStatus, message?: string): void {
    clearTimer();
    const nextNotice: ActiveNotice = {
      id: ++nextNoticeId,
      status,
      message: message?.trim() || DEFAULT_MESSAGES[status],
      onDismiss: dismiss,
    };
    setActiveNotice(nextNotice);
    timeoutRef.current = window.setTimeout(dismiss, status === "error" ? 4200 : 3000);
  }, [clearTimer, dismiss]);

  /** 组件卸载时释放计时器，避免页面切换后残留异步回调。 */
  useEffect(function cleanupNoticeTimer() {
    return clearTimer;
  }, [clearTimer]);

  /** 触发成功通知，供 useNotice 暴露稳定方法引用。 */
  const showSuccess = useCallback(function showSuccess(message?: string): void {
    show("success", message);
  }, [show]);

  /** 触发失败通知，供 useNotice 暴露稳定方法引用。 */
  const showError = useCallback(function showError(message?: string): void {
    show("error", message);
  }, [show]);

  /** 触发警告通知，供 useNotice 暴露稳定方法引用。 */
  const showWarning = useCallback(function showWarning(message?: string): void {
    show("warning", message);
  }, [show]);

  /** 组装全局通知 API，保持消费端调用方式与当前通知状态解耦。 */
  const notice = useMemo<NoticeApi>(function createNoticeApi() {
    return { success: showSuccess, error: showError, warning: showWarning, dismiss };
  }, [dismiss, showError, showSuccess, showWarning]);

  return (
    <NoticeContext.Provider value={notice}>
      {children}
      {activeNotice && <Notice key={activeNotice.id} status={activeNotice.status} message={activeNotice.message} onDismiss={dismiss} />}
    </NoticeContext.Provider>
  );
}

/** 读取全局通知命令；组件必须位于 NoticeProvider 内使用。 */
export function useNotice(): NoticeApi {
  const notice = useContext(NoticeContext);
  if (!notice) throw new Error("useNotice 必须在 NoticeProvider 内使用");
  return notice;
}
