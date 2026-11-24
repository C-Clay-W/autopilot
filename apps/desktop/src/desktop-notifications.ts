// Desktop 临时通知按到达顺序集中保存，审批与普通提示共享同一显示队列。
import { clearNotificationTimer } from "./notification-timers";
import type { UiPreferences } from "./ui-preferences";
import type { ReactNode } from "react";
import { agentNames, agentStatusLabels, sessionTask, taskLabels, type TaskStatus, type Workspace } from "./workspace";

export interface TaskSource { workspaceId: string; tabId: string; paneId: string; taskId: string }
export interface DesktopNotification {
  id: string;
  group: "notification" | "confirmation";
  lifecycle: "timed" | "user";
  source?: TaskSource;
  title: string;
  message?: string;
  tone?: "info" | "success" | "error";
  content?: ReactNode;
  onDismiss?: () => void;
  busy?: boolean;
}

let notifications: DesktopNotification[] = [];
const listeners = new Set<() => void>();

/** 更新已有审批保留原位置，新通知追加在队尾。 */
export function putNotification(notification: DesktopNotification): void {
  if (notification.lifecycle === "user") clearNotificationTimer(notification.id);
  const index = notifications.findIndex(function same(item) { return item.id === notification.id; });
  notifications = index < 0 ? [...notifications, notification] : notifications.map(function update(item, position) { return position === index ? notification : item; });
  for (const listener of listeners) listener();
}

/** 关闭只移除指定通知，不丢弃其他待审批请求。 */
export function removeNotification(id: string): void {
  clearNotificationTimer(id);
  notifications = notifications.filter(function keep(item) { return item.id !== id; });
  for (const listener of listeners) listener();
}

/** 普通提示使用独立身份，后续同类事件仍可再次通知。 */
export function notifyDesktop(title: string, message: string, tone: DesktopNotification["tone"] = "info"): void {
  putNotification({ id: crypto.randomUUID(), group: "notification", lifecycle: "timed", title, message, tone });
}

/** 外壳订阅只读队列，业务组件无需持有全局页面状态。 */
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return function unsubscribe() { listeners.delete(listener); };
}

/** 快照保持引用稳定，只有实际写入才通知 React。 */
export function notificationSnapshot(): DesktopNotification[] { return notifications; }

/** 只投影已有权威状态，AP 关联观察会话与未启用第三方观察不产生任务通知。 */
function taskStates(workspace: Workspace): Map<string, { status: TaskStatus; label: string; title?: string; source?: TaskSource; selected?: boolean }> {
  const states = new Map<string, { status: TaskStatus; label: string; title?: string; source?: TaskSource; selected?: boolean }>();
  for (const tab of workspace.tabs) for (const pane of tab.panes) {
    const label = `${tab.name} · 终端 ${pane.number}`;
    for (const ap of pane.aps ?? []) for (const session of ap.sessions) {
      if (!session.turnId || session.relation === "relatedObserved") continue;
      const key = JSON.stringify([ap.workspace?.workspaceId, ap.workspace?.stateRootId, session.sessionId, session.turnId]);
      const status = sessionTask(ap, session);
      const existing = states.get(key);
      states.set(key, { status: existing && existing.status !== status ? "unknown" : status, label, source: ap.workspace ? { workspaceId: tab.desktopWorkspaceId, tabId: tab.id, paneId: pane.id, taskId: key } : undefined, selected: session.selected });
    }
    for (const agent of pane.agents ?? []) if (agent.observation === "enabled") { const key = agent.taskId ?? agent.instanceId; states.set(key, { status: agent.status, label: `${label} · ${agentNames[agent.agent]}`, title: agentStatusLabels[agent.status], source: agent.taskId ? { workspaceId: tab.desktopWorkspaceId, tabId: tab.id, paneId: pane.id, taskId: key } : undefined, selected: true }); }
  }
  return states;
}

/** 首次载入静默建立基线，仅已观察到活动的任务转为终态时通知。 */
export function taskNotifications(previous: Workspace | undefined, next: Workspace): Omit<DesktopNotification, "id">[] {
  if (!previous) return [];
  const before = taskStates(previous);
  const result: Omit<DesktopNotification, "id">[] = [];
  for (const [id, task] of taskStates(next)) {
    const old = before.get(id)?.status;
    if (!old || !["running", "waiting", "answering", "recovering"].includes(old)) continue;
    if (["completed", "failed", "recovery_failed", "interrupted", "recoverable", "limited"].includes(task.status)) result.push({ group: "notification", lifecycle: "timed", source: task.source, title: task.title ?? taskLabels[task.status], message: task.label, tone: task.status === "completed" ? "success" : ["failed", "recovery_failed"].includes(task.status) ? "error" : "info" });
  }
  return result;
}

/** 只有实际焦点所在窗格且唯一可确认选中任务，才提供免打扰身份。 */
export function focusedTaskSource(workspace: Workspace, paneId: string | undefined): TaskSource | undefined {
  const tab = workspace.tabs.find(function active(tab) { return tab.id === workspace.activeTab && tab.desktopWorkspaceId === workspace.activeWorkspace; });
  if (!paneId || tab?.focused !== paneId) return;
  const tasks = [...taskStates(workspace).values()].filter(function selected(task) { return task.selected && task.source?.paneId === paneId && task.source.tabId === tab.id; });
  return tasks.length === 1 ? tasks[0].source : undefined;
}
/** 只抑制前台实际聚焦的普通任务提示；未知身份、即时反馈和用户处理卡均保留。 */
export function suppressTaskNotification(item: Pick<DesktopNotification, "source" | "lifecycle">, ui: UiPreferences, foreground: boolean, focused?: TaskSource): boolean {
  return ui.doNotDisturb && foreground && item.lifecycle === "timed" && !!item.source && !!focused && item.source.workspaceId === focused.workspaceId && item.source.tabId === focused.tabId && item.source.paneId === focused.paneId && item.source.taskId === focused.taskId;
}
