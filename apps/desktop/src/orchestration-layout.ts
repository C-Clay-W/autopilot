/** 编排侧栏和终端共用的 Run 布局、可信状态与定位。 */
import { attachManagedSessions, initialManagedLayout, leaves, managedExecutorIcons, removePane, splitPane, type ManagedWorkspaceLayout, type TaskStatus } from "./workspace";
import { pausedApproval, approvalContinuationStatus } from "./orchestration-presentation";
import type { ManagedTerminalActivity } from "./TerminalPane";
import type { OrchestrationRunView } from "./orchestration-contract";

/** 保留已发布版本的 Run 级布局键。 */
export function managedLayoutKey(run: Pick<OrchestrationRunView, "workspaceId" | "id">) {
  return "ap-managed-layout:" + run.workspaceId + ":" + run.id;
}

/** 旧安装或损坏布局从主控位置重新对账。 */
export function loadManagedLayout(run: OrchestrationRunView): ManagedWorkspaceLayout {
  try {
    const raw = localStorage.getItem(managedLayoutKey(run));
    if (raw) {
      const value = JSON.parse(raw) as ManagedWorkspaceLayout;
      if (Array.isArray(value.tabs) && Array.isArray(value.sessions) && Number.isSafeInteger(value.nextNumber)) {
        const main = value.sessions.find(function main(s) { return s.id === "controller" && s.tabId === "controller"; });
        if (main && value.tabs.some(function primary(tab) { return tab.id === main.tabId && (main.closed === true || leaves(tab.layout).includes(main.id)); })) return value;
      }
    }
  } catch { /* 存储不可读时仍从原 Run 找回会话。 */ }
  return initialManagedLayout();
}

/** 只补挂已核对会话，并为新旧执行者随机补齐持久图标，优先避开已用图标。 */
export function reconcileManagedLayout(layout: ManagedWorkspaceLayout, run: OrchestrationRunView, mode: "tab" | "split") {
  let next = attachManagedSessions(layout, run.assignments.flatMap(function confirmed(a) {
    return a.terminalSessionId ? [{ id: a.id, sessionId: a.terminalSessionId }] : [];
  }), mode);
  for (const session of next.sessions) {
    if (session.id === "controller" || session.icon && managedExecutorIcons.includes(session.icon)) continue;
    if (next === layout) next = structuredClone(layout);
    const target = next.sessions.find(function same(item) { return item.id === session.id; })!;
    const unused = managedExecutorIcons.filter(function unused(icon) { return !next.sessions.some(function used(item) { return item.icon === icon; }); });
    const available = unused.length ? unused : managedExecutorIcons.filter(function available(icon) { return !next.sessions.some(function open(item) { return !item.closed && item.icon === icon; }); });
    const choices = available.length ? available : managedExecutorIcons;
    target.icon = choices[Math.floor(Math.random() * choices.length)];
  }
  return next === layout ? next : selectOpenManagedTab(next);
}

/** 标题条只读取本会话的可信活动，等待优先于执行和后台 Job，焦点不参与判断。 */
export function managedTerminalActivity(run: OrchestrationRunView, id: string): ManagedTerminalActivity | undefined {
  const assignment = run.assignments.find(function same(a) { return a.id === id; });
  const inspection = id === "controller" ? run.controllerInspection : assignment?.inspection;
  if (!run.connected) return "unknown";
  if (!inspection && assignment && ["released", "cancelled"].includes(assignment.state)) return undefined;
  const recovery = pausedApproval(run, id === "controller" ? undefined : id);
  if (recovery) return { label: approvalContinuationStatus(recovery) };
  if (inspection?.status === "waiting_approval") return inspection.interaction?.state === "pending" ? "waiting" : "unknown";
  if (inspection?.status === "waiting_user_input") return "answering";
  if (!inspection || !["active", "inactive"].includes(inspection.execution)) return id === "controller" && run.waitingForGoal ? undefined : "unknown";
  if (inspection.execution === "active" || inspection.activeJobs) return "running";
  return undefined;
}

/** 活动页已空时选择仍打开的页，全部关闭时保留历史定位。 */
function selectOpenManagedTab(layout: ManagedWorkspaceLayout) {
  if (!layout.tabs.some(function active(tab) { return tab.id === layout.activeTab && !!tab.layout; })) {
    layout.activeTab = layout.tabs.find(function open(tab) { return !!tab.layout; })?.id ?? "controller";
  }
  return layout;
}

/** 只在宿主确认后调整本地位置，主控和分屏子项保留原编号及身份。 */
export function closeManagedSessions(layout: ManagedWorkspaceLayout, ids: string[]) {
  const next = structuredClone(layout);
  for (const session of next.sessions) if (ids.includes(session.id)) {
    session.closed = true;
    const tab = next.tabs.find(function same(item) { return item.id === session.tabId; });
    if (tab) {
      tab.layout = removePane(tab.layout, session.id);
      if (tab.focused === session.id) tab.focused = leaves(tab.layout)[0] ?? session.id;
    }
  }
  return selectOpenManagedTab(next);
}

/** 显式定位复用原编号和窗格，已关闭的位置按原身份重开。 */
export function locateManagedSession(layout: ManagedWorkspaceLayout, id: string) {
  const next = structuredClone(layout);
  const session = next.sessions.find(function same(item) { return item.id === id; });
  const tab = next.tabs.find(function same(t) { return t.id === session?.tabId; });
  if (!session || !tab) return layout;
  if (session.closed) {
    tab.layout = splitPane(tab.layout, tab.focused, id, "row");
    session.closed = undefined;
  }
  tab.focused = id;
  next.activeTab = tab.id;
  return next;
}

/** 报告摘要优先，首次执行沿用任务短句。 */
export function managedTitle(run: OrchestrationRunView, id: string) {
  const assignment = run.assignments.find(function same(a) { return a.id === id; });
  const text = assignment?.results.at(-1)?.summary || assignment?.content || (id === "controller" ? run.goal || "主控" : "执行者");
  return text.trim().replace(/\s+/gu, " ").slice(0, 38);
}

/** 只使用当前会话的可信执行投影，目录占用单独记为待处理。 */
function managedSessionStatus(run: OrchestrationRunView, session: ManagedWorkspaceLayout["sessions"][number]): { status: TaskStatus; label: string; priority: number } {
  const primary = session.id === "controller";
  const assignment = run.assignments.find(function same(a) { return a.id === session.id && a.terminalSessionId === session.sessionId; });
  const sessionId = primary ? run.controllerId : assignment?.sessionId;
  const pending = run.interactions?.filter(function own(i) { return i.state === "pending" && i.sessionId === sessionId && (i.assignmentId ?? "controller") === session.id; });
  if (!run.connected || (!primary && !assignment)) return { status: "unknown", label: "待核查", priority: 3 };
  if (pending?.some(function approval(i) { return i.kind === "approval"; })) return { status: "waiting", label: "待审批", priority: 6 };
  if (pending?.some(function question(i) { return i.kind === "question"; })) return { status: "answering", label: "待回答", priority: 5 };
  const recovery = pausedApproval(run, primary ? undefined : session.id);
  if (recovery) return { status: recovery.resume?.code ? "recovery_failed" : "recovering", label: approvalContinuationStatus(recovery), priority: 5 };
  const native = primary ? run.controllerStatus : assignment?.native;
  if (native === "running" && (!primary || run.controllerExecution === "active")) return { status: "running", label: "执行中", priority: 4 };
  if (primary ? run.controllerJobs === "active" : assignment?.inspection?.activeJobs) return { status: "running", label: "后台 Job 活动", priority: 4 };
  if (native === "unknown" || (primary && run.controllerExecution !== "inactive")) return { status: "unknown", label: "待核查", priority: 3 };
  if (assignment?.occupied && (assignment.local.phase === "blocked" || assignment.results.at(-1)?.outcome === "blocked")) return { status: "failed", label: "阻塞待处理", priority: 3 };
  if (assignment?.occupied && native !== "idle") return { status: "unknown", label: "占用待处理", priority: 3 };
  if (assignment?.state === "cancelled") return { status: "completed", label: "已结束", priority: 1 };
  if (native === "failed" || native === "interrupted" || native === "limit_reached") return { status: "failed", label: "本轮异常结束", priority: 2 };
  if (native === "completed") return { status: "completed", label: "本轮已结束", priority: 1 };
  return { status: "idle", label: "待命", priority: 0 };
}

/** 分屏显示最高优先级状态，侧栏定位对应窗格，运行计数独立统计。 */
export function managedTabRows(run: OrchestrationRunView, layout: ManagedWorkspaceLayout) {
  return layout.tabs.flatMap(function row(tab) {
    const panes = layout.sessions.filter(function belongs(s) { return s.tabId === tab.id; }).map(function status(session) {
      return { ...managedSessionStatus(run, session), session };
    });
    const ranked = panes.filter(function visible(pane) { return !pane.session.closed || pane.priority >= 3; });
    ranked.sort(function priority(a, b) { return b.priority - a.priority || Number(b.session.id === tab.focused) - Number(a.session.id === tab.focused); });
    const first = ranked[0];
    if (!first) return [];
    return [{ id: tab.id, number: tab.number, title: tab.name ?? managedTitle(run, tab.id), target: first.session.id,
      status: first.status, label: first.label, running: ranked.some(function running(p) { return p.status === "running"; }) }];
  });
}
