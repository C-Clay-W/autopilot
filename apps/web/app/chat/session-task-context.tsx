/**
 * session-task-context.tsx — `/chat` 根布局持有的 SessionTaskManager React 接线。
 *
 * Context 只暴露当前页面的会话列表和 manager；持久 Session/Turn 事实仍通过 API/Core 获取。
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { CHAT_SCOPE, sessionApiUrl } from "./conversation-target";
import type { WebSessionDto } from "@/lib/runtime-host/web-ui-dto";
import { createSessionTaskManager, createWorkspaceSessionKey, type SessionTaskManager } from "./session-task-store";

/** 浏览器可见的工作区安全摘要；不包含任何宿主路径。 */
export interface WorkspaceSummary {
  workspaceId: string;
  displayName: string;
  lastOpenedAt: number;
  available: boolean;
  trustStatus: "trusted" | "pending" | "denied" | "expired";
}

interface SessionTaskContextValue {
  manager: SessionTaskManager;
  loading: boolean;
  workspaces: readonly WorkspaceSummary[];
  directoryPickerAvailable: boolean;
  refreshWorkspaces(): Promise<readonly WorkspaceSummary[]>;
  refreshSessions(workspaceId?: string): Promise<void>;
  removeSession(workspaceId: string, sessionId: string): void;
  removeWorkspace(workspaceId: string): Promise<boolean>;
}

const SessionTaskContext = createContext<SessionTaskContextValue | null>(null);

/** 创建跨 query 导航常驻的 Session manager Provider。 */
export function SessionTaskProvider({ children }: { children: ReactNode }) {
  const [manager] = useState<SessionTaskManager>(createSessionTaskManager);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [directoryPickerAvailable, setDirectoryPickerAvailable] = useState(false);

  /** 从安全工作区 API 读取可选择的本机工作区，不请求能力或路径信息。 */
  const refreshWorkspaces = useCallback(async function refreshWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    try {
      const response = await fetch("/api/workspaces");
      if (!response.ok) return [];
      const payload = await response.json() as { workspaces?: WorkspaceSummary[]; directoryPickerAvailable?: boolean };
      const next = payload.workspaces ?? [];
      setWorkspaces(next);
      setDirectoryPickerAvailable(payload.directoryPickerAvailable === true);
      return next;
    } catch {
      return [];
    }
  }, []);

  /** 从指定工作区的安全会话 API 校准 manager，不读取 checkpoint 或 Provider 信息。 */
  const refreshSessions = useCallback(async function refreshSessions(workspaceId?: string): Promise<void> {
    try {
      if (!workspaceId || workspaceId === CHAT_SCOPE) {
        const response = await fetch(sessionApiUrl(CHAT_SCOPE)!);
        if (response.ok) {
          const payload = await response.json() as { sessions?: WebSessionDto[] };
          manager.syncWorkspaceSessions(CHAT_SCOPE, payload.sessions ?? []);
        }
      }
      if (workspaceId === CHAT_SCOPE) return;
      const targets = workspaceId
        ? workspaces.filter(function matchWorkspace(workspace) { return workspace.workspaceId === workspaceId; })
        : workspaces;
      const readableTargets = workspaceId && targets.length === 0
        ? [{ workspaceId, displayName: "", lastOpenedAt: 0, available: true, trustStatus: "trusted" as const }]
        : targets.filter(function isReadableWorkspace(workspace) {
        return workspace.available && workspace.trustStatus === "trusted";
      });
      await Promise.all(readableTargets.map(async function refreshWorkspaceSessions(workspace) {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.workspaceId)}/sessions`);
        if (!response.ok) return;
        const payload = await response.json() as { sessions?: WebSessionDto[] };
        manager.syncWorkspaceSessions(workspace.workspaceId, payload.sessions ?? []);
      }));
    } catch {
      /* 网络短暂不可用时保留最后一个安全快照，避免页面恢复产生未处理 Promise。 */
    } finally {
      setLoading(false);
    }
  }, [manager, workspaces]);

  useEffect(function loadSessionList() {
    void refreshSessions(CHAT_SCOPE);
  // 首次只加载 Chat；Work Registry 由用户进入 Work 后请求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager]);

  useEffect(function loadWorkspaceSessionLists() {
    if (!workspaces.length) return;
    void refreshSessions();
  }, [workspaces, refreshSessions]);

  /** 窗口重新可见或获得焦点时，用安全列表校准可恢复的 Core 运行状态。 */
  useEffect(function refreshSessionsAfterWindowRestore() {
    function refreshWhenVisible(): void {
      if (document.visibilityState === "hidden") return;
      if (workspaces.length) void refreshWorkspaces();
      void refreshSessions();
    }

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return function removeWindowRestoreListeners(): void {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshSessions, refreshWorkspaces, workspaces.length]);

  /** 使用复合键删除内存快照，避免同名 Session 跨工作区串用。 */
  function removeSession(workspaceId: string, sessionId: string): void {
    manager.removeSession(createWorkspaceSessionKey(workspaceId, sessionId));
  }

  /** 仅注销工作区 Registry，并从当前页面快照移除其会话；不触碰 Host 文件与 durable state。 */
  async function removeWorkspace(workspaceId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
      if (!response.ok) return false;
      manager.syncWorkspaceSessions(workspaceId, []);
      setWorkspaces(function omitRemovedWorkspace(current) {
        return current.filter(function isNotRemoved(workspace) { return workspace.workspaceId !== workspaceId; });
      });
      return true;
    } catch {
      return false;
    }
  }

  return <SessionTaskContext.Provider value={{ manager, loading, workspaces, directoryPickerAvailable, refreshWorkspaces, refreshSessions, removeSession, removeWorkspace }}>{children}</SessionTaskContext.Provider>;
}

// 下边两个函数Chat 和 Work 共用同一套
// cr by clayw on 20260910

/** 读取当前 `/chat` manager；只能在 Provider 内使用。 */
export function useSessionTaskContext(): SessionTaskContextValue {
  const context = useContext(SessionTaskContext);
  if (!context) throw new Error("SessionTaskProvider 缺失");
  return context;
}

/** 订阅稳定的侧栏会话列表快照。 */
export function useSessionTaskList() {
  const { manager } = useSessionTaskContext();
  return useSyncExternalStore(manager.subscribeList, manager.getListSnapshot, manager.getListSnapshot);
}
