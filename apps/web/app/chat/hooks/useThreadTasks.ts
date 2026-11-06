"use client";
/** 读取真实委派任务的有界安全投影，不按成员Session最新状态推断原任务。 */
import { useEffect, useState } from "react";
import type { ThreadGroupSummary } from "./useThreadGroups";
import type { ChildTaskSummary } from "../components/ChildTaskStrip";

/** 仅当前可见会话读取自己的已授权任务；事件/状态变化刷新，迟到结果按代次丢弃。 */
export function useThreadTasks(input: { workspaceId: string; sessionId: string; groups: readonly ThreadGroupSummary[]; active: boolean; refreshKey: string }) {
  const [items, setItems] = useState<ChildTaskSummary[]>([]);
  const [error, setError] = useState(false);
  useEffect(function loadTaskFacts() {
    let cancelled = false;
    /** 发起会话任务只读请求；隐藏或切换目标不启动执行。 */
    async function read() {
      if (!input.active) return;
      const groups = input.groups.filter(function member(group) { return group.members.some(function current(item) { return item.threadId === input.sessionId; }); });
      try {
        const pages = await Promise.all(groups.map(async function groupTasks(group) {
          const res = await fetch(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/threads/groups/${encodeURIComponent(group.groupId)}/tasks?threadId=${encodeURIComponent(input.sessionId)}`);
          console.log(res);
          if (!res.ok) throw new Error("TASKS_UNAVAILABLE");
          return await res.json() as { items: Array<{ taskId: string; threadId: string; title: string; createdAt: number; deliveryStatus: string; turnStatus?: string }> };
        }));
        const tasks = pages.flatMap(function page(value) { return value.items; }).filter(function active(task) { return !["completed", "failed", "interrupted"].includes(task.turnStatus ?? "") && !["failed", "cancelled"].includes(task.deliveryStatus); }).map(function project(task): ChildTaskSummary {
          const phase = task.turnStatus === "waiting_approval" ? "waiting_approval" : task.turnStatus === "waiting_user_input" ? "waiting_user_input" : task.turnStatus === "running" ? "running" : "starting";
          return { taskId: task.taskId, sessionId: task.threadId, title: task.title, phase, updatedAt: task.createdAt };
        }).sort(function recent(a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 5);
        if (!cancelled) { setItems(tasks); setError(false); }
      } catch { if (!cancelled) { setItems([]); setError(true); } }
    }
    void read();
    return function release() { cancelled = true; };
  }, [input.workspaceId, input.sessionId, input.groups, input.active, input.refreshKey]);
  return { items: input.active ? items : [], error };
}
