"use client";
/**
 * useThreadGroups.ts — 当前工作区的会话协作归属
 *
 * 只读宿主投影：哪个会话属于哪个组、父子关系与启用状态，供 Sidebar 标记和面板复用。
 * 不缓存权限结论；是否可写仍由服务端每次校验。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** 单轮发现最多3次请求，每次最多5秒；退避500/1000ms，总预算最多16.5秒。 */
const GROUP_READ_ATTEMPTS = 3;
const GROUP_READ_TIMEOUT_MS = 5_000;

/** 组成员的只读投影；与服务端 DTO 同形，不含回执或意图。 */
export interface ThreadGroupMemberSummary {
  threadId: string;
  parentThreadId: string | null;
  title?: string;
  roleLabel?: string;
  createdAt: number;
}

/** 组的只读投影；allowedTools 是建组时冻结的授权清单。 */
export interface ThreadGroupSummary {
  groupId: string;
  rootThreadId: string;
  enabled: boolean;
  createdAt: number;
  allowedTools: string[];
  members: ThreadGroupMemberSummary[];
}

/** 单个会话的协作归属；用于侧栏标记与复制链接。 */
export interface ThreadMembershipSummary {
  groupId: string;
  rootThreadId: string;
  enabled: boolean;
  parentThreadId: string | null;
  allowedTools: string[];
}

/** 按工作区读取协作组；Chat 或未选工作区时保持为空，不发出请求。 */
export function useThreadGroups(input: { workspaceId: string; enabled: boolean; refreshKey?: string }) {
  const { workspaceId, enabled, refreshKey } = input;
  const [groups, setGroups] = useState<ThreadGroupSummary[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const requestEpochRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recoverableReadRef = useRef(false);

  /** 读取当前工作区的组列表；失败只提示不可读，不影响会话本身。 */
  const refresh = useCallback(async function refresh() {
    const epoch = ++requestEpochRef.current;
    clearTimeout(requestTimerRef.current);
    requestAbortRef.current?.abort();
    if (!enabled || !workspaceId) {
      setGroups([]);
      setError(undefined);
      recoverableReadRef.current = false;
      return "blocked";
    }
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = setTimeout(function abortSlowRead() { controller.abort(); }, GROUP_READ_TIMEOUT_MS);
    requestTimerRef.current = timeout;
    let response: Response;
    try {
      response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/threads/groups`, { signal: controller.signal });
      console.log(response);
      if (requestEpochRef.current !== epoch) return "stale";
      if (!response.ok) {
        recoverableReadRef.current = response.status >= 500;
        setError("无法读取协作归属");
        return recoverableReadRef.current ? "retryable" : "blocked";
      }
      let payload: { items?: ThreadGroupSummary[] };
      try { payload = await response.json(); }
      catch {
        if (requestEpochRef.current !== epoch) return "stale";
        recoverableReadRef.current = false;
        setError("无法读取协作归属");
        return "blocked";
      }
      if (requestEpochRef.current !== epoch) return "stale";
      if (!payload || !Array.isArray(payload.items)) {
        recoverableReadRef.current = false;
        setError("无法读取协作归属");
        return "blocked";
      }
      setGroups(payload.items);
      setError(undefined);
      recoverableReadRef.current = false;
      return "ready";
    } catch {
      if (requestEpochRef.current !== epoch) return "stale";
      recoverableReadRef.current = true;
      setError("无法读取协作归属");
      return "retryable";
    } finally {
      clearTimeout(timeout);
      if (requestTimerRef.current === timeout) requestTimerRef.current = undefined;
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }, [enabled, workspaceId]);

  /** 冷宿主503/短暂网络失败只用有限预算恢复；成功后沿原SSE，online仅重新武装失败预算。 */
  useEffect(function loadGroups() {
    let disposed = false;
    let reading = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** 同一轮请求串行退避，达到预算或永久错误即停止，不变成目录轮询。 */
    async function readWithBudget(): Promise<void> {
      if (disposed || reading) return;
      reading = true;
      attempts += 1;
      const outcome = await refresh();
      reading = false;
      if (!disposed && outcome === "retryable" && attempts < GROUP_READ_ATTEMPTS) {
        retryTimer = setTimeout(function retryRead() { retryTimer = undefined; void readWithBudget(); }, 500 * 2 ** (attempts - 1));
      }
    }
    /** 只在实际网络恢复且上次为临时错误时重试；不重试鉴权或格式错误。 */
    function onOnline(): void {
      if (!recoverableReadRef.current || disposed || reading) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      void readWithBudget();
    }
    void readWithBudget();
    window.addEventListener("online", onOnline);
    return function cancelGroupDiscovery() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      requestEpochRef.current += 1;
      clearTimeout(requestTimerRef.current);
      requestAbortRef.current?.abort();
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, refreshKey]);

  /** 多组只作来源投影；优先保留真实创建来源，不据单条索引授予权限。 */
  const membershipByThread = useMemo(function indexMembership() {
    const map = new Map<string, ThreadMembershipSummary>();
    for (const group of groups) {
      for (const member of group.members) {
        const prior = map.get(member.threadId);
        if (prior?.parentThreadId || (prior && !member.parentThreadId)) continue;
        map.set(member.threadId, {
          groupId: group.groupId,
          rootThreadId: group.rootThreadId,
          enabled: group.enabled,
          parentThreadId: member.parentThreadId,
          allowedTools: group.allowedTools,
        });
      }
    }
    return map;
  }, [groups]);

  return { groups, membershipByThread, error, refresh };
}
