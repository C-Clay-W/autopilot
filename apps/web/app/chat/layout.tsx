"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { SidebarProvider, useSidebar } from "./sidebar-context";
import Sidebar from "./Sidebar";
import { SessionTaskProvider } from "./session-task-context";

/** 侧边栏内部内容，桌面端和移动端复用 */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-accent text-ink-on-dark flex items-center justify-center font-bold">
            T
          </div>
          <span className="font-bold text-base">Autopilot</span>
        </div>
      </div>
      <div className="divider-dotted !my-0 mx-4" />
      <Suspense fallback={<div className="px-3 py-3"><p className="text-xs text-muted">加载中…</p></div>}>
        <Sidebar onNavigate={onNavigate} />
      </Suspense>
    </>
  );
}

/** 响应式侧边栏外壳：桌面端常驻 flex，移动端 overlay + 滑入滑出动画 */
function SidebarShell() {
  const { sidebarOpen, closeSidebar, desktopSidebarOpen } = useSidebar();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 动画状态：mounted 控制 DOM 挂载，show 控制 CSS 过渡
  const [mounted, setMounted] = useState(false);
  const [show, setShow] = useState(false);

  // 路由变化时关闭移动端侧边栏
  useEffect(() => {
    closeSidebar();
  }, [pathname, searchParams, closeSidebar]);

  // 入场/退场动画生命周期
  useEffect(() => {
    if (sidebarOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 先挂载再交给下一帧执行入场动画。
      setMounted(true);
      // 双 rAF：等浏览器绘制完初始隐藏态（-translate-x-full / opacity-0）后再切到 show
      const raf1 = requestAnimationFrame(() => {
        const raf2 = requestAnimationFrame(() => setShow(true));
        return () => cancelAnimationFrame(raf2);
      });
      return () => cancelAnimationFrame(raf1);
    } else if (mounted) {
      setShow(false);
    }
  }, [sidebarOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 退场动画结束后移除 DOM */
  function handleTransitionEnd() {
    if (!show) {
      setMounted(false);
    }
  }

  return (
    <>
      {/* 桌面端侧边栏：md 及以上始终可见 */}
      <aside className={`hidden ${desktopSidebarOpen ? "md:flex" : "md:hidden"} h-full min-h-0 w-65 min-w-65 bg-bg border-r-2 border-ink flex-col`}>
        <SidebarContent />
      </aside>

      {/* 移动端侧边栏：固定 overlay + 过渡动画 */}
      {mounted && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* 遮罩层：淡入淡出 */}
          <div
            className={`absolute inset-0 bg-ink/50 transition-opacity duration-200 ${show ? "opacity-100" : "opacity-0"}`}
            onClick={closeSidebar}
            aria-hidden
          />
          {/* 侧边栏本体：从左滑入 */}
          <aside
            className={`absolute left-0 top-0 bottom-0 w-65 bg-bg border-r-2 border-ink flex flex-col z-50 transition-transform duration-200 ease-out ${show ? "translate-x-0" : "-translate-x-full"}`}
            onTransitionEnd={handleTransitionEnd}
          >
            <SidebarContent onNavigate={closeSidebar} />
          </aside>
        </div>
      )}
    </>
  );
}

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <SessionTaskProvider>
      <SidebarProvider>
        <div className="fixed inset-0 overflow-hidden flex">
          <Suspense fallback={null}>
            <SidebarShell />
          </Suspense>
          <main className="flex-1 min-h-0 overflow-hidden flex flex-col min-w-0 h-full">
            {children}
          </main>
        </div>
      </SidebarProvider>
    </SessionTaskProvider>
  );
}
