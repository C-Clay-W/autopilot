// Parallel 页面共用创建草稿；所有 Tab 的终端保持挂载，导航不触发宿主创建。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type { AgentInstallation, AgentInstallations, DesktopBridge } from "./contract";
import { apPermissionNames, type ApPermissionMode, modeWorkspace, agentNames, newTerminalNames, agentStatusLabels, sessionTask, summarizeAp, taskLabels, type AgentType, type NewTerminalType, type Pane, type Tab, type TaskStatus, type Workspace, type WorkspaceCommand } from "./workspace";
import { AgentLogo } from "./AgentLogo";
import { Input } from "./components/ui/input";
import { ContextMenu } from "./components/ui/context-menu";
import { TerminalPane } from "./TerminalPane";
import { CloseDialog } from "./CloseDialog";
import { BrowserPane } from "./BrowserPane";
import { ThemeWelcome } from "./ThemeWelcome";
import { OrchestrationSettings, orchestrationCategories, orchestrationCategory } from "./OrchestrationSettings";
import { OrchestrationBatchConfirmation, OrchestrationPanel } from "./OrchestrationPanel";
import type { OrchestrationView, OrchestrationRunView, OrchestrationUiCommand } from "./orchestration-contract";
import { loadManagedLayout, locateManagedSession, managedLayoutKey, managedTabRows, reconcileManagedLayout } from "./orchestration-layout";
import type { ManagedWorkspaceLayout } from "./workspace";
import { orchestrationError, runStatus, summarizeRunPending, workspaceRunStatus } from "./orchestration-presentation";
import { UiSettings } from "./UiSettings";
import { BrowserSettings } from "./BrowserSettings";
import { LayoutView } from "./LayoutView";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Card, CardHeader, CardContent } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Alert } from "./components/ui/alert";
import { DesktopNotifications, useDesktopNotice } from "./components/ui/notifications";
import { notifyDesktop, putNotification, taskNotifications, focusedTaskSource, suppressTaskNotification } from "./desktop-notifications";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./components/ui/dropdown-menu";
import { TooltipProvider, TooltipButton, Tooltip, TooltipTrigger, TooltipContent } from "./components/ui/tooltip";
import { ArrowLeft, ArrowRight, ArrowDown, Plus, X, PanelLeft, House, FolderOpen, PanelsTopLeft, TerminalSquare, ChevronDown, Columns2, Grid2X2, Info, Settings, Check, Pencil, Trash2 } from "lucide-react";
import "./styles.css";

const brandLogo: string = require("./assets/agent-light.svg");
const brandDarkLogo: string = require("./assets/agent-dark.svg");

declare global { interface Window { autopilotDesktop: DesktopBridge } }
type Page = "welcome" | "workspace" | "overview" | "terminal" | "settings";
type Mode = "x2" | "x4" | "freedom";

const statusVariants = { answering: "warning", recovering: "warning", recovery_failed: "error", recoverable: "warning", limited: "warning", running: "accent", waiting: "warning", completed: "success", idle: "outline", failed: "error", interrupted: "warning", unknown: "outline" } as const;
const installationHints = { available: "", checking: "正在检测环境，请稍候", missing: "未检测到，请安装后启用", error: "检测失败，请重新检测；安装后可能需要重启 Desktop" };

/** 不可用的选项保留 Radix 禁用语义，同时允许鼠标悬停读取原因。 */
function AgentOption({ value, label, installation, onChoose }: { value: string; label: string; installation: AgentInstallation | "checking"; onChoose?: (value: string) => void }) {
  // 显式选择当前值也记录意图，空格等待 Radix 确认以保留键入搜索行为。
  if (installation === "available") return <SelectItem
    value={value}
    onPointerUp={function choose(event) {
      if (event.button === 0) onChoose?.(value);
    }}
    onKeyDown={function choose(event) {
      queueMicrotask(function confirmSelection() {
        if (event.key === "Enter" || event.key === " " && event.defaultPrevented) onChoose?.(value);
      });
    }}
  >{label}</SelectItem>;
  const hint = value === "claude" && installation === "error" ? "Claude Code 安装不完整、正在更新或运行时不可用，请稍后重新检测；仍失败时修复官方 CLI 安装" : installationHints[installation];
  return <Tooltip><TooltipTrigger asChild><SelectItem value={value} disabled className="data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:opacity-50" aria-label={`${label}，${hint}`}>{label} · {installation === "missing" ? "未检测到" : installation === "checking" ? "检测中" : "检测失败"}</SelectItem></TooltipTrigger><TooltipContent>{hint}</TooltipContent></Tooltip>;
}

/** 侧栏状态灯复用现有状态语义和主题色，减少动态效果时保留静态圆环及文字说明。 */
function AgentStatusIndicator({ status }: { status: TaskStatus }) {
  const classes = {
    accent: "size-3 border-2 border-accent/30 border-t-accent motion-safe:animate-spin",
    success: "size-2 bg-success",
    error: "size-2 bg-error",
    warning: "size-2 bg-warning",
    outline: "size-2 bg-muted",
  };
  return <span className="inline-flex size-3 shrink-0 items-center justify-center" role="img" aria-label={taskLabels[status]} title={taskLabels[status]}><span className={`rounded-full ${classes[statusVariants[status]]}`} /></span>;
}

/** 全局页面与宿主终端分离，单一提交锁覆盖所有创建入口。 */
function App() {
  const orchestrationEpoch = useRef(0);
  const [settingsCategory, setSettingsCategory] = useState<string>(orchestrationCategory);
  const [orchestration, setOrchestration] = useState<OrchestrationView>({ runs: [], modes: {}, preferences: { responsibility: "local", repairLimit: 2, automaticDispatch: true } });
  const managedLayouts = useRef(new Map<string, ManagedWorkspaceLayout>());
  const [managedLayoutRevision, setManagedLayoutRevision] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [page, setPage] = useState<Page>(initialWorkspace.workspaces.length ? "terminal" : "welcome");
  const rememberedWorkspaces = useRef<{ parallel: string | null; orchestration: string | null }>({ parallel: null, orchestration: null });
  const [orchestrationDirectory, setOrchestrationDirectory] = useState<{ path: string; name: string } | null>(null);
  const [welcomeMode, setWelcomeMode] = useState<"parallel" | "orchestration">("parallel");
  const [agent, setAgent] = useState<AgentType>("ap");
  const [orchestrationAgentNotice, setOrchestrationAgentNotice] = useState<AgentType>();
  const agentSelected = useRef(false);
  const [apPermission, setApPermission] = useState<ApPermissionMode | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<AgentType | null>(null);
  const [newTerminalDraft, setNewTerminalDraft] = useState<NewTerminalType | null>(null);
  const [targetWorkspace, setTargetWorkspace] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [directory, setDirectory] = useState<{ path: string; name: string } | null>(null);
  const [expandedSidebar, setExpandedSidebar] = useState(true);
  const [resizing, setResizing] = useState(false);
  const [browserResizing, setBrowserResizing] = useState(false);
  const [browserRatios, setBrowserRatios] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [hostConnected, setHostConnected] = useState(true);
  const [installations, setInstallations] = useState<AgentInstallations | null>(null);
  const installationRequest = useRef(0);
  const surfaces = useRef(new Map<string, HTMLDivElement>());
  const createLock = useRef(false);
  const pickLock = useRef(false);
  const navigation: { current: number; managedActivation?: { pending: boolean; snapshot?: Workspace } } = useRef(0);
  const renameTarget = useRef<string | null>(null);
  const mounted = useRef(true);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeStrip = useRef<HTMLButtonElement | null>(null);
  const activeGroup = workspace.workspaces.find(function active(group) { return group.id === workspace.activeWorkspace; });
  const orchestrationMode = activeGroup?.mode === "orchestration";
  const welcomeWorkspace = modeWorkspace(workspace, welcomeMode, rememberedWorkspaces.current[welcomeMode], orchestration.runs.map(function id(run) { return run.workspaceId; }));
  /** 只记住已经进入工作台的身份，欢迎页草稿不会覆盖另一模式。 */
  function rememberWorkspace() { if (page === "terminal" && activeGroup) rememberedWorkspaces.current[orchestrationMode ? "orchestration" : "parallel"] = activeGroup.id; }
  useEffect(rememberWorkspace, [page, activeGroup?.id, orchestrationMode]);
  const current = workspace.tabs.find(function active(tab) { return tab.id === workspace.activeTab; });
  const enteredOrchestration = useRef<string | undefined>(undefined);
  const fromParallel = useRef<AgentType | undefined>(undefined);
  /** 首次进入、切模式及恢复工作区共享纠正入口，Parallel 的草稿独立保存。 */
  function announceOrchestrationAgent() {
    if (!orchestrationMode || !activeGroup) { enteredOrchestration.current = undefined; return; }
    if (page !== "terminal") return;
    if (enteredOrchestration.current === activeGroup.id) return;
    enteredOrchestration.current = activeGroup.id;
    const selected = fromParallel.current ?? (agentSelected.current ? agent : (defaultDraft ?? workspace.defaultAgent));
    fromParallel.current = undefined;
    if (selected !== "ap") setOrchestrationAgentNotice(selected);
  }
  useEffect(announceOrchestrationAgent, [page, activeGroup?.id, orchestrationMode, agent, workspace.defaultAgent]);
  /** 拖动完成后只记当前工作区的显示比例。 */
  function resizeBrowser(ratio: number) {
    if (activeGroup) setBrowserRatios(function update(previous) { return { ...previous, [activeGroup.id]: ratio }; });
  }
  const previousTasks = useRef<Workspace | undefined>(undefined);
  useDesktopNotice("工作台操作失败", error);
  useDesktopNotice("工作台提示", workspace.notice);
  /** 断线快照不产生完成通知，重连只重建观察基线。 */
  function reportTasks() {
    if (!hostConnected) { previousTasks.current = undefined; return; }
    const focusedPane = page === "terminal" ? document.activeElement?.closest<HTMLElement>("[data-desktop-pane-id]")?.dataset.desktopPaneId : undefined;
    const focused = focusedTaskSource(workspace, focusedPane);
    for (const notification of taskNotifications(previousTasks.current, workspace)) if (!suppressTaskNotification(notification, workspace.ui, currentAppearance.focused, focused)) putNotification({ ...notification, id: crypto.randomUUID() });
    previousTasks.current = workspace;
  }
  useEffect(reportTasks, [workspace, hostConnected]);

  /** 只接受更新版本的宿主快照，迟到请求不会回滚新布局。 */
  function accept(next: Workspace) { setWorkspace(function latest(previous) { return next.revision >= previous.revision ? next : previous; }); }
  /** 首次载入恢复页面，后续轮询只更新事实而不抢导航焦点。 */
  function loadWorkspace() {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    mounted.current = true;
    /** 单一串行轮询不会堆积 IPC 请求。 */
    async function poll() {
      const timeout = setTimeout(function staleHost() { if (!stopped) setHostConnected(false); }, 2000);
      try {
        const res = await window.autopilotDesktop.getWorkspace();
        if (stopped) return;
        accept(res);
        setHostConnected(true);
        if (first && navigation.current === 0) { if (!agentSelected.current) setAgent(res.defaultAgent); if (res.workspaces.length) setPage("terminal"); }
        first = false;
      } catch { if (!stopped) { setHostConnected(false); setError("工作台连接失败，请检查桌面宿主。"); } }
      finally { clearTimeout(timeout); }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll();
    /** 卸载停止页面轮询，宿主 PTY 持续运行。 */
    return function cleanup() { stopped = true; mounted.current = false; clearTimeout(timer); clearTimeout(highlightTimer.current); };
  }
  useEffect(loadWorkspace, []);
  /** 仅应用请求序列最新的编排投影，断连时撤销交互可信度。 */
  async function readOrchestration(reconcile: boolean, sessionIds?: string[]) {
    const epoch = ++orchestrationEpoch.current;
    try {
      const next = await window.autopilotDesktop.orchestration.snapshot(reconcile, sessionIds);
      if (mounted.current && epoch === orchestrationEpoch.current) { setOrchestration(next); return true; }
    } catch {
      if (mounted.current && epoch === orchestrationEpoch.current) setOrchestration(function offline(previous) {
        return { ...previous, runs: previous.runs.map(function stale(run) {
          return { ...run, connected: false, needsRecovery: true, controllerInspection: undefined, interactions: run.interactions?.map(function unconfirmed(item) { return { ...item, state: "unconfirmed" }; }),
            assignments: run.assignments.map(function unclear(a) { return { ...a, inspection: undefined }; }) };
        }) };
      });
    }
    return false;
  }
  /** 宿主事件及时更新投影，低频对账补查过期、漏报与连接变化。 */
  function observeOrchestration() {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let notification: ReturnType<typeof setTimeout> | undefined;
    const sessions = new Set<string>();
    let notificationVersion = 0;
    /** 先使已发出的读取失效，同一批事件只取一次轻量投影。 */
    function changed(sessionId?: string) {
      if (stopped) return;
      if (sessionId) sessions.add(sessionId);
      notificationVersion++;
      orchestrationEpoch.current++;
      if (notification) return;
      notification = setTimeout(async function latest() {
        notification = undefined;
        const version = notificationVersion;
        const affected = sessions.size <= 64 ? [...sessions] : undefined;
        if (await readOrchestration(false, affected) && version === notificationVersion) sessions.clear();
      }, 0);
    }
    /** 定期对账等待事项，避免刷新互相叠加。 */
    async function poll() {
      await readOrchestration(true);
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    const unsubscribe = window.autopilotDesktop.orchestration.onChanged(changed);
    void poll();
    return function close() { stopped = true; orchestrationEpoch.current++; unsubscribe(); clearTimeout(timer); clearTimeout(notification); };
  }
  useEffect(observeOrchestration, []);
  /** 请求只传业务目标，失败不冒充已提交。 */
  async function orchestrationCommand(value: OrchestrationUiCommand) {
    if (value.type === "selectRun" || value.type === "newTask") navigation.current++;
    try {
      await window.autopilotDesktop.orchestration.command(value);
      if (value.type === "selectRun") {
        // 主进程选择已经提交。立即显示该目标，废弃 reset 前已开始的状态快照。
        orchestrationEpoch.current++;
        setOrchestration(function select(previous) { return { ...previous, runs: previous.runs.map(function current(run) {
          return run.workspaceId === value.workspaceId ? { ...run, current: run.id === value.runId } : run;
        }) }; });
      }
      void readOrchestration(false);
      return true;
    }
    catch (error) { notifyDesktop("编排操作未完成", error instanceof Error ? orchestrationError(error.message) : "请重新核查宿主状态", "error"); await readOrchestration(false); return false; }
  }

  /** 只应用最新检测结果，切换页面后仍可复用宿主返回的可用性。 */
  async function refreshInstallations() {
    const request = ++installationRequest.current;
    setInstallations(null);
    try {
      const res = await window.autopilotDesktop.getAgentInstallations();
      console.log(res);
      if (mounted.current && request === installationRequest.current) setInstallations(res);
    } catch {
      if (mounted.current && request === installationRequest.current) setInstallations({ claude: "error", codex: "error", opencode: "error", codebuddy: "error" });
    }
  }
  /** 进入创建页或设置页时刷新环境检测。 */
  function loadAgentInstallations() { if (page === "welcome" || page === "settings") void refreshInstallations(); }
  useEffect(loadAgentInstallations, [page]);
  /** 内置 AP 与空白终端沿用原启动条件，第三方使用宿主检测结果。 */
  function installationFor(value: AgentType | NewTerminalType): AgentInstallation | "checking" { return value === "ap" || value === "shell" ? "available" : installations?.[value] ?? "checking"; }
  /** 活动标签自动进入独立横向滚动条的可见范围。 */
  function revealTab() { activeStrip.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  useEffect(revealTab, [workspace.activeTab]);

  /** 页面导航只改变本地可见性。 */
  function navigate(next: Page) { navigation.current++; setPage(next); }
  /** 卡片空白区域和文件夹图标共用工作区切换入口。 */
  function activateWorkspace(id: string) { return revealWorkbench({ type: "workspaceActivate", desktopWorkspaceId: id }); }
  /** 以宿主的激活结果切换页面，过期定位不抢之后的导航。 */
  async function revealWorkbench(value: Extract<WorkspaceCommand, { type: "activate" | "workspaceActivate" }>) {
    const version = ++navigation.current;
    if (!await command(value) || version !== navigation.current) return;
    navigate("terminal");
    if (value.type === "activate" && value.paneId) {
      setHighlight(value.paneId);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(function clearHighlight() { setHighlight(null); }, 1600);
    }
  }
  /** 名称与右键菜单共用原位编辑，收起的侧栏先展开。 */
  function beginRename(id: string, name: string) { renameTarget.current = id; setExpandedSidebar(true); setRename({ id, name }); }
  /** 失焦统一提交名称，空值与未修改内容直接结束编辑。 */
  function finishRename(id: string, value: string, originalName: string) {
    if (renameTarget.current !== id) return;
    renameTarget.current = null;
    setRename(null);
    const name = value.trim();
    if (name && name !== originalName) void command({ type: "workspaceRename", desktopWorkspaceId: id, name });
  }
  /** 固定工作台动作统一回显错误，并返回权威结果。 */
  async function command(value: WorkspaceCommand): Promise<Workspace | undefined> {
    try {
      const res = await window.autopilotDesktop.command(value);
      console.log(res);
      if (mounted.current) { accept(res); setError(""); }
      return res;
    } catch (failure) {
      if (mounted.current) {
        const message = failure instanceof Error ? failure.message : "请重试。";
        notifyDesktop("工作台操作失败", message, "error");
      }
    }
  }
  /** 两个欢迎页入口共用草稿，选择布局不会启动任何进程。 */
  function welcome() { setApPermission(null); setWelcomeMode(orchestrationMode ? "orchestration" : "parallel"); setTargetWorkspace(null); setAgent(defaultDraft ?? workspace.defaultAgent); agentSelected.current = false; setMode(null); setDirectory(null); navigate("welcome"); }
  /** 新建 Tab 草稿固定捕获所属组，后续导航不会迁移该请求。 */
  function newTab() { setApPermission(null); setWelcomeMode("parallel"); setTargetWorkspace(activeGroup?.id ?? null); setAgent(defaultDraft ?? workspace.defaultAgent); agentSelected.current = false; setMode(null); setDirectory(activeGroup ? { path: activeGroup.directory, name: activeGroup.name } : null); navigate("welcome"); }
  /** 已进入的模式恢复原工作区，首次进入只展示该模式的独立创建草稿。 */
  async function switchWelcomeMode(value: string) {
    if (createLock.current || busy) return;
    if (value !== "parallel" && value !== "orchestration") return;
    if (value === "orchestration" && !orchestrationMode) fromParallel.current = page === "terminal" ? current?.agent : undefined;
    if (value === "parallel") fromParallel.current = undefined;
    if (activeGroup) rememberedWorkspaces.current[orchestrationMode ? "orchestration" : "parallel"] = activeGroup.id;
    setWelcomeMode(value);
    const group = modeWorkspace(workspace, value, rememberedWorkspaces.current[value], orchestration.runs.map(function id(run) { return run.workspaceId; }));
    if (group) await resumeWorkspace(group.id);
    else { setTargetWorkspace(null); navigate("welcome"); }
  }
  /** 导航成功才进入工作台，不把当前工作区改作另一模式的新工作区。 */
  async function resumeWorkspace(id: string) {
    if (createLock.current) return;
    createLock.current = true; setBusy(true);
    try { await activateWorkspace(id); }
    finally { createLock.current = false; setBusy(false); }
  }
  /** 返回当前欢迎模式已经进入过的工作区。 */
  async function returnToWorkbench() { if (welcomeWorkspace) await resumeWorkspace(welcomeWorkspace.id); }
  /** 编排目录独立保存，不借用 Parallel 创建草稿。 */
  async function chooseOrchestrationDirectory() { const version = navigation.current; const selected = await pick(); if (selected && version === navigation.current) setOrchestrationDirectory(selected); }
  /** 编排只创建工作区身份，目标和 Trust 在进入后的原有面板提交。 */
  async function enterOrchestration() {
    if (createLock.current || !orchestrationDirectory) return;
    createLock.current = true; setBusy(true);
    const version = navigation.current;
    try {
      const res = await command({ type: "workspaceCreate", requestId: crypto.randomUUID(), directory: orchestrationDirectory.path, apPermission: apPermission ?? workspace.defaultApPermission });
      if (!res?.activeWorkspace) return;
      rememberedWorkspaces.current.orchestration = res.activeWorkspace;
      if (version === navigation.current) navigate("terminal");
    } finally { createLock.current = false; setBusy(false); }
  }
  /** 手动确认选项时同时保存最终类型和选择意图，设置默认值只用于初始化。 */
  function chooseAgent(value: string) { setAgent(value as AgentType); agentSelected.current = true; }
  /** 目录选择串行加锁，取消保持此前有效选择。 */
  async function pick(): Promise<{ path: string; name: string } | null> {
    if (pickLock.current) return null;
    pickLock.current = true;
    setPicking(true);
    try {
      const res = await window.autopilotDesktop.pickDirectory();
      console.log(res);
      return res;
    } catch { notifyDesktop("目录选择失败", "请重试。", "error"); return null; }
    finally { pickLock.current = false; setPicking(false); }
  }
  /** 更新统一创建草稿，不改变已有 Tab 的默认目录。 */
  async function chooseDraftDirectory() { const version = navigation.current; const selected = await pick(); if (selected && navigation.current === version) setDirectory(selected); }
  /** 冻结提交内容并以请求身份去重，导航之后的完成不会强抢页面。 */
  async function enter() {
    if (createLock.current || !mode || mode !== "freedom" && (!directory || installationFor(agent) !== "available")) return;
    createLock.current = true;
    setBusy(true);
    const version = navigation.current;
    const submittedMode = mode;
    const submittedDirectory = directory?.path ?? null;
    const res = await command({ type: "create", requestId: crypto.randomUUID(), mode: submittedMode, directory: submittedDirectory, apPermission: apPermission ?? workspace.defaultApPermission, agent, agentSelected: agentSelected.current, desktopWorkspaceId: targetWorkspace });
    if (res) {
      if (navigation.current === version) { setMode(null); setDirectory(null); navigate("terminal"); }
    }
    createLock.current = false;
    setBusy(false);
  }
  /** 新增或修改默认目录只对调用时捕获的 Tab 生效。 */
  async function chooseTabDirectory(tab: Tab) {
    const selected = await pick();
    if (selected) await command({ type: "directory", tabId: tab.id, directory: selected.path });
  }
  /** 智能体使用Tab目录，空白终端由宿主采用当前工作区路径。 */
  async function addTerminal(tab: Tab, axis: "row" | "column") {
    const terminal = tab.agentSelected ? tab.agent : newTerminalDraft ?? workspace.newTerminal;
    const installation = installationFor(terminal);
    if (installation !== "available") { notifyDesktop("终端创建失败", `${terminal === "shell" ? newTerminalNames.shell : agentNames[terminal]} · ${installationHints[installation]}。可在设置页重新检测。`, "error"); return; }
    if (terminal !== "shell" && !tab.directory) {
      const selected = await pick();
      if (!selected) return;
      const res = await command({ type: "directory", tabId: tab.id, directory: selected.path });
      if (!res) return;
    }
    await command({ type: "add", tabId: tab.id, axis });
  }
  /** 定位先激活目标并解除不相关放大，不向终端写入任何字符。 */
  function locate(tab: Tab, pane?: Pane) { return revealWorkbench({ type: "activate", tabId: tab.id, paneId: pane?.id }); }
  /** 宿主确认成功之后才删除目标 UI，取消时保持原页面。 */
  async function closeTab(tab: Tab) {
    await command({ type: "close", tabId: tab.id });
  }
  /** 稳定容器独立于分屏树，新增/放大只移动 DOM，不卸载既有 xterm。 */
  function surface(id: string) {
    let element = surfaces.current.get(id);
    if (!element) {
      element = document.createElement("div");
      element.className = "h-full min-h-64 min-w-0";
      surfaces.current.set(id, element);
    }
    return element;
  }
  /** 分屏树只拥有占位槽，终端 React 身份在平铺 portal 列表中保持稳定。 */
  function renderPane(_tab: Tab, id: string) {
    return <div className="h-full min-h-64 min-w-0" ref={function attach(slot) {
      if (!slot) return;
      const element = surface(id);
      // React 可复用另一窗格的槽位，替换旧外壳并移动稳定容器；解绑时不触碰已迁移容器。
      if (slot.childNodes.length !== 1 || slot.firstChild !== element) slot.replaceChildren(element);
    }} />;
  }
  /** 只回收已经关闭的容器，隐藏页面与重排不释放视图。 */
  function pruneSurfaces() {
    const ids = new Set(workspace.tabs.flatMap(function ids(tab) { return tab.panes.map(function id(pane) { return pane.id; }); }));
    for (const [id, element] of surfaces.current) if (!ids.has(id)) { element.remove(); surfaces.current.delete(id); }
  }
  useEffect(pruneSurfaces, [workspace]);
  /** 窗格动作只携带所属 Tab 与稳定身份。 */
  function renderTerminal(tab: Tab, id: string) {
    const pane = tab.panes.find(function matches(item) { return item.id === id; });
    if (!pane) return null;
    return createPortal(<TerminalPane key={pane.id} pane={pane} resizing={resizing || browserResizing} focused={tab.focused === pane.id} highlighted={highlight === pane.id} visible={page === "terminal" && !orchestrationMode && workspace.activeTab === tab.id && (!tab.expanded || tab.expanded === pane.id)} expanded={tab.expanded === pane.id}
      onFocus={function focus() { if (tab.focused !== pane.id) void command({ type: "activate", tabId: tab.id, paneId: pane.id }); }}
      onClose={function close() { void command({ type: "close", tabId: tab.id, paneId: pane.id }); }}
      onExpand={function expand() { void command({ type: "expand", tabId: tab.id, paneId: tab.expanded === pane.id ? null : pane.id }); }}
      onRetry={function retry() { void command({ type: "retry", tabId: tab.id, paneId: pane.id }); }} />, surface(pane.id), pane.id);
  }

  const instances = workspace.tabs.flatMap(function rows(tab) { return tab.panes.map(function row(pane) { return { tab, pane: hostConnected ? pane : { ...pane, aps: pane.aps?.map(function disconnected(ap) { return { ...ap, connection: "disconnected" as const }; }) } }; }); });
  const counts = summarizeAp(instances.map(function pane(item) { return item.pane; }));
  const currentRuns = useMemo(function current() { return orchestration.runs.filter(function selected(run) { return run.current; }); }, [orchestration.runs]);
  const latestRuns = useRef(currentRuns);
  latestRuns.current = currentRuns;
  const terminalMode = orchestration.preferences.executorLayout ?? "tab";
  const currentLayouts = useMemo(function layouts() {
    return new Map(currentRuns.map(function layout(run) {
      const key = managedLayoutKey(run);
      return [key, reconcileManagedLayout(managedLayouts.current.get(key) ?? loadManagedLayout(run), run, terminalMode)];
    }));
  }, [currentRuns, managedLayoutRevision, terminalMode]);
  const openRun = currentRuns.find(function active(run) { return run.workspaceId === activeGroup?.id; });

  /** 侧栏与终端使用同一份位置记录，旧版持久键保持不变。 */
  function rememberManagedLayout(key: string, layout: ManagedWorkspaceLayout) {
    if (managedLayouts.current.get(key) === layout) return;
    managedLayouts.current.set(key, layout);
    try { localStorage.setItem(key, JSON.stringify(layout)); }
    catch { /* 当前窗口继续使用内存布局。 */ }
  }
  useLayoutEffect(function rememberCurrentLayouts() {
    currentLayouts.forEach(function persist(layout, key) { rememberManagedLayout(key, layout); });
  }, [currentLayouts]);
  /** 委派补挂、人工定位与关窗都更新同一 Run 的原位置。 */
  function changeManagedLayout(run: OrchestrationRunView, update: (previous: ManagedWorkspaceLayout) => ManagedWorkspaceLayout) {
    const key = managedLayoutKey(run);
    const previous = managedLayouts.current.get(key) ?? currentLayouts.get(key);
    if (!previous) return;
    const next = update(previous);
    if (next === previous) return;
    rememberManagedLayout(key, next);
    setManagedLayoutRevision(function refresh(n) { return n + 1; });
  }
  /** 仅显式点击改变焦点。切换期间 Run 或导航已变化时忽略旧定位。 */
  async function locateManagedTab(run: OrchestrationRunView, target: string) {
    const version = ++navigation.current;
    const observed = navigation.managedActivation;
    const activeWorkspace = observed?.snapshot && observed.snapshot.revision > workspace.revision ? observed.snapshot.activeWorkspace : workspace.activeWorkspace;
    // 上一个跨组激活未完成时，即使界面仍显示目标组，也要让宿主串行提交最后一次选择。
    if (observed?.pending || activeWorkspace !== run.workspaceId) {
      const activation: NonNullable<typeof navigation.managedActivation> = { pending: true };
      navigation.managedActivation = activation;
      try { activation.snapshot = await command({ type: "workspaceActivate", desktopWorkspaceId: run.workspaceId }); }
      finally { activation.pending = false; }
      if (activation.snapshot?.activeWorkspace !== run.workspaceId) return;
    }
    if (version !== navigation.current || !latestRuns.current.some(function selected(r) { return r.id === run.id && r.workspaceId === run.workspaceId; })) return;
    changeManagedLayout(run, function position(layout) { return locateManagedSession(layout, target); });
    navigate("terminal");
  }
  const orchestrationPending = summarizeRunPending(currentRuns);
  const visibleInstances = instances.filter(function matches({ pane }) {
    return filter === "all" || pane.agents?.some(function matches(agent) { return (hostConnected ? agent.status : "unknown") === filter; }) || (!pane.aps?.length && filter === "unknown") || pane.aps?.some(function apMatches(ap) {
      return !ap.sessions.length && filter === "unknown" || ap.sessions.some(function sessionMatches(session) { return sessionTask(ap, session) === filter; });
    });
  });
  return <TooltipProvider delayDuration={400}><main className="flex h-screen min-h-0 overflow-hidden bg-bg font-sans text-sm text-ink">
    {workspace.tabs.flatMap(function terminals(tab) { return tab.panes.map(function terminal(pane) { return renderTerminal(tab, pane.id); }); })}
    <aside aria-label="主导航" className={`${page === "welcome" ? "hidden" : "flex"} shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-2 ${expandedSidebar ? "w-80" : "w-14"}`}>
      <div className={`mb-3 flex items-center ${expandedSidebar ? "h-10 gap-3 px-2.5" : "flex-col gap-1"}`}>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="h-auto min-w-0 gap-2 px-0" aria-label="切换工作模式" disabled={busy}><img src={brandLogo} alt="" aria-hidden="true" className="size-7 shrink-0 [:root[data-theme=light]_&]:hidden" /><img src={brandDarkLogo} alt="" aria-hidden="true" className="hidden size-7 shrink-0 [:root[data-theme=light]_&]:block" />{expandedSidebar && <span className="whitespace-nowrap text-sm font-semibold">Autopilot · {orchestrationMode ? "Orchestration" : "Parallel"}</span>}</Button></DropdownMenuTrigger><DropdownMenuContent>{(["parallel", "orchestration"] as const).map(function mode(value) { return <DropdownMenuItem key={value} onSelect={function select() { void switchWelcomeMode(value); }}>{value === "parallel" ? "Parallel" : "Orchestration"}</DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu>
        <TooltipButton label="展开或收起侧栏" aria-expanded={expandedSidebar} className={expandedSidebar ? "ml-auto shrink-0" : "h-10 w-full"} onClick={function toggle() { setExpandedSidebar(!expandedSidebar); }}><PanelLeft /></TooltipButton>
      </div>
      {([['welcome', House, '欢迎页'], ['workspace', FolderOpen, '工作区信息'], ['overview', PanelsTopLeft, '智能体总台'], ['settings', Settings, '设置']] as const).map(function nav([target, Icon, label]) {
        return <Tooltip key={target}><TooltipTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={label} aria-current={page === target ? "page" : undefined} className={`h-10 w-full gap-3 overflow-hidden hover:bg-muted/10 ${expandedSidebar ? "justify-start px-2.5" : "justify-center px-0"}`} onClick={function open() { if (target === "welcome") welcome(); else navigate(target); }}><Icon />{expandedSidebar && <span className="hidden min-[1100px]:inline">{label}</span>}</Button>
        </TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip>;
      })}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pt-4" aria-label="工作区列表">
        {workspace.workspaces.filter(function belongs(group) { return (group.mode ?? "parallel") === (orchestrationMode ? "orchestration" : "parallel"); }).map(function groupCard(group) {
          const managedRun = currentRuns.find(function same(run) { return run.workspaceId === group.id; });
          const layout = managedRun && currentLayouts.get(managedLayoutKey(managedRun));
          const managedTabs = managedRun && layout ? managedTabRows(managedRun, layout) : [];
          const runningTabs = managedTabs.filter(function running(tab) { return tab.running; }).length;
          const rows = instances.filter(function belongs(item) { return item.tab.desktopWorkspaceId === group.id && item.pane.process !== "exited"; });
          const entries = rows.flatMap(function entries({ tab, pane }) {
            return [...(pane.aps ?? []).filter(function live(ap) { return ap.connection !== "exited"; }).map(function apEntry(ap) {
              const states = ap.sessions.map(function status(session) { return sessionTask(ap, session); });
              const status: TaskStatus = states.includes("waiting") ? "waiting" : states.includes("answering") ? "answering" : states.includes("running") ? "running" : states[0] ?? "unknown";
              return { key: ap.apInstanceId, agent: "ap" as AgentType, status, label: taskLabels[status], tab, pane };
            }), ...(pane.agents ?? []).map(function thirdParty(value) {
              const status = hostConnected && value.observation === "enabled" ? value.status : "unknown";
              return { key: value.instanceId, agent: value.agent as AgentType, status, label: (value.observation === "disabled" ? "观察已禁用" : value.observation === "pending" ? "等待观察事件" : agentStatusLabels[status]), tab, pane };
            })];
          });
          return <ContextMenu key={group.id} label={`${group.name} 工作区菜单`} items={<><DropdownMenuItem onSelect={function renameGroup() { beginRename(group.id, group.name); }}><Pencil />重命名工作区</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-error" onSelect={function deleteGroup() { void command({ type: "workspaceDelete", desktopWorkspaceId: group.id }); }}><Trash2 />删除工作区</DropdownMenuItem></>}><Card className={`cursor-pointer overflow-hidden ${expandedSidebar ? "p-2" : "h-10 p-0"} ${group.id === workspace.activeWorkspace ? "border-selected-border bg-selected" : "bg-surface"}`} onClick={function activateGroup() { activateWorkspace(group.id); }}>
            <div className={`flex items-center ${expandedSidebar ? "" : "h-full justify-center"}`}><TooltipButton label={`切换到${group.name}`} className={expandedSidebar ? undefined : "h-full w-full"} onClick={function activateGroup(event) { event.stopPropagation(); activateWorkspace(group.id); }}><FolderOpen /></TooltipButton>{expandedSidebar && (rename?.id === group.id ? <Input autoFocus aria-label="工作区名称" className="h-8 min-w-0 flex-1 px-1" value={rename.name} maxLength={256}
              onFocus={function selectName(event) { event.currentTarget.select(); }}
              onClick={function editName(event) { event.stopPropagation(); }}
              onChange={function changeName(event) { setRename({ id: group.id, name: event.target.value }); }}
              onBlur={function saveName(event) { finishRename(group.id, event.currentTarget.value, group.name); }}
              onKeyDown={function editKey(event) {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.preventDefault(); renameTarget.current = null; setRename(null); }
              }} /> : <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start px-1 py-2" aria-label={`重命名${group.name}`} onClick={function renameGroup(event) { event.stopPropagation(); beginRename(group.id, group.name); }}><span className="truncate">{group.name}</span></Button>)}</div>
            {expandedSidebar && <><p className="truncate px-2 text-xs text-muted" title={group.directory}>{group.directory}</p><div className="mt-2 flex items-center gap-1"><Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start overflow-hidden" aria-expanded={openGroups.includes(group.id)} aria-label={group.mode === "orchestration" ? `${group.name} 编排 Tab，${runningTabs} 个运行中` : `${group.name} 智能体列表，${entries.length} 个`} onClick={function toggleGroup(event) { event.stopPropagation(); setOpenGroups(function toggle(previous) { return previous.includes(group.id) ? previous.filter(function other(id) { return id !== group.id; }) : [...previous, group.id]; }); }}>
              {group.mode === "orchestration" ? <span className="text-xs text-muted">{workspaceRunStatus(managedRun)}{managedRun && ` · ${runningTabs} 个 Tab 运行中`}</span> : entries.length ? entries.map(function icon(entry) { return <span key={entry.key} className="inline-flex shrink-0 items-center gap-1.5" title={`${agentNames[entry.agent]} · ${entry.label}`}><AgentStatusIndicator status={entry.status} /><AgentLogo agent={entry.agent} /></span>; }) : <span className="text-xs text-muted">暂无已识别智能体</span>}<ChevronDown className="ml-auto shrink-0" /></Button></div>
              {openGroups.includes(group.id) && <div className="mt-2 space-y-1 border-t border-border pt-2">{group.mode === "orchestration" ? managedRun && managedTabs.length ? managedTabs.map(function row(tab) { return <Button key={tab.id} variant="ghost" className="h-auto w-full justify-start gap-2 py-2 text-left" aria-current={group.id === workspace.activeWorkspace && tab.id === layout?.activeTab ? "true" : undefined} onClick={function reveal(event) { event.stopPropagation(); void locateManagedTab(managedRun, tab.target); }}><span aria-hidden="true"><AgentStatusIndicator status={tab.status} /></span><span className="min-w-0 flex-1 truncate" title={tab.title}>{tab.number} · {tab.title}</span><span className="shrink-0 text-xs text-muted">{tab.label}</span></Button>; }) : <p className="px-2 text-xs text-muted">暂无编排 Tab</p> : <><p className="px-2 text-xs text-muted">已识别智能体 {entries.length}</p>{entries.map(function row(entry) { return <Button key={entry.key} variant="ghost" className="h-auto w-full justify-start gap-2 py-2 text-left" onClick={function reveal(event) { event.stopPropagation(); void locate(entry.tab, entry.pane); }}><AgentStatusIndicator status={entry.status} /><AgentLogo agent={entry.agent} /><span className="min-w-0"><span className="block truncate">{agentNames[entry.agent]} · {entry.label}</span><span className="block truncate text-xs text-muted">{entry.tab.name} · 终端 {entry.pane.number}</span></span></Button>; })}</>}</div>}</>}
          </Card></ContextMenu>;
        })}
      </div>
      <Button variant="outline" size="sm" aria-label="创建工作区" onClick={welcome}><Plus />{expandedSidebar && "工作区"}</Button>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1"><div className="flex min-w-0 flex-1 flex-col">
      <header className={page !== "terminal" || orchestrationMode ? "hidden" : "flex shrink-0 items-center gap-2 border-b border-border bg-surface p-2"}>
        <nav className={orchestrationMode ? "hidden" : "flex min-w-0 flex-1 gap-1 overflow-x-auto"} aria-label="工作台标签">
          {workspace.tabs.filter(function currentGroup(tab) { return tab.desktopWorkspaceId === workspace.activeWorkspace; }).map(function tabButton(tab) { return <div key={tab.id} className={`flex shrink-0 items-center rounded-md border ${workspace.activeTab === tab.id && page === "terminal" ? "border-selected-border bg-selected" : "border-transparent hover:bg-hover"}`}>
            <Button variant="ghost" size="sm" ref={workspace.activeTab === tab.id ? activeStrip : undefined} aria-current={workspace.activeTab === tab.id && page === "terminal" ? "page" : undefined} className="max-w-56 justify-start border-0 hover:bg-transparent aria-[current=page]:bg-transparent aria-[current=page]:text-ink" onClick={function activate() { void locate(tab); }}><TerminalSquare /><span className="truncate">{tab.name}</span></Button>
            <TooltipButton variant="destructive" label={`关闭 Tab ${tab.name}`} onClick={function close() { void closeTab(tab); }}><X /></TooltipButton>
          </div>; })}
        </nav>
        {!orchestrationMode && <Button variant="outline" size="sm" onClick={newTab}><Plus />新建 Tab</Button>}
      </header>
      {page !== "welcome" && <div className="flex flex-wrap gap-3 border-b border-border px-3 py-2 text-xs text-muted"><Button variant="ghost" size="sm" onClick={function overview() { navigate("overview"); }}>Orchestration：{currentRuns.filter(function active(r) { return r.connected && !r.accepted; }).length} 个活动 Run · {orchestrationPending.approvals} 项待审批 · {orchestrationPending.questions} 项待回答 · {orchestrationPending.unconfirmed} 项待核查 · {orchestrationPending.intents} 项编排意图{orchestrationPending.batches > 0 && ` · ${orchestrationPending.batches} 批待确认`}</Button><span className="self-center">Parallel：{counts.running} 个已知运行任务</span></div>}
      <section className={page === "welcome" ? "min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10" : "hidden"}>
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center py-4">
          {welcomeWorkspace && <Button variant="ghost" size="sm" disabled={busy} className="mb-8 self-start" onClick={returnToWorkbench}><ArrowLeft />返回工作台</Button>}
          <p className="text-xs tracking-widest text-accent">AUTOPILOT / DESKTOP</p>
          <ToggleGroup type="single" value={welcomeMode} onValueChange={switchWelcomeMode} disabled={busy || picking} className="mt-6 flex gap-2 border-b border-border pb-4" aria-label="工作模式">
            <ToggleGroupItem value="parallel" className="px-5 py-3 font-semibold">Parallel</ToggleGroupItem>
            <ToggleGroupItem value="orchestration" className="px-5 py-3 font-semibold">Orchestration</ToggleGroupItem>
          </ToggleGroup>
          {(welcomeMode === "orchestration" || agent === "ap" || mode === "freedom") && <div className="mt-6 space-y-3"><h2 className="font-semibold">本次 Autopilot 权限</h2><Select value={apPermission ?? workspace.defaultApPermission} disabled={busy} onValueChange={function choosePermission(value) { setApPermission(value as ApPermissionMode); }}><SelectTrigger className="w-48" aria-label="本次 Autopilot 权限"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(apPermissionNames).map(function option([value, label]) { return <SelectItem key={value} value={value}>{label}</SelectItem>; })}</SelectContent></Select><p className="text-xs leading-6 text-muted">仅用于本次创建的 AP。询问：需要授权时确认；为我审批：按现有风险规则自动审批；完全访问：仍遵守沙箱与硬性安全边界。空白 Shell 中手动打开 ap 采用创建时的权限；第三方暂不支持。</p></div>}
          {welcomeMode === "parallel" ? <div aria-label="Parallel 创建页面">
          <h1 className="mt-8 text-3xl font-semibold">Parallel</h1><p className="mt-3 text-muted">选择智能体、布局和工作区，再创建终端</p>
          <div className="mt-8 space-y-3"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">1 · 选择智能体</h2><Button variant="outline" size="sm" disabled={installations === null} onClick={refreshInstallations}>{installations === null ? "正在检测…" : "重新检测"}</Button></div><Select value={agent} disabled={busy} onValueChange={chooseAgent}><SelectTrigger aria-label="本次智能体"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(agentNames).map(function choice([value, label]) { return <AgentOption key={value} value={value} label={label} installation={installationFor(value as AgentType)} onChoose={chooseAgent} />; })}</SelectContent></Select>{installationFor(agent) !== "available" && <p className="text-xs text-muted" role="status">{installationHints[installationFor(agent)]}</p>}</div>
          <h2 className="mt-8 font-semibold">2 · 选择布局</h2>
          <ToggleGroup type="single" value={mode ?? ""} onValueChange={function chooseLayout(value) { if (value) setMode(value as Mode); }} disabled={busy} className="mt-4 grid grid-cols-1 gap-4 min-[760px]:grid-cols-3" aria-label="选择布局">
            {(["x2", "x4", "freedom"] as const).map(function card(choice) { return <ToggleGroupItem key={choice} value={choice} aria-label={`${choice} 布局`} className="p-6 text-left">
              <div className={`mb-7 h-20 gap-1 rounded-md border border-input-border p-2 ${choice === "x4" ? "grid grid-cols-2" : "flex"}`} aria-hidden="true">{choice === "freedom" ? <Plus className="m-auto size-6 text-muted" /> : Array.from({ length: choice === "x2" ? 2 : 4 }, function preview(_, index) { return <span key={index} className="flex-1 rounded-sm border border-input-border bg-bg" />; })}</div>
              <span className="text-2xl font-semibold">{choice}</span>
              <p className="mt-2 text-xs text-muted">{choice === "freedom" ? "一个空白终端，不启动智能体" : `${choice === "x2" ? "两个" : "四个"}终端，可继续增减`}</p>
              <span className="mt-4 flex min-h-4 items-center gap-2 text-xs text-accent-soft">{mode === choice && <Check className="size-3" />}{mode === choice ? "已选择" : "选择布局"}</span>
            </ToggleGroupItem>; })}
          </ToggleGroup>
          {mode && <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-6">
            <><span className="w-full font-semibold">3 · {targetWorkspace ? "Tab 启动目录（归属已固定）" : mode === "freedom" ? "选择工作区（可选）" : "选择工作区"}</span><Button variant="outline" disabled={busy || picking} onClick={chooseDraftDirectory}><FolderOpen />{picking ? "正在选择…" : "选择工作区目录"}</Button><span id="directory-hint" className="min-w-0 break-all text-xs text-muted">{directory?.name ?? (mode === "freedom" ? "可直接进入工作台" : "请先选择目录")}</span></>
            <Button disabled={busy || picking || mode !== "freedom" && (!directory || installationFor(agent) !== "available")} aria-describedby="directory-hint" onClick={enter}>{busy ? "正在创建…" : "4 · 进入"}<ArrowRight /></Button>
          </div>}
          </div> : <div className="mt-8 space-y-6" aria-label="Orchestration 页面">
            <h1 className="text-3xl font-semibold">Orchestration</h1>
            <p className="text-muted">选择工作区后进入编排，由 AP 主控管理任务。</p>
            <h2 className="font-semibold">选择编排工作区</h2>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" disabled={busy || picking} onClick={chooseOrchestrationDirectory}><FolderOpen />{picking ? "正在选择…" : "选择工作区目录"}</Button>
              <span className="min-w-0 break-all text-xs text-muted">{orchestrationDirectory?.path ?? "请先选择目录"}</span>
              <Button disabled={busy || picking || !orchestrationDirectory} onClick={enterOrchestration}>{busy ? "正在进入…" : "进入编排"}<ArrowRight /></Button>
            </div>
          </div>}
        </div>
      </section>
      <section aria-label="设置页面" className={page === "settings" ? "flex-1 overflow-auto px-6 py-10 sm:px-10" : "hidden"}>
        <div className="mx-auto w-full max-w-[52rem]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-6"><div><h1 className="text-2xl font-semibold">设置</h1><p className="mt-2 text-sm text-muted">工作区与终端的默认行为。</p></div><Button variant="outline" size="sm" disabled={installations === null} onClick={refreshInstallations}>{installations === null ? "正在检测…" : "重新检测智能体"}</Button></header>
          <div className="mt-6 flex flex-col gap-6 sm:flex-row"><nav aria-label="设置分类" className="flex shrink-0 flex-wrap gap-1 sm:w-40 sm:flex-col">{[...orchestrationCategories, "终端默认值", "通知与外观", "浏览器"].map(function category(name) { return <Button key={name} variant="ghost" aria-current={settingsCategory === name ? "page" : undefined} className="justify-start" onClick={function select() { setSettingsCategory(name); }}>{name}</Button>; })}</nav><div className="min-w-0 flex-1">
          {orchestrationCategories.includes(settingsCategory) && <OrchestrationSettings category={settingsCategory} view={orchestration} command={orchestrationCommand} />}
          {settingsCategory === "终端默认值" && <Card className="divide-y divide-border px-6">
            <div className="flex flex-wrap items-center justify-between gap-5 py-6"><div className="min-w-56 flex-1"><h2 className="font-semibold">Autopilot 默认权限</h2><p className="mt-2 text-xs leading-5 text-muted">仅影响之后新建的 AP，不改变已有或运行中的会话。已有 AP 可用 /permissions 调整。第三方后续适配。</p><p className="mt-2 text-xs leading-5 text-muted">询问：需要授权时确认；为我审批：按风险规则自动审批；完全访问：仍遵守沙箱与硬性安全边界。</p></div><Select value={workspace.defaultApPermission} onValueChange={async function savePermission(value) { await command({ type: "apPermissionPreference", permission: value as ApPermissionMode }); }}><SelectTrigger className="w-48" aria-label="Autopilot 默认权限"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(apPermissionNames).map(function option([value, label]) { return <SelectItem key={value} value={value}>{label}</SelectItem>; })}</SelectContent></Select></div>
            <div className="flex flex-wrap items-center justify-between gap-5 py-6">
              <div className="min-w-56 flex-1"><h2 className="font-semibold">默认智能体</h2><p className="mt-2 text-xs leading-5 text-muted">欢迎页与新建 Tab 草稿采用此设置。</p></div>
              <Select value={defaultDraft ?? workspace.defaultAgent} disabled={defaultDraft !== null} onValueChange={async function chooseDefault(value) { setDefaultDraft(value as AgentType); await command({ type: "preference", agent: value as AgentType }); setDefaultDraft(null); }}><SelectTrigger className="w-48" aria-label="默认智能体"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(agentNames).map(function option([value, label]) { return <AgentOption key={value} value={value} label={label} installation={installationFor(value as AgentType)} />; })}</SelectContent></Select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-5 py-6">
              <div className="min-w-56 flex-1"><h2 className="font-semibold">新建智能体终端</h2><p className="mt-2 text-xs leading-5 text-muted">未手动改选智能体的 Tab 新增终端时采用此默认值。空白终端从当前工作区路径启动。</p></div>
              <Select value={newTerminalDraft ?? workspace.newTerminal} disabled={newTerminalDraft !== null} onValueChange={async function chooseNewTerminal(value) { setNewTerminalDraft(value as NewTerminalType); await command({ type: "terminalPreference", terminal: value as NewTerminalType }); setNewTerminalDraft(null); }}><SelectTrigger className="w-48" aria-label="新建智能体终端"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(newTerminalNames).map(function option([value, label]) { return <AgentOption key={value} value={value} label={label} installation={installationFor(value as NewTerminalType)} />; })}</SelectContent></Select>
            </div>
            <p className="py-5 text-xs leading-6 text-muted">第三方受管命令使用局部 hooks/plugin。Codex 首次需在 /hooks 审核信任。Shell 中设置 AUTOPILOT_AGENT_OBSERVATION=off 后重启 CLI 可禁用本应用观察。</p>
          </Card>}
          {settingsCategory === "通知与外观" && <UiSettings ui={workspace.ui} command={command} />}
          {settingsCategory === "浏览器" && <BrowserSettings />}
          </div></div>
          <section aria-label="支持项目" className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
            <div><h2 className="font-semibold">支持项目</h2><p className="mt-2 text-xs text-muted">喜欢 Autopilot？欢迎在 GitHub 点亮 Star，或前往 NPM 查看软件包。</p></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={function openGitHub() { window.open("https://github.com/C-Clay-W/autopilot", "_blank", "noopener,noreferrer"); }}>GitHub <ArrowRight /></Button>
              <Button variant="outline" size="sm" onClick={function openNpm() { window.open("https://www.npmjs.com/package/autopilot-agent", "_blank", "noopener,noreferrer"); }}>NPM <ArrowRight /></Button>
            </div>
          </section>
        </div>
      </section>
      <section className={page === "workspace" ? "flex-1 overflow-auto p-6" : "hidden"}>
        <h1 className="text-2xl font-semibold">工作区信息</h1>
        {current ? <Card className="mt-6 max-w-3xl">
          <CardHeader><div className="flex flex-wrap items-center gap-3"><FolderOpen className="size-5 text-accent" /><h2 className="font-semibold">{current.name}</h2><Badge>所属 Tab</Badge></div></CardHeader>
          <CardContent className="space-y-5"><dl className="grid gap-4 text-sm"><div><dt className="text-xs text-muted">默认工作区</dt><dd className="mt-2 break-all">{current.directory ?? "尚未选择"}</dd></div><div><dt className="text-xs text-muted">终端数量</dt><dd className="mt-2">{current.panes.length}</dd></div></dl>
            <p className="text-xs leading-6 text-muted">默认目录仅用于后续新增终端。退出 ap 后，可在各自 shell 中 cd 到其他目录，再输入 ap。</p>
            <Button variant="outline" disabled={picking} onClick={function change() { void chooseTabDirectory(current); }}><FolderOpen />{picking ? "正在选择…" : "更改默认工作区"}</Button>
          </CardContent>
        </Card> : <Card className="mt-6 max-w-3xl"><CardHeader><p className="text-muted">请先创建一个 Tab。</p></CardHeader><CardContent><Button onClick={welcome}><Plus />创建新工作台</Button></CardContent></Card>}
      </section>
      <section className={page === "overview" ? "flex-1 overflow-auto p-6" : "hidden"}>
        <div className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold">智能体总台</h1>{!hostConnected && <Badge variant="warning">宿主连接中断</Badge>}</div>
        <div className="mt-5 space-y-3"><h2 className="font-semibold">Orchestration Run</h2>{orchestration.runs.map(function run(r) {
          const pending = summarizeRunPending([r]);
          return <Card key={r.id} className="flex flex-wrap items-center gap-3 p-4"><span className="mr-auto">{r.goal} · {r.steps.filter(function accepted(s) { return s.accepted; }).length}/{r.steps.length} Step</span><Badge variant={r.needsRecovery || pending.total > 0 ? "warning" : "outline"}>{runStatus(r)}</Badge><Button variant="outline" size="sm" onClick={async function locateRun() { if (r.current || await orchestrationCommand({ type: "selectRun", workspaceId: r.workspaceId, runId: r.id })) await activateWorkspace(r.workspaceId); }}>定位 Run · 待处理 {pending.total}</Button></Card>;
        })}{!orchestration.runs.length && <p className="text-sm text-muted">尚无编排 Run</p>}</div><h2 className="mt-6 font-semibold">Parallel 自由会话</h2>
        <Alert role="status" className="mt-5 text-muted"><Info /><p>自由会话的业务操作在 CLI 完成。AP 连接、Shell 生命周期与任务结果分别展示，关联观察单独标记。</p></Alert>
        <div className="mt-4 flex flex-wrap gap-2"><Badge>受管终端 {instances.length}</Badge><Badge>Shell 在线 {instances.filter(function online(item) { return item.pane.process === "shell"; }).length}</Badge><Badge>第三方运行实例 {instances.flatMap(function agents(item) { return item.pane.agents ?? []; }).filter(function running(agent) { return hostConnected && !agent.exited && agent.status === "running"; }).length}</Badge><Badge>第三方待处理实例 {instances.flatMap(function agents(item) { return item.pane.agents ?? []; }).filter(function waiting(agent) { return hostConnected && !agent.exited && agent.status === "waiting"; }).length}</Badge><Badge>已连接 AP {counts.connected}</Badge><Badge variant="warning">待确认实例 {counts.uncertain}</Badge><Badge>已知未完成任务 {counts.unfinished}</Badge><Badge>执行中 {counts.running}</Badge><Badge>待审批 {counts.approval}</Badge><Badge>待回答 {counts.answering}</Badge>{(counts.unknown > 0 || counts.unavailable > 0) && <Badge variant="warning">另有待确认 · 任务 {counts.unknown} / 未接入终端 {counts.unavailable}</Badge>}</div>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-4 border-y border-border py-4">
          <Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="筛选任务状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(taskLabels).map(function option([value, label]) { return <SelectItem key={value} value={value}>{label}</SelectItem>; })}</SelectContent></Select>
        </div>
        {visibleInstances.map(function instance({ tab, pane }) { return <Card key={pane.id} className="mt-3 p-4">
          <div className="flex flex-wrap items-center gap-3"><TerminalSquare className="size-4 text-muted" /><div className="min-w-40 flex-1"><p>终端 {pane.number}</p><p className="mt-1 break-all text-xs text-muted">{workspace.workspaces.find(function owner(group) { return group.id === tab.desktopWorkspaceId; })?.name} · {tab.name} · {pane.process === "shell" ? "Shell 在线" : pane.process === "exited" ? "终端已退出" : "终端未就绪"}</p></div><Button variant="outline" size="sm" onClick={function reveal() { void locate(tab, pane); }}>定位终端<ArrowRight /></Button></div>
          <p className="mt-3 text-xs text-muted">{pane.observation}</p>
          {!pane.aps?.length && !pane.agents?.length && <p className="mt-3 text-xs text-muted">尚无可靠智能体事件 · 状态待确认</p>}
          {pane.agents?.map(function agentRow(value) { const status = hostConnected ? value.status : "unknown"; return <div key={value.instanceId} className="mt-3 flex items-center gap-2 rounded-md border border-border p-3"><AgentLogo agent={value.agent} /><span>{agentNames[value.agent]}</span><span className="text-xs text-muted">{value.observation === "disabled" ? "观察已禁用" : value.observation === "pending" ? "等待事件 / 检查原生 hook 信任" : "观察已接入"}</span><Badge variant={statusVariants[status]}>{agentStatusLabels[status]}</Badge>{value.exited && <Badge>CLI 已退出</Badge>}</div>; })}
          {pane.aps?.map(function apRow(ap) {
            const states = ap.sessions.map(function state(session) { return sessionTask(ap, session); });
            return <details key={ap.apInstanceId} className="mt-3 rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm"><span className="mr-2 inline-flex"><AgentLogo agent="ap" /></span>AP {ap.apInstanceId.slice(0, 8)} · {ap.workspace?.displayName ?? "等待工作区确认"} · {ap.connection === "exited" ? "AP 已退出" : ap.connection === "connected" ? ap.lifecycle === "starting" ? "启动中 / 等待工作区确认" : "已连接" : ap.connection === "syncing" ? "状态同步中" : "连接中断 / 状态待确认"} · 运行 {states.filter(function running(state) { return state === "running"; }).length} / 待处理 {states.filter(function waiting(state) { return ["waiting", "answering", "recovering", "recovery_failed"].includes(state); }).length} / 未知 {states.filter(function unknown(state) { return state === "unknown"; }).length}</summary>
              {!ap.sessions.length && <p className="mt-3 text-xs text-muted">会话状态待同步</p>}
              {ap.sessions.map(function sessionRow(session) {
                const status = sessionTask(ap, session);
                if (filter !== "all" && filter !== status) return null;
                return <div key={session.sessionId} className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs"><span>会话 {session.sessionId.slice(0, 8)}{session.turnId ? ` / Turn ${session.turnId.slice(0, 8)}` : ""}</span>{session.selected && <Badge variant="accent">当前选择</Badge>}<Badge>{session.relation === "locallyDriven" ? "本进程驱动过" : session.relation === "opened" ? "已打开" : "关联观察"}</Badge><Badge variant={statusVariants[status]}>{taskLabels[status]}</Badge>{session.waiting === "threads" && <Badge>等待子任务</Badge>}{status === "unknown" && session.result && <span className="text-muted">最后结果 {session.result}</span>}</div>;
              })}
            </details>;
          })}
        </Card>; })}
        {!visibleInstances.length && <Card className="mt-5"><CardHeader><p className="text-muted">{instances.length ? "没有符合筛选条件的终端。" : "暂无受管终端。"}</p></CardHeader></Card>}
      </section>
      {workspace.tabs.map(function workbench(tab) {
        const visible = page === "terminal" && !orchestrationMode && workspace.activeTab === tab.id;
        return <section key={tab.id} className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-label={`${tab.name} 工作台`}>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2"><h1 className="mr-auto font-semibold">Parallel</h1>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm"><PanelsTopLeft />布局 / 新增方向<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={function horizontal() { void command({ type: "arrange", tabId: tab.id, axis: "row" }); }}><Columns2 />左右排列</DropdownMenuItem>
              <DropdownMenuItem onSelect={function grid() { void command({ type: "arrange", tabId: tab.id, axis: "column" }); }}><Grid2X2 />网格排列</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={picking} onSelect={function right() { void addTerminal(tab, "row"); }}><ArrowRight />向右新增</DropdownMenuItem>
              <DropdownMenuItem disabled={picking} onSelect={function down() { void addTerminal(tab, "column"); }}><ArrowDown />向下新增</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu>
            <Button size="sm" disabled={picking} onClick={function add() { void addTerminal(tab, window.innerWidth >= 1100 ? "row" : "column"); }}><Plus />终端</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!tab.layout ? <Card className="flex h-full min-h-64 flex-col items-center justify-center gap-4 border-dashed p-6"><TerminalSquare className="size-8 text-muted" /><p className="text-muted">空白工作台</p><Button disabled={picking} onClick={function first() { void addTerminal(tab, "row"); }}><Plus />添加第一个终端</Button></Card> : <div className="h-full min-h-64 min-w-0 max-[1099px]:h-auto">{tab.expanded ? renderPane(tab, tab.expanded) : <LayoutView layout={tab.layout} renderPane={function pane(id) { return renderPane(tab, id); }} onResizing={setResizing} onRatio={function ratio(path, value) { return command({ type: "ratio", tabId: tab.id, path, ratio: value }); }} />}</div>}
          </div>
          <footer className="flex shrink-0 flex-wrap gap-3 border-t border-border px-3 py-2 text-xs text-muted"><span className="min-w-0 flex-1 truncate" title={activeGroup?.directory}>当前工作区 · {activeGroup?.directory ?? "尚未选择"}</span><span>Shell 在线 {tab.panes.filter(function online(pane) { return pane.process === "shell"; }).length} / 共 {tab.panes.length}</span></footer>
        </section>;
      })}
      {page === "terminal" && orchestrationMode && <section className="min-h-0 min-w-0 flex-1 overflow-clip"><OrchestrationPanel key={activeGroup?.id} workspaceId={activeGroup?.id} run={openRun} runs={orchestration.runs.filter(function own(run) { return run.workspaceId === activeGroup?.id; })} command={orchestrationCommand} layout={openRun && currentLayouts.get(managedLayoutKey(openRun))} changeLayout={changeManagedLayout} browserResizing={browserResizing} /></section>}
      {page === "terminal" && !orchestrationMode && !current && <div className="p-6"><Button onClick={newTab}><Plus />{activeGroup ? "在当前工作区新建 Tab" : "创建工作区"}</Button></div>}
    </div>
    {activeGroup && <BrowserPane key={activeGroup.id} workspaceId={activeGroup.id} visible={page === "terminal"} ratio={browserRatios[activeGroup.id] ?? 0.5} onRatio={resizeBrowser} onResizing={setBrowserResizing} />}
    </div>
  </main>{!workspace.ui.onboardingComplete && <ThemeWelcome ui={workspace.ui} command={command} />}
  <Dialog open={!!orchestrationAgentNotice} onOpenChange={function dismiss(open) { if (!open) setOrchestrationAgentNotice(undefined); }}><DialogContent><DialogTitle className="font-semibold">编排智能体已切换</DialogTitle><DialogDescription className="mt-2 text-sm text-muted">编排模式目前仅支持 AP，已从{orchestrationAgentNotice && agentNames[orchestrationAgentNotice]}切换为 AP。</DialogDescription><div className="mt-4 flex justify-end"><Button onClick={function confirm() { setOrchestrationAgentNotice(undefined); }}>继续</Button></div></DialogContent></Dialog>
  {orchestration.runs.filter(function actionable(run) { return run.current && run.connected && !run.accepted && !run.needsRecovery; }).flatMap(function pending(run) {
    return run.batches.filter(function complete(batch) { return batch.state === "pending" && batch.tasks.length > 0 && batch.tasks.length === batch.assignmentIds.length; }).map(function confirmation(batch) {
      return <OrchestrationBatchConfirmation key={run.id + ":" + batch.planVersion + ":" + batch.digest} run={run} batch={batch} command={orchestrationCommand} />;
    });
  })}<CloseDialog /><DesktopNotifications ui={workspace.ui} /></TooltipProvider>;
}

let initialWorkspace: Workspace;
let currentAppearance = { theme: "dark" as "light" | "dark", focused: false };
/** 首屏数据与根主题准备后才展示；读取失败也先写固定错误再请求显示。 */
async function startRenderer() {
  let prepared = false;
  try {
    initialWorkspace = await window.autopilotDesktop.getWorkspace(); console.log(initialWorkspace);
    const res = await window.autopilotDesktop.getAppearance(); console.log(res);
    currentAppearance = res;
    document.documentElement.dataset.theme = res.theme;
    const unsubscribe = window.autopilotDesktop.onAppearance(function appearance(value) { currentAppearance = value; document.documentElement.dataset.theme = value.theme; });
    window.addEventListener("unload", unsubscribe, { once: true });
    prepared = true;
  } catch {
    document.documentElement.dataset.theme ??= "dark";
    document.getElementById("root")!.textContent = "工作台连接失败，请重新打开 Desktop。";
  }
  try {
    const res = await window.autopilotDesktop.showMainWindow(); console.log(res);
    if (prepared) createRoot(document.getElementById("root")!).render(<App />);
  } catch { document.getElementById("root")!.textContent = "工作台连接失败，请重新打开 Desktop。"; }
}
void startRenderer();
