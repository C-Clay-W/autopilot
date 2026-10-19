"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";

/** 侧边栏响应式状态 —— 移动端 overlay 开关 */
interface SidebarContextValue {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  desktopSidebarOpen: boolean;
  toggleDesktopSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

/** 在 ChatLayout 内使用，获取侧边栏开关方法 */
export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within ChatLayout");
  return ctx;
}

/** 侧边栏状态 Provider —— 包裹 ChatLayout */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleDesktopSidebar = useCallback(() => setDesktopSidebarOpen((v) => !v), []);

  return (
    <SidebarContext.Provider value={{ sidebarOpen, toggleSidebar, closeSidebar, desktopSidebarOpen, toggleDesktopSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}
