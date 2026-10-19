/**
 * session-task-store.ts — Chat 根布局内按 Session 隔离的纯内存状态。
 *
 * 本模块只保存 Web 当前页面生命周期的不可变快照和一次性终态提醒；
 * Core Runtime 仍是 Session、Turn 和持久终态的唯一事实源。
 */

import type { SessionStatus } from "@autopilot-agent/core";
import type { WebSessionDto } from "@/lib/runtime-host/web-ui-dto";

/** Session 在 Web 控制层可见的执行阶段。 */
export type SessionTaskPhase = "idle" | "starting" | "running" | "waiting_approval" | "waiting_user_input" | "interrupted" | "limit_reached" | "failed" | "completed";

/** 只在当前页面生命周期内存在的终态提醒。 */
export type SessionTaskTerminalNotice = "success" | "failure" | null;

/** 精确 Runtime 终态事件；Session.status 不能代替该事件。 */
export type SessionTaskTerminalEvent = "turn_completed" | "turn_failed";

/** 供聊天页订阅的单个 Session 不可变快照。 */
export interface SessionTaskSnapshot {
  session: WebSessionDto;
  phase: SessionTaskPhase;
  activeTurnId?: string;
  terminalNotice: SessionTaskTerminalNotice;
}

/** 供侧栏订阅的轻量 Session 状态摘要。 */
export interface SessionTaskListItem {
  workspaceId: string;
  key: string;
  id: string;
  session: WebSessionDto;
  phase: SessionTaskPhase;
  terminalNotice: SessionTaskTerminalNotice;
}

/** 外部 store 订阅者。 */
export type SessionTaskListener = () => void;

/** 单个 Session store 的最小访问接口。 */
export interface SessionTaskStore {
  getSnapshot(): SessionTaskSnapshot;
  subscribe(listener: SessionTaskListener): () => void;
  replace(snapshot: SessionTaskSnapshot): boolean;
}

/** Chat 根布局使用的 Session store manager 接口。 */
export interface SessionTaskManager {
  getListSnapshot(): readonly SessionTaskListItem[];
  subscribeList(listener: SessionTaskListener): () => void;
  getSessionSnapshot(sessionId: string): SessionTaskSnapshot | null;
  subscribeSession(sessionId: string, listener: SessionTaskListener): () => void;
  getVisitedSessionIds(): readonly string[];
  syncWorkspaceSessions(workspaceId: string, sessions: readonly WebSessionDto[]): void;
  selectSession(sessionKey: string | null): void;
  beginSession(sessionKey: string, activeTurnId?: string): void;
  updateRuntimeState(sessionKey: string, runtimeStatus: SessionStatus, activeTurnId?: string): void;
  markLimitReached(sessionKey: string): void;
  applyTerminalEvent(sessionKey: string, event: SessionTaskTerminalEvent): void;
  removeSession(sessionKey: string): void;
}

/** 用不可出现在 opaque ID 中的分隔符生成工作区内会话的内存键。 */
export function createWorkspaceSessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/** 从复合内存键拆出 URL 使用的工作区与会话标识。 */
export function parseWorkspaceSessionKey(sessionKey: string): { workspaceId: string; sessionId: string } | null {
  const separator = sessionKey.indexOf("\u0000");
  if (separator <= 0 || separator === sessionKey.length - 1) return null;
  return { workspaceId: sessionKey.slice(0, separator), sessionId: sessionKey.slice(separator + 1) };
}

/** 创建受保护的 Web Session DTO 副本，防止外部调用方修改快照。 */
function copySession(session: WebSessionDto): WebSessionDto {
  return {
    ...session,
    pinnedSkills: session.pinnedSkills?.map(function copyPinnedSkill(skill) {
      return { ...skill };
    }),
  };
}

/** 判断两份 Web Session DTO 是否代表相同安全投影。 */
function areSessionsEqual(left: WebSessionDto, right: WebSessionDto): boolean {
  if (
    left.productMode !== right.productMode
    || left.chatRetrievalMode !== right.chatRetrievalMode
    || left.id !== right.id
    || left.title !== right.title
    || left.createdAt !== right.createdAt
    || left.updatedAt !== right.updatedAt
    || left.status !== right.status
    || left.runtimeStatus !== right.runtimeStatus
    || left.activeTurnId !== right.activeTurnId
  ) {
    return false;
  }

  const leftSkills = left.pinnedSkills ?? [];
  const rightSkills = right.pinnedSkills ?? [];
  if (leftSkills.length !== rightSkills.length) return false;
  return leftSkills.every(function isEqualPinnedSkill(skill, index) {
    const other = rightSkills[index];
    return skill.skillRef === other.skillRef
      && skill.skillId === other.skillId
      && skill.contentHash === other.contentHash
      && skill.pinnedAt === other.pinnedAt;
  });
}

/** 将 Core Runtime 状态投影为 Web 控制层阶段，不重算任何 Core 事实。 */
function toSessionTaskPhase(status: SessionStatus): SessionTaskPhase {
  return status;
}

/** 比较快照，确保无语义变化时保留原引用。 */
function areSnapshotsEqual(left: SessionTaskSnapshot, right: SessionTaskSnapshot): boolean {
  return left.phase === right.phase
    && left.activeTurnId === right.activeTurnId
    && left.terminalNotice === right.terminalNotice
    && areSessionsEqual(left.session, right.session);
}

/** 创建单个 Session 的可订阅不可变 store。 */
export function createSessionTaskStore(session: WebSessionDto): SessionTaskStore {
  let snapshot: SessionTaskSnapshot = {
    session: copySession(session),
    phase: toSessionTaskPhase(session.runtimeStatus),
    activeTurnId: session.activeTurnId,
    terminalNotice: null,
  };
  const listeners = new Set<SessionTaskListener>();

  /** 返回当前稳定快照引用。 */
  function getSnapshot(): SessionTaskSnapshot {
    return snapshot;
  }

  /** 订阅本 Session 的快照变化。 */
  function subscribe(listener: SessionTaskListener): () => void {
    listeners.add(listener);
    return function unsubscribe(): void {
      listeners.delete(listener);
    };
  }

  /** 只有快照发生语义变化时才替换并通知订阅者。 */
  function replace(nextSnapshot: SessionTaskSnapshot): boolean {
    if (areSnapshotsEqual(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    listeners.forEach(function notifyListener(listener) {
      listener();
    });
    return true;
  }

  return { getSnapshot, subscribe, replace };
}

/** 创建只在当前 `/chat` 根布局生命周期内存在的 Session manager。 */
export function createSessionTaskManager(): SessionTaskManager {
  const stores = new Map<string, SessionTaskStore>();
  const listListeners = new Set<SessionTaskListener>();
  const visitedSessionIds = new Set<string>();
  let selectedSessionId: string | null = null;
  let listSnapshot: readonly SessionTaskListItem[] = [];

  /** 重新构造侧栏快照；未变化时保留现有数组引用。 */
  function rebuildListSnapshot(): void {
    const nextSnapshot = Array.from(stores.values(), function toListItem(store) {
      const snapshot = store.getSnapshot();
      const key = Array.from(stores.entries()).find(function findStore(entry) { return entry[1] === store; })?.[0] ?? "";
      const identity = parseWorkspaceSessionKey(key);
      return {
        workspaceId: identity?.workspaceId ?? "",
        key,
        id: snapshot.session.id,
        session: snapshot.session,
        phase: snapshot.phase,
        terminalNotice: snapshot.terminalNotice,
      };
    }).sort(function sortByUpdatedAt(left, right) {
      return right.session.updatedAt - left.session.updatedAt;
    });

    const isUnchanged = nextSnapshot.length === listSnapshot.length
      && nextSnapshot.every(function isSameListItem(item, index) {
        const current = listSnapshot[index];
        return current.key === item.key && current.id === item.id
          && current.session === item.session
          && current.phase === item.phase
          && current.terminalNotice === item.terminalNotice;
      });
    if (isUnchanged) return;

    listSnapshot = nextSnapshot;
    listListeners.forEach(function notifyListListener(listener) {
      listener();
    });
  }

  /** 获取已存在的目标 store；不存在时不创建伪造会话。 */
  function getStore(sessionId: string): SessionTaskStore | null {
    return stores.get(sessionId) ?? null;
  }

  /** 以单 Session 的目标快照更新 store，并同步侧栏摘要。 */
  function replaceSessionSnapshot(sessionId: string, createNext: (snapshot: SessionTaskSnapshot) => SessionTaskSnapshot): void {
    const store = getStore(sessionId);
    if (!store) return;
    if (store.replace(createNext(store.getSnapshot()))) rebuildListSnapshot();
  }

  /** 返回当前稳定的侧栏状态摘要。 */
  function getListSnapshot(): readonly SessionTaskListItem[] {
    return listSnapshot;
  }

  /** 订阅侧栏状态摘要变化。 */
  function subscribeList(listener: SessionTaskListener): () => void {
    listListeners.add(listener);
    return function unsubscribe(): void {
      listListeners.delete(listener);
    };
  }

  /** 返回单个 Session 的稳定快照，不存在时返回 null。 */
  function getSessionSnapshot(sessionId: string): SessionTaskSnapshot | null {
    return getStore(sessionId)?.getSnapshot() ?? null;
  }

  /** 仅订阅目标 Session，避免 A 的更新通知 B 的聊天正文。 */
  function subscribeSession(sessionId: string, listener: SessionTaskListener): () => void {
    return getStore(sessionId)?.subscribe(listener) ?? function unsubscribeMissingSession(): void {};
  }

  /** 返回当前页面生命周期内已访问且仍存在的 Session 标识。 */
  function getVisitedSessionIds(): readonly string[] {
    return Array.from(visitedSessionIds);
  }

  /** 用工作区受限 Session API 校准该工作区 store，并保留其他工作区的运行状态。 */
  function syncWorkspaceSessions(workspaceId: string, sessions: readonly WebSessionDto[]): void {
    const incoming = new Map(sessions.map(function indexSession(session) {
      return [createWorkspaceSessionKey(workspaceId, session.id), session] as const;
    }));
    let listChanged = false;

    stores.forEach(function removeMissingStore(_store, sessionKey) {
      const identity = parseWorkspaceSessionKey(sessionKey);
      if (!identity || identity.workspaceId !== workspaceId || incoming.has(sessionKey)) return;
      stores.delete(sessionKey);
      visitedSessionIds.delete(sessionKey);
      if (selectedSessionId === sessionKey) selectedSessionId = null;
      listChanged = true;
    });

    incoming.forEach(function upsertStore(session, sessionKey) {
      const store = getStore(sessionKey);
      if (!store) {
        stores.set(sessionKey, createSessionTaskStore(session));
        listChanged = true;
        return;
      }
      const current = store.getSnapshot();
      const next: SessionTaskSnapshot = {
        session: copySession(session),
        phase: toSessionTaskPhase(session.runtimeStatus),
        activeTurnId: session.activeTurnId,
        terminalNotice: current.terminalNotice,
      };
      if (store.replace(next)) listChanged = true;
    });

    if (listChanged) rebuildListSnapshot();
  }

  /** 选择会话并清除其只读一次的后台终态提醒。 */
  function selectSession(sessionId: string | null): void {
    selectedSessionId = sessionId;
    if (!sessionId) return;
    visitedSessionIds.add(sessionId);
    replaceSessionSnapshot(sessionId, function clearTerminalNotice(snapshot) {
      return { ...snapshot, terminalNotice: null };
    });
  }

  /** 开始或重跑目标 Session 时清除旧提醒并进入 starting 阶段。 */
  function beginSession(sessionId: string, activeTurnId?: string): void {
    replaceSessionSnapshot(sessionId, function beginSnapshot(snapshot) {
      return {
        ...snapshot,
        session: { ...snapshot.session, runtimeStatus: "running", activeTurnId },
        phase: "starting",
        activeTurnId,
        terminalNotice: null,
      };
    });
  }

  /** 写入来自 Core 的安全运行状态投影，绝不由 Web 预测终态。 */
  function updateRuntimeState(sessionId: string, runtimeStatus: SessionStatus, activeTurnId?: string): void {
    replaceSessionSnapshot(sessionId, function updateSnapshot(snapshot) {
      return {
        ...snapshot,
        session: { ...snapshot.session, runtimeStatus, activeTurnId },
        phase: toSessionTaskPhase(runtimeStatus),
        activeTurnId,
      };
    });
  }

  /** 记录精确 limit 事件，避免被 Core 的 completed 投影误报为成功。 */
  function markLimitReached(sessionId: string): void {
    replaceSessionSnapshot(sessionId, function markLimitSnapshot(snapshot) {
      return {
        ...snapshot,
        session: { ...snapshot.session, runtimeStatus: "completed", activeTurnId: undefined },
        phase: "limit_reached",
        activeTurnId: undefined,
      };
    });
  }

  /** 只在收到精确终态事件且会话未查看时武装一次性提醒。 */
  function applyTerminalEvent(sessionId: string, event: SessionTaskTerminalEvent): void {
    replaceSessionSnapshot(sessionId, function applyTerminalSnapshot(snapshot) {
      const terminalNotice = selectedSessionId === sessionId
        ? null
        : event === "turn_completed" ? "success" : "failure";
      return { ...snapshot, terminalNotice };
    });
  }

  /** 删除目标 Session 的内存 store，避免后续状态误写入已删除会话。 */
  function removeSession(sessionId: string): void {
    if (!stores.delete(sessionId)) return;
    visitedSessionIds.delete(sessionId);
    if (selectedSessionId === sessionId) selectedSessionId = null;
    rebuildListSnapshot();
  }

  return {
    getListSnapshot,
    subscribeList,
    getSessionSnapshot,
    subscribeSession,
    getVisitedSessionIds,
    syncWorkspaceSessions,
    selectSession,
    beginSession,
    updateRuntimeState,
    markLimitReached,
    applyTerminalEvent,
    removeSession,
  };
}
