/**
 * session-task-context.tsx — `/chat` 根布局持有的 SessionTaskManager React 接线。
 *
 * Context 只暴露当前页面的会话列表和 manager；持久 Session/Turn 事实仍通过 API/Core 获取。
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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

/** 协作事件观察流状态：idle 未观察，live 已连通，reconnecting 断线重连中。 */
export type ThreadEventsState = "idle" | "live" | "reconnecting";

/** 需要重新校准侧栏的协作事件类型；共享板等无关事件不触发整表刷新。 */
const SIDEBAR_THREAD_EVENT_KINDS: ReadonlySet<string> = new Set([
  "member_created",
  "group_enabled",
  "group_disabled",
  "message_delivered",
  "turn_terminal",
]);

/** 协作事件触发的会话与归属校准合并窗口；同一窗口内的多个事件只刷新一次。 */
const THREAD_EVENT_REFRESH_DEBOUNCE_MS = 300;

interface SessionTaskContextValue {
  manager: SessionTaskManager;
  loading: boolean;
  workspaces: readonly WorkspaceSummary[];
  directoryPickerAvailable: boolean;
  refreshWorkspaces(): Promise<readonly WorkspaceSummary[]>;
  refreshSessions(workspaceId?: string): Promise<void>;
  removeSession(workspaceId: string, sessionId: string): void;
  removeWorkspace(workspaceId: string): Promise<boolean>;
  /** 声明当前需要观察的协作组；传空值取消观察，由 Provider 统一持有事件流。 */
  observeThreadGroup(workspaceId: string | null, groupId: string | null): void;
  /** 协作归属代次；事件到达后递增，供归属读取方重新校准。 */
  threadGroupRevision: number;
  /** create_thread成功后按workspace定向失效；不从工具output或正文推导目标。 */
  invalidateThreadDirectory(workspaceId: string, sessionId: string, turnId: string, seq: number): void;
  threadDirectoryRevisions: Readonly<Record<string, number>>;
  /** 协作事件观察流状态；reconnecting 表示断线重连中。 */
  threadEventsState: ThreadEventsState;
}

const SessionTaskContext = createContext<SessionTaskContextValue | null>(null);

/** 窗口恢复校准的最小间隔；间隔内连发的 focus/visibilitychange 事件只保留一次校准（P17 问题3）。 */
const RESTORE_REFRESH_MIN_INTERVAL_MS = 10_000;

/** 判断两份工作区快照内容是否一致；一致时保留旧引用，避免 registry effect 因引用变化重复全量刷新。 */
function sameWorkspaceList(current: readonly WorkspaceSummary[], next: readonly WorkspaceSummary[]): boolean {
  return current.length === next.length && current.every(function sameWorkspace(workspace, index) {
    const other = next[index];
    return workspace.workspaceId === other.workspaceId
      && workspace.displayName === other.displayName
      && workspace.lastOpenedAt === other.lastOpenedAt
      && workspace.available === other.available
      && workspace.trustStatus === other.trustStatus;
  });
}

/** 创建跨 query 导航常驻的 Session manager Provider。 */
export function SessionTaskProvider({ children }: { children: ReactNode }) {
  const [manager] = useState<SessionTaskManager>(createSessionTaskManager);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [directoryPickerAvailable, setDirectoryPickerAvailable] = useState(false);
  /** 工作区快照的同步引用；refreshSessions 调用时读取最新列表，避免闭包持有过期 registry。 */
  const workspacesRef = useRef<readonly WorkspaceSummary[]>([]);
  /** 工作区内容代次；内容真实变化时递增，作为同 scope 刷新请求的合并版本键。 */
  const workspacesSerialRef = useRef(0);
  /** 在途 refreshSessions Promise，按 `${scope}#${serial}` 键控；同代次同 scope 复用，全量覆盖同代次所有 scope。 */
  const sessionsRefreshInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  /** 上次窗口恢复校准时间；用于合并 focus 与 visibilitychange 的连发事件。 */
  const lastRestoreRefreshAtRef = useRef(0);
  /** 当前要观察的协作组；由当前会话归属决定，避免为空闲会话长期占用连接。 */
  const [threadWatch, setThreadWatch] = useState<{ workspaceId: string; groupId: string } | null>(null);
  /** 协作归属代次；事件到达时递增，驱动归属读取方重新校准。 */
  const [threadGroupRevision, setThreadGroupRevision] = useState(0);
  const [threadEventsState, setThreadEventsState] = useState<ThreadEventsState>("idle");
  const [threadDirectoryRevisions, setThreadDirectoryRevisions] = useState<Record<string, number>>({});
  const createdEventsRef = useRef(new Set<string>());
  const directoryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** sessions可读代表该workspace宿主已初始化；首次可读仅发一次发现信号，不随每次刷新重置退避。 */
  const readableWorkspacesRef = useRef(new Set<string>());

  /** 记录当前需要观察的协作组；值未变化时保留原引用，避免重建事件流。 */
  const observeThreadGroup = useCallback(function observeThreadGroup(workspaceId: string | null, groupId: string | null): void {
    setThreadWatch(function nextWatch(current) {
      if (!workspaceId || !groupId) return current === null ? current : null;
      if (current?.workspaceId === workspaceId && current.groupId === groupId) return current;
      return { workspaceId, groupId };
    });
  }, []);

  /** 从安全工作区 API 读取可选择的本机工作区，不请求能力或路径信息。 */
  const refreshWorkspaces = useCallback(async function refreshWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    try {
      const response = await fetch("/api/workspaces");
      if (!response.ok) return [];
      const payload = await response.json() as { workspaces?: WorkspaceSummary[]; directoryPickerAvailable?: boolean };
      const next = payload.workspaces ?? [];
      // 内容未变时保留旧引用：registry effect 以 workspaces 引用为依赖，保留引用可阻断重复全量刷新（P17 问题3）。
      if (!sameWorkspaceList(workspacesRef.current, next)) {
        workspacesSerialRef.current += 1;
        workspacesRef.current = next;
        setWorkspaces(next);
      }
      setDirectoryPickerAvailable(payload.directoryPickerAvailable === true);
      return next;
    } catch {
      return [];
    }
  }, []);

  /** 从指定工作区的安全会话 API 校准 manager，不读取 checkpoint 或 Provider 信息。 */
  const refreshSessions = useCallback(async function refreshSessions(workspaceId?: string): Promise<void> {
    // 同代次同 scope 复用在途 Promise；全量刷新覆盖同代次所有 scope，避免事件回调与 registry effect 重复扇出（P17 问题3）。
    const serial = workspacesSerialRef.current;
    const fullKey = `*#${serial}`;
    const scopeKey = workspaceId ?? fullKey;
    const inFlight = sessionsRefreshInFlightRef.current;
    const reusable = inFlight.get(scopeKey) ?? (workspaceId ? inFlight.get(fullKey) : undefined);
    if (reusable) return reusable;
    const run = (async function runRefreshSessions(): Promise<void> {
      try {
        const workspaces = workspacesRef.current;
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
          if (!readableWorkspacesRef.current.has(workspace.workspaceId)) {
            readableWorkspacesRef.current.add(workspace.workspaceId);
            setThreadDirectoryRevisions(function hostBecameReadable(current) { return current[workspace.workspaceId] === undefined ? { ...current, [workspace.workspaceId]: 1 } : current; });
          }
        }));
      } catch {
        /* 网络短暂不可用时保留最后一个安全快照，避免页面恢复产生未处理 Promise。 */
      } finally {
        setLoading(false);
        inFlight.delete(scopeKey);
      }
    })();
    inFlight.set(scopeKey, run);
    return run;
  }, [manager]);

  /** 安全成功事件按真实源身份去重，合并同workspace创建；沿既有目录请求合并，不抢选择焦点。 */
  const invalidateThreadDirectory = useCallback(function invalidateThreadDirectory(workspaceId: string, sessionId: string, turnId: string, seq: number): void {
    if (!workspaceId || workspaceId === CHAT_SCOPE || !sessionId || !turnId || !Number.isSafeInteger(seq) || seq < 1) return;
    const key = JSON.stringify([workspaceId, sessionId, turnId, seq]);
    if (createdEventsRef.current.has(key)) return;
    createdEventsRef.current.add(key);
    const timers = directoryTimersRef.current;
    if (timers.has(workspaceId)) return;
    timers.set(workspaceId, setTimeout(function resyncCreatedThread() {
      timers.delete(workspaceId);
      void refreshSessions(workspaceId);
      setThreadDirectoryRevisions(function bump(current) { return { ...current, [workspaceId]: (current[workspaceId] ?? 0) + 1 }; });
    }, THREAD_EVENT_REFRESH_DEBOUNCE_MS));
  }, [refreshSessions]);

  /** Provider卸载时只清本页创建事件安排的校准，不留下额外轮询。 */
  useEffect(function cleanDirectoryRefreshTimers() {
    const timers = directoryTimersRef.current;
    return function cleanup() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  }, []);

  /**
   * 观察当前协作组的事件流，用组事件驱动侧栏会话列表与归属校准。
   * 只按事件类型触发受限快照刷新，不把子会话输出写进父会话，也不额外轮询。
   */
  useEffect(function observeThreadGroupEvents() {
    if (!threadWatch) return;
    const { workspaceId, groupId } = threadWatch;
    // 原生 EventSource 会携带 Last-Event-ID 自动重连，正好复用既有事件游标协议。
    const source = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/threads/groups/${encodeURIComponent(groupId)}/events`);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    /** 合并短时间内的多个协作事件，只触发一次会话列表与归属校准。 */
    function scheduleResync(): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function runResync() {
        debounceTimer = undefined;
        if (disposed) return;
        void refreshSessions(workspaceId);
        setThreadGroupRevision(function bumpRevision(revision) { return revision + 1; });
      }, THREAD_EVENT_REFRESH_DEBOUNCE_MS);
    }

    /** 只在事件涉及会话创建、投递或终态时校准，共享板更新不牵动侧栏。 */
    function handlePage(event: Event): void {
      setThreadEventsState("live");
      let items: Array<{ kind?: string; threadId?: string; turnId?: string }>;
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { items?: Array<{ kind?: string; threadId?: string; turnId?: string }> };
        items = Array.isArray(payload.items) ? payload.items : [];
      } catch {
        // 损坏分片不触发刷新；下一次事件仍按游标到达。
        return;
      }
      // 终态事件先按 workspace/session/turn 身份清理陈旧执行态，未访问子会话不必等下一次快照才停止转圈。
      items.forEach(function settleTerminalTurn(item) {
        if (item.kind !== "turn_terminal" || !item.threadId || !item.turnId) return;
        manager.applyThreadTurnTerminal(workspaceId, item.threadId, item.turnId);
      });
      const affectsSidebar = items.some(function isSidebarEvent(item) {
        return typeof item.kind === "string" && SIDEBAR_THREAD_EVENT_KINDS.has(item.kind);
      });
      if (!affectsSidebar) return;
      scheduleResync();
    }

    /** 每次连通（含自动重连）都做一次校准，补齐断线期间发生的创建与终态。 */
    function handleOpen(): void {
      setThreadEventsState("live");
      scheduleResync();
    }

    /** 断线只更新可见状态，重连与游标续读交给浏览器。 */
    function handleError(): void {
      if (disposed) return;
      setThreadEventsState("reconnecting");
    }

    source.addEventListener("page", handlePage);
    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);
    return function closeThreadEventStream(): void {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      source.close();
    };
  }, [threadWatch, refreshSessions, manager]);

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
      // focus 与 visibilitychange 在窗口恢复时连发；最小间隔内的重复事件只保留一次校准（P17 问题3）。
      const now = Date.now();
      if (now - lastRestoreRefreshAtRef.current < RESTORE_REFRESH_MIN_INTERVAL_MS) return;
      lastRestoreRefreshAtRef.current = now;
      if (workspacesRef.current.length) void refreshWorkspaces();
      void refreshSessions();
    }

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return function removeWindowRestoreListeners(): void {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshSessions, refreshWorkspaces]);

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
      // 注销属于 registry 真实变化：递增代次并同步引用，保持 ref 与 state 一致（P17 问题3）。
      workspacesSerialRef.current += 1;
      workspacesRef.current = workspacesRef.current.filter(function isNotRemoved(workspace) { return workspace.workspaceId !== workspaceId; });
      setWorkspaces(workspacesRef.current);
      return true;
    } catch {
      return false;
    }
  }

  // 取消观察后立即回到 idle，避免断线提示残留在没有协作组的会话上。
  const effectiveThreadEventsState: ThreadEventsState = threadWatch ? threadEventsState : "idle";

  return <SessionTaskContext.Provider value={{ manager, loading, workspaces, directoryPickerAvailable, refreshWorkspaces, refreshSessions, removeSession, removeWorkspace, observeThreadGroup, threadGroupRevision, invalidateThreadDirectory, threadDirectoryRevisions, threadEventsState: effectiveThreadEventsState }}>{children}</SessionTaskContext.Provider>;
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
