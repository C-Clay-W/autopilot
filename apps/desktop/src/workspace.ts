// 工作台纯数据与布局运算，持久化只包含界面配置，不包含终端输出或任务历史。
import { defaultUiPreferences, isUiPreferences, type UiPreferences } from "./ui-preferences";
import type { RunConfig } from "@autopilot-agent/core";
export type ApPermissionMode = NonNullable<RunConfig["permissionMode"]>;
export const apPermissionNames: Record<ApPermissionMode, string> = { ask: "询问", auto_approve: "为我审批", full_access: "完全访问" };
/** 权限只接受 Core 现有三档，不接收任意策略。 */
export function isApPermissionMode(value: unknown): value is ApPermissionMode { return typeof value === "string" && Object.hasOwn(apPermissionNames, value); }
export type Layout = { kind: "leaf"; id: string } | { kind: "split"; axis: "row" | "column"; ratio: number; first: Layout; second: Layout };
import type { DesktopSessionStatus } from "@autopilot-agent/adapters";
import type { BrowserSaved } from "./browser-contract";
import { restoreBrowserSaved } from "./browser-history";
import type { DesktopApStatus } from "./ap-status-host";
export type TaskStatus = "unknown" | "idle" | "running" | "waiting" | "answering" | "recovering" | "recovery_failed" | "completed" | "failed" | "interrupted" | "recoverable" | "limited";
export const agentNames = { ap: "Autopilot", claude: "Claude Code", codex: "Codex", opencode: "OpenCode", codebuddy: "CodeBuddy" } as const;
export type AgentType = keyof typeof agentNames;
export const newTerminalNames = { claude: agentNames.claude, codex: agentNames.codex, opencode: agentNames.opencode, codebuddy: agentNames.codebuddy, shell: "空白终端" } as const;
export type NewTerminalType = keyof typeof newTerminalNames;
export type TerminalType = AgentType | "shell";
export interface AgentStatus { taskId?: string; instanceId: string; agent: Exclude<AgentType, "ap">; status: "unknown" | "idle" | "running" | "waiting" | "completed" | "failed" | "interrupted"; exited: boolean; observation: "pending" | "enabled" | "disabled" }
export const agentStatusLabels: Record<AgentStatus["status"], string> = { unknown: "状态待确认", idle: "待命", running: "运行中", waiting: "需要你处理", completed: "本轮结束", failed: "出错", interrupted: "已中断" };
export interface Pane { apPermission?: ApPermissionMode; id: string; number: number; agent?: TerminalType; generation: number; process: "starting" | "shell" | "failed" | "exited"; error?: string; task: TaskStatus; aps?: DesktopApStatus[]; agents?: AgentStatus[]; observation?: string }
export interface DesktopWorkspace { apPermission?: ApPermissionMode; mode?: "parallel" | "orchestration"; id: string; name: string; number: number; directory: string; activeTab: string | null }
export interface Tab { id: string; desktopWorkspaceId: string; agent: AgentType; agentSelected?: boolean; name: string; directory: string | null; panes: Pane[]; layout: Layout | null; focused: string | null; expanded: string | null; nextNumber: number }
export interface Workspace { defaultApPermission: ApPermissionMode; ui: UiPreferences; browser?: BrowserSaved; workspaces: DesktopWorkspace[]; activeWorkspace: string | null; nextWorkspaceNumber: number; defaultAgent: AgentType; newTerminal: NewTerminalType; tabs: Tab[]; activeTab: string | null; revision: number; notice?: string }
export const managedExecutorIcons = ["rocket", "bot", "compass", "feather", "flame", "gem", "leaf", "puzzle", "shield", "zap", "anchor", "bug"] as const;
export type ManagedExecutorIcon = typeof managedExecutorIcons[number];
export interface ManagedWorkspaceLayout {
  activeTab: string;
  nextNumber: number;
  tabs: { id: string; number: number; name?: string; layout: Layout | null; focused: string }[];
  sessions: { id: string; sessionId?: string; tabId: string; number: number; closed?: true; icon?: ManagedExecutorIcon }[];
}

/** Run 布局只登记位置；受管身份和输出仍由宿主核对。 */
export function initialManagedLayout(): ManagedWorkspaceLayout {
  return { activeTab: "controller", nextNumber: 2, tabs: [{ id: "controller", number: 1, layout: { kind: "leaf", id: "controller" }, focused: "controller" }], sessions: [{ id: "controller", tabId: "controller", number: 1 }] };
}

/** 已知 Session 只补挂一次，关闭标记和已有焦点随历史 Run 保留。 */
export function attachManagedSessions(layout: ManagedWorkspaceLayout, sessions: { id: string; sessionId: string }[], mode: "tab" | "split"): ManagedWorkspaceLayout {
  const missing = sessions.filter(function fresh(item) { return !layout.sessions.some(function same(record) { return record.id === item.id; }); });
  if (!missing.length) return layout;
  const next = structuredClone(layout);
  for (const item of missing) {
    const number = next.nextNumber++;
    const current = next.tabs.find(function active(tab) { return tab.id === next.activeTab && !!tab.layout; });
    const tab = mode === "split" ? current : undefined;
    if (tab) {
      tab.layout = splitPane(tab.layout, tab.focused, item.id, "row");
      next.sessions.push({ ...item, tabId: tab.id, number });
    } else {
      next.tabs.push({ id: item.id, number, layout: { kind: "leaf", id: item.id }, focused: item.id });
      next.sessions.push({ ...item, tabId: item.id, number });
    }
  }
  return next;
}
/** 默认空模型只包含导航和创建偏好。 */
export function emptyWorkspace(): Workspace { return { defaultApPermission: "ask", ui: defaultUiPreferences(), workspaces: [], activeWorkspace: null, nextWorkspaceNumber: 1, defaultAgent: "ap", newTerminal: "shell", tabs: [], activeTab: null, revision: 0 }; }
/** 五种固定启动类型同时用于 IPC 与磁盘边界。 */
export function isAgentType(value: unknown): value is AgentType { return typeof value === "string" && Object.hasOwn(agentNames, value); }
/** 新增偏好限定四种智能体与空白终端，不接受任意启动命令。 */
export function isNewTerminalType(value: unknown): value is NewTerminalType { return typeof value === "string" && Object.hasOwn(newTerminalNames, value); }
export type WorkspaceCommand =
  | { type: "apPermissionPreference"; permission: ApPermissionMode }
  | { type: "uiPreference"; ui: UiPreferences }
  | { type: "create"; requestId: string; mode: "x2" | "x4" | "freedom"; apPermission?: ApPermissionMode; directory: string | null; agent: AgentType; agentSelected?: boolean; desktopWorkspaceId: string | null }
  | { type: "workspaceCreate"; requestId: string; apPermission?: ApPermissionMode; directory: string }
  | { type: "workspaceActivate"; desktopWorkspaceId: string }
  | { type: "workspaceRename"; desktopWorkspaceId: string; name: string }
  | { type: "workspaceDelete"; desktopWorkspaceId: string }
  | { type: "preference"; agent: AgentType }
  | { type: "terminalPreference"; terminal: NewTerminalType }
  | { type: "add"; tabId: string; axis: "row" | "column" }
  | { type: "directory"; tabId: string; directory: string }
  | { type: "close"; tabId: string; paneId?: string }
  | { type: "retry"; tabId: string; paneId: string }
  | { type: "activate"; tabId: string; paneId?: string }
  | { type: "expand"; tabId: string; paneId: string | null }
  | { type: "arrange"; tabId: string; axis: "row" | "column" }
  | { type: "ratio"; tabId: string; path: string; ratio: number };

export const taskLabels: Record<TaskStatus, string> = { unknown: "状态待确认", idle: "待命", running: "执行中", waiting: "等待审批", answering: "等待回答", recovering: "决定已保存，等待恢复", recovery_failed: "决定已保存，恢复失败", completed: "任务已完成", failed: "失败", interrupted: "已中断", recoverable: "可恢复中断", limited: "达到上限" };

/** 展示只映射权威维度，断线与部分快照不能变成完成。 */
export function sessionTask(ap: DesktopApStatus, session: DesktopSessionStatus): TaskStatus {
  if (session.freshness !== "fresh" || !["connected", "exited"].includes(ap.connection) || session.execution === "lost" || session.execution === "unconfirmed" || session.interaction === "expired" || session.interaction === "unconfirmed") return "unknown";
  if (session.interaction === "decided") return session.continuation === "failed" ? "recovery_failed" : "recovering";
  if (session.interaction === "pending" && session.waiting === "approval") return "waiting";
  if (session.interaction === "pending" && session.waiting === "user_input") return "answering";
  if (session.execution === "inactive" && session.result) {
    if (session.result === "limit_reached") return "limited";
    if (session.result === "interrupted" && session.recoverable) return "recoverable";
    return session.result;
  }
  if (ap.connection === "exited") return "unknown";
  if (session.execution === "active" && session.status === "running") return "running";
  return !session.turnId && session.status === "idle" ? "idle" : "unknown";
}

/** 同一权威任务全局去重，冲突保守记未知，关联观察不冒充本进程驱动。 */
export function summarizeAp(panes: Pane[]) {
  let connected = 0;
  let uncertain = 0;
  const tasks = new Map<string, TaskStatus>();
  for (const pane of panes) for (const ap of pane.aps ?? []) {
    if (ap.connection === "connected") connected++;
    if (ap.lifecycle === "starting" || !["connected", "exited"].includes(ap.connection) || ap.sessions.some(function unknown(session) { return sessionTask(ap, session) === "unknown"; })) uncertain++;
    for (const session of ap.sessions) {
      if (!session.turnId || session.relation === "relatedObserved") continue;
      const key = JSON.stringify([ap.workspace?.workspaceId, ap.workspace?.stateRootId, session.sessionId, session.turnId]);
      const status = sessionTask(ap, session);
      tasks.set(key, tasks.has(key) && tasks.get(key) !== status ? "unknown" : status);
    }
  }
  const states = [...tasks.values()];
  return { connected, uncertain, unfinished: states.filter(function active(status) { return ["running", "waiting", "answering", "recovering", "recovery_failed"].includes(status); }).length,
    running: states.filter(function running(status) { return status === "running"; }).length, approval: states.filter(function approval(status) { return status === "waiting"; }).length,
    answering: states.filter(function answering(status) { return status === "answering"; }).length, unknown: states.filter(function unknown(status) { return status === "unknown"; }).length,
    unavailable: panes.filter(function unavailable(pane) { return !pane.aps?.length; }).length };
}

/** 根据稳定身份收集叶子，供布局校验与关闭裁剪复用。 */
export function leaves(layout: Layout | null): string[] {
  if (!layout) return [];
  return layout.kind === "leaf" ? [layout.id] : [...leaves(layout.first), ...leaves(layout.second)];
}

/** 仅替换指定叶子，新增默认分割焦点窗格。 */
export function splitPane(layout: Layout | null, target: string | null, id: string, axis: "row" | "column"): Layout {
  if (!layout) return { kind: "leaf", id };
  if (layout.kind === "leaf") return layout.id === target ? { kind: "split", axis, ratio: 0.5, first: layout, second: { kind: "leaf", id } } : layout;
  return { ...layout, first: splitPane(layout.first, target, id, axis), second: splitPane(layout.second, target, id, axis) };
}

/** 关闭目标后折叠空分支，其他叶子与比例保持原值。 */
export function removePane(layout: Layout | null, id: string): Layout | null {
  if (!layout || layout.kind === "leaf") return layout?.id === id ? null : layout;
  const first = removePane(layout.first, id);
  const second = removePane(layout.second, id);
  return first && second ? { ...layout, first, second } : first ?? second;
}

/** 按原顺序平衡排列，重排不改变窗格或进程身份。 */
export function arrange(ids: string[], axis: "row" | "column", grid = true): Layout | null {
  if (!ids.length) return null;
  if (ids.length === 1) return { kind: "leaf", id: ids[0] };
  const middle = Math.ceil(ids.length / 2);
  return { kind: "split", axis, ratio: 0.5, first: arrange(ids.slice(0, middle), grid ? (axis === "row" ? "column" : "row") : axis, grid)!, second: arrange(ids.slice(middle), grid ? (axis === "row" ? "column" : "row") : axis, grid)! };
}

/** 用有限路径定位分隔线，主进程限制比例以保留可操作空间。 */
export function setRatio(layout: Layout | null, path: string, ratio: number): Layout | null {
  if (!layout || layout.kind === "leaf") return layout;
  if (!path) return { ...layout, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
  return path[0] === "0" ? { ...layout, first: setRatio(layout.first, path.slice(1), ratio)! } : { ...layout, second: setRatio(layout.second, path.slice(1), ratio)! };
}

/** 保存布局白名单，任务与进程事实不跨应用重启。 */
export function savedWorkspace(workspace: Workspace): unknown {
  return { version: 2, defaultApPermission: workspace.defaultApPermission, ui: workspace.ui, browser: workspace.browser, workspaces: workspace.workspaces.map(function saveGroup(group) { return { id: group.id, name: group.name, number: group.number, directory: group.directory, apPermission: group.apPermission, mode: group.mode, activeTab: group.activeTab }; }), activeWorkspace: workspace.activeWorkspace, nextWorkspaceNumber: workspace.nextWorkspaceNumber, defaultAgent: workspace.defaultAgent, newTerminal: workspace.newTerminal, tabs: workspace.tabs.map(function saveTab(tab) {
    return { id: tab.id, desktopWorkspaceId: tab.desktopWorkspaceId, agent: tab.agent, agentSelected: tab.agentSelected, name: tab.name, directory: tab.directory, panes: tab.panes.map(function savePane(pane) { return { id: pane.id, number: pane.number, apPermission: pane.apPermission, agent: pane.agent ?? tab.agent }; }), layout: tab.layout, focused: tab.focused, expanded: tab.expanded, nextNumber: tab.nextNumber };
  }) };
}

/** 验证磁盘配置和身份唯一性，损坏配置由调用方保留原件并报告。 */
export function restoreWorkspace(value: unknown): Workspace {
  const state = value as Workspace & { version: number };
  if (state?.version === 1) return { ...emptyWorkspace(), ui: defaultUiPreferences(true) };
  if (!state || state.version !== 2 || !Array.isArray(state.tabs) || !Array.isArray(state.workspaces) || !isAgentType(state.defaultAgent)) throw new Error("DESKTOP_LAYOUT_INVALID");
  if (state.defaultApPermission !== undefined && !isApPermissionMode(state.defaultApPermission)) throw new Error("DESKTOP_LAYOUT_INVALID");
  if (state.newTerminal !== undefined && !isNewTerminalType(state.newTerminal)) throw new Error("DESKTOP_LAYOUT_INVALID");
  if (state.ui !== undefined && !isUiPreferences(state.ui)) throw new Error("DESKTOP_LAYOUT_INVALID");
  const ids = new Set<string>();
  /** 限制身份文本，避免配置文件被当成任意命令参数。 */
  function identity(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id); }
  /** 迭代校验结构和环，不以合法树深度设置产品配额。 */
  function validTree(node: Layout | null): boolean {
    const pending = node ? [node] : [];
    const seen = new Set<Layout>();
    while (pending.length) {
      const item = pending.pop()!;
      if (!item || seen.has(item)) return false;
      seen.add(item);
      if (item.kind === "leaf") { if (!identity(item.id)) return false; continue; }
      if (item.kind !== "split" || !["row", "column"].includes(item.axis) || !Number.isFinite(item.ratio) || item.ratio < 0.15 || item.ratio > 0.85 || !item.first || !item.second) return false;
      pending.push(item.second, item.first);
    }
    return true;
  }
  const workspaces = state.workspaces.map(function restoreGroup(group): DesktopWorkspace {
    if (!group || !identity(group.id) || ids.has(group.id) || typeof group.name !== "string" || !group.name.trim() || group.name.length > 256 || /[\x00-\x1f\x7f]/.test(group.name) || typeof group.directory !== "string" || !group.directory || group.directory.includes("\0") || group.directory.length > 32768 || !Number.isSafeInteger(group.number) || group.number < 1) throw new Error("DESKTOP_LAYOUT_INVALID");
    if (group.apPermission !== undefined && !isApPermissionMode(group.apPermission)) throw new Error("DESKTOP_LAYOUT_INVALID");
    if (group.mode !== undefined && group.mode !== "parallel" && group.mode !== "orchestration") throw new Error("DESKTOP_LAYOUT_INVALID");
    ids.add(group.id);
    return { id: group.id, name: group.name, directory: group.directory, number: group.number, apPermission: group.apPermission, mode: group.mode, activeTab: group.activeTab };
  });
  if (new Set(workspaces.map(function number(group) { return group.number; })).size !== workspaces.length || !Number.isSafeInteger(state.nextWorkspaceNumber) || state.nextWorkspaceNumber <= Math.max(0, ...workspaces.map(function number(group) { return group.number; }))) throw new Error("DESKTOP_LAYOUT_INVALID");
  const tabs = state.tabs.map(function restoreTab(tab): Tab {
    if (!workspaces.some(function belongs(group) { return group.id === tab?.desktopWorkspaceId; }) || !isAgentType(tab.agent)) throw new Error("DESKTOP_LAYOUT_INVALID");
    if (tab.agentSelected !== undefined && typeof tab.agentSelected !== "boolean") throw new Error("DESKTOP_LAYOUT_INVALID");
    if (!tab || !identity(tab.id) || ids.has(tab.id) || typeof tab.name !== "string" || tab.name.length > 256 || (tab.directory !== null && (typeof tab.directory !== "string" || tab.directory.length > 32768 || tab.directory.includes("\0"))) || !Array.isArray(tab.panes) || !validTree(tab.layout)) throw new Error("DESKTOP_LAYOUT_INVALID");
    ids.add(tab.id);
    const numbers = new Set<number>();
    const panes = tab.panes.map(function restorePane(pane): Pane {
      if (!identity(pane.id) || ids.has(pane.id) || !Number.isSafeInteger(pane.number) || pane.number < 1 || numbers.has(pane.number)) throw new Error("DESKTOP_LAYOUT_INVALID");
      if (pane.apPermission !== undefined && !isApPermissionMode(pane.apPermission)) throw new Error("DESKTOP_LAYOUT_INVALID");
      if (pane.agent !== undefined && pane.agent !== "shell" && !isAgentType(pane.agent)) throw new Error("DESKTOP_LAYOUT_INVALID");
      ids.add(pane.id);
      numbers.add(pane.number);
      return { id: pane.id, number: pane.number, apPermission: pane.apPermission ?? "ask", agent: pane.agent ?? tab.agent, generation: 0, process: "starting", task: "unknown" };
    });
    const layoutIds = leaves(tab.layout);
    if (layoutIds.length !== panes.length || new Set(layoutIds).size !== panes.length || panes.some(function missing(pane) { return !layoutIds.includes(pane.id); })) throw new Error("DESKTOP_LAYOUT_INVALID");
    const focused = panes.some(function exists(pane) { return pane.id === tab.focused; }) ? tab.focused : panes[0]?.id ?? null;
    return { id: tab.id, desktopWorkspaceId: tab.desktopWorkspaceId, agent: tab.agent, agentSelected: tab.agentSelected, name: tab.name, directory: tab.directory, panes, layout: tab.layout, focused, expanded: panes.some(function exists(pane) { return pane.id === tab.expanded; }) ? tab.expanded : null, nextNumber: Math.max(Number.isSafeInteger(tab.nextNumber) ? tab.nextNumber : 1, ...panes.map(function next(pane) { return pane.number + 1; })) };
  });
  for (const group of workspaces) if (!tabs.some(function active(tab) { return tab.desktopWorkspaceId === group.id && tab.id === group.activeTab; })) group.activeTab = tabs.find(function first(tab) { return tab.desktopWorkspaceId === group.id; })?.id ?? null;
  const active = workspaces.find(function active(group) { return group.id === state.activeWorkspace; }) ?? workspaces[0];
  return { defaultApPermission: state.defaultApPermission ?? "ask", ui: state.ui ?? defaultUiPreferences(true), browser: restoreBrowserSaved(state.browser), workspaces, activeWorkspace: active?.id ?? null, nextWorkspaceNumber: state.nextWorkspaceNumber, defaultAgent: state.defaultAgent, newTerminal: state.newTerminal ?? "shell", tabs, activeTab: active?.activeTab ?? null, revision: 0 };
}

/** 按模式恢复最近工作区；旧布局的自由 Tab 与已登记 Run 保留各自入口。 */
export function modeWorkspace(workspace: Workspace, mode: "parallel" | "orchestration", remembered: string | null, runWorkspaces: string[]): DesktopWorkspace | undefined {
  const candidates = workspace.workspaces.filter(function belongs(group) {
    return (group.mode ?? "parallel") === mode;
  });
  return candidates.find(function last(group) { return group.id === remembered; }) ?? candidates.find(function active(group) { return group.id === workspace.activeWorkspace; }) ?? candidates[0];
}

/** 旧混合工作区保留 Run 原身份，将自由终端整体移到确定性的新 Parallel 身份；重复执行不再拆分。 */
export function isolateWorkspaceModes(workspace: Workspace, runWorkspaces: string[]): boolean {
  let changed = false;
  for (const group of [...workspace.workspaces]) {
    const hasRun = runWorkspaces.includes(group.id);
    const tabs = workspace.tabs.filter(function belongs(tab) { return tab.desktopWorkspaceId === group.id; });
    if (hasRun && tabs.length) {
      const id = `${group.id.slice(0, 60)}-parallel`;
      if (workspace.workspaces.some(function exists(item) { return item.id === id; })) throw new Error("DESKTOP_MODE_MIGRATION_CONFLICT");
      const number = workspace.nextWorkspaceNumber++;
      workspace.workspaces.push({ ...group, id, number, mode: "parallel", name: `${group.name.slice(0, 240)} · Parallel` });
      for (const tab of tabs) tab.desktopWorkspaceId = id;
      group.activeTab = null;
      if (workspace.activeWorkspace === group.id) workspace.activeWorkspace = id;
      changed = true;
    }
    const mode = hasRun ? "orchestration" : group.mode ?? "parallel";
    if (group.mode !== mode) { group.mode = mode; changed = true; }
  }
  workspace.activeTab = workspace.workspaces.find(function active(group) { return group.id === workspace.activeWorkspace; })?.activeTab ?? null;
  return changed;
}
