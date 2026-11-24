// Electron 主进程拥有宿主能力，renderer 仅通过固定 preload 接口访问启动摘要。
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import { BOOTSTRAP_CHANNEL, PARALLEL_CHANNEL, type AgentInstallations } from "./contract";
import { getDesktopBootstrap } from "./host";
import { isBootstrapRequestAllowed, isTerminalRequest, isWorkspaceCommand } from "./ipc-policy";
import { notificationBounds } from "./notification-layout";
import type { NotificationPosition } from "./ui-preferences";
import { resolvedTheme } from "./ui-preferences";
import { ParallelHost } from "./parallel-host";
import { ManagedTerminalHost } from "./managed-terminal-host";
import { OrchestrationDesktop } from "./orchestration-desktop";
import { OrchestrationBrowser } from "./orchestration-browser";
import { ORCHESTRATION_CHANNEL, ORCHESTRATION_CHANGED } from "./orchestration-contract";
import { ApStatusHost } from "./ap-status-host";
import { AgentStatusHost } from "./agent-status-host";
import { checkAgentInstallation, getAgentInstallation, prepareAgentIntegration } from "./agent-integration";
import { CloseConfirmationHost } from "./close-confirmation";
import { BrowserHost } from "./browser-host";
import { BrowserAccess } from "./browser-access";
import { browserSkillStatus, installBrowserSkill } from "./browser-skills";
import { browserDriverPath, browserDriverReason, BROWSER_DRIVER_VERSION } from "./browser-driver";
import { BrowserServer } from "./browser-server";
import { BROWSER_CHANNEL, isBrowserBounds, isBrowserCommand } from "./browser-contract";
import { isBrowserPreferences } from "./browser-history";
import { prepareShell, resolveCliRuntime, shellSpec, spawnPty, stopPty, resizePty, preparePtyResize } from "./terminal-host";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const rendererUrl = new URL(MAIN_WINDOW_WEBPACK_ENTRY).href;
let host: ParallelHost;
let orchestration: OrchestrationDesktop;
let controllerTerminals: ManagedTerminalHost;
let statusHost: ApStatusHost;
let agentStatusHost: AgentStatusHost;
let browserHost: BrowserHost;
let browserAccess: BrowserAccess;
let browserServer: BrowserServer;
let quitting = false;
let quitPending = false;
let pickerPending = false;
let clipboardWrites: Promise<void> = Promise.resolve();
let getAgentInstallations: () => Promise<AgentInstallations>;
const closeConfirmation = new CloseConfirmationHost();

/** 主进程生成确认文案与身份，Mac 无窗口 Quit 时先恢复所属视图。 */
async function confirmClose(message: string, detail: string, confirmLabel?: string): Promise<boolean> {
  if (!BrowserWindow.getAllWindows().some(function main(window) { return !window.getParentWindow(); })) await createWindow();
  const owner = BrowserWindow.getAllWindows().find(function main(window) { return !window.getParentWindow(); })!;
  owner.show();
  owner.focus();
  return closeConfirmation.request(message, detail, confirmLabel);
}

/** 创建隔离窗口并阻止新窗口和页面跳转。 */
async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromDataURL(require("./assets/autopilot.png"));
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Autopilot Desktop",
    icon,
    webPreferences: { preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  browserHost.bind(window);
  /** Electron 是系统主题与应用前台状态的唯一权威，不读取 renderer 媒体查询。 */
  function appearance() {
    const mode = host.snapshot().ui.theme;
    if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
    return { theme: resolvedTheme(mode, nativeTheme.shouldUseDarkColors), focused: !window.isMinimized() && window.isFocused() };
  }
  /** 手动选择或系统变化只更新外壳，不改终端与网页实例。 */
  function publishAppearance() {
    const value = appearance();
    window.setBackgroundColor(value.theme === "dark" ? "#0A0A0A" : "#FAFAF9");
    window.webContents.send("desktop:appearance", value);
  }
  nativeTheme.on("updated", publishAppearance);
  window.on("focus", publishAppearance);
  window.on("blur", publishAppearance);
  window.on("minimize", publishAppearance);
  window.on("restore", publishAppearance);
  window.on("closed", function disposeAppearance() { nativeTheme.removeListener("updated", publishAppearance); });
  const notificationWindows = new Map<NotificationPosition, BrowserWindow>();
  const notificationHeights = new Map<NotificationPosition, number>();
  /** 两个固定位置各自承载队列，不覆盖另一组卡片或抢普通提示焦点。 */
  function positionNotifications() {
    for (const [position, child] of notificationWindows) if (!child.isDestroyed()) child.setBounds(notificationBounds(window.getContentBounds(), notificationHeights.get(position) ?? 1, position));
  }
  /** 导航或渲染进程退出时同步回收通知窗口，旧审批不残留。 */
  function closeNotifications() { for (const child of notificationWindows.values()) child.destroy(); notificationWindows.clear(); }
  window.on("move", positionNotifications);
  window.on("resize", positionNotifications);
  ipcMain.removeHandler(BROWSER_CHANNEL);
  /** 浏览器只能由主控制页顶层 frame 调用，受管网站不共享 preload 或来源权限。 */
  ipcMain.handle(BROWSER_CHANNEL, async function browser(event, method: unknown, ...args: unknown[]) {
    if (!isBootstrapRequestAllowed(event.sender.id, window.webContents.id, event.senderFrame === window.webContents.mainFrame, event.senderFrame?.url ?? "", rendererUrl, 0)) throw new Error("DESKTOP_IPC_DENIED");
    if (method === "snapshot" && args.length === 1 && args[0] === host.activeWorkspaceId()) return { ...browserHost.snapshot(), approvals: browserAccess.snapshot() };
    if (method === "answerApproval" && args.length === 2 && typeof args[0] === "string" && ["once", "always", "deny"].includes(args[1] as string)) return browserAccess.answer(args[0], args[1] as "once" | "always" | "deny");
    if (method === "integration" && args.length === 0) {
      let available = false;
      let reason: string | undefined;
      try { await browserDriverPath(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources")); available = true; } catch (error) { reason = browserDriverReason(error); }
      return { driver: { version: BROWSER_DRIVER_VERSION, available, reason }, skills: await browserSkillStatus() };
    }
    if (method === "installSkill" && args.length === 1 && ["agents", "claude", "codebuddy"].includes(args[0] as string)) return installBrowserSkill(args[0] as "agents" | "claude" | "codebuddy");
    if (method === "settings" && args.length === 0) return browserHost.settings();
    if (method === "preferences" && args.length === 1 && isBrowserPreferences(args[0])) return browserHost.preferencesUpdate(args[0]);
    if (method === "clearHistory" && args.length === 0) return browserHost.clearHistory();
    if (method === "chooseDownloadDirectory" && args.length === 0) return browserHost.chooseDownloadDirectory();
    if (method === "command" && args.length === 2 && args[1] !== null && args[1] === host.activeWorkspaceId() && isBrowserCommand(args[0])) return browserHost.command(args[0], args[1] as string);
    if (method === "bounds" && args.length === 2 && args[1] === host.activeWorkspaceId() && isBrowserBounds(args[0])) { browserHost.layout(args[0], args[1] as string | null); return; }
    throw new Error("DESKTOP_IPC_DENIED");
  });
  /** 项目链接仅交给系统浏览器；应用内仍仅允许本地通知专用空白子窗口。 */
  window.webContents.setWindowOpenHandler(function openNotificationWindow(details) {
    if (["https://github.com/C-Clay-W/autopilot", "https://www.npmjs.com/package/autopilot-agent"].includes(details.url)) {
      void shell.openExternal(details.url).catch(function reportProjectLinkError() { dialog.showErrorBox("打开链接失败", "无法打开系统浏览器，请稍后重试。"); });
      return { action: "deny" };
    }
    if (details.url !== "about:blank" || !["desktop-notifications-center", "desktop-notifications-bottom-right"].includes(details.frameName)) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { parent: window, frame: false, transparent: true, backgroundColor: "#00000000", show: false, skipTaskbar: true, hasShadow: false, resizable: false, movable: false, closable: false, minimizable: false, maximizable: false, fullscreenable: false, width: 400, height: 1 } };
  });
  /** React Portal 保留原回调与审批身份，子窗口不获得宿主 IPC 权限。 */
  window.webContents.on("did-create-window", function notificationCreated(child, details) {
    const position: NotificationPosition = details.frameName === "desktop-notifications-center" ? "center" : "bottom-right";
    notificationWindows.set(position, child);
    child.setMenu(null);
    child.webContents.setWindowOpenHandler(function denyNewWindow() { return { action: "deny" }; });
    child.webContents.on("will-navigate", function denyNavigation(event) { event.preventDefault(); });
    child.on("closed", function forgetNotificationWindow() { if (notificationWindows.get(position) === child) notificationWindows.delete(position); });
    positionNotifications();
  });
  // 页面不能切换到新的导航目标。
  window.webContents.on("will-navigate", function denyNavigation(event) { event.preventDefault(); });
  // preload 失败写到主进程日志，避免开发终端看不到桥接加载错误。
  window.webContents.on("preload-error", function reportPreloadError(_event, _path, error) {
    console.error("Desktop preload failed", error);
  });
  ipcMain.removeHandler(BOOTSTRAP_CHANNEL);
  // 只向当前主窗口顶层 frame 提供安全摘要。
  ipcMain.handle(BOOTSTRAP_CHANNEL, function readBootstrap(event, ...args: unknown[]) {
    if (!isBootstrapRequestAllowed(event.sender.id, window.webContents.id, event.senderFrame === window.webContents.mainFrame, event.senderFrame?.url ?? "", rendererUrl, args.length)) {
      throw new Error("DESKTOP_IPC_DENIED");
    }
    return getDesktopBootstrap(app.getVersion());
  });
  ipcMain.removeHandler(PARALLEL_CHANNEL);
  ipcMain.removeHandler(ORCHESTRATION_CHANNEL);
  const unsubscribeOrchestration = orchestration.subscribe(function changed(sessionId) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(ORCHESTRATION_CHANGED, sessionId);
  });
  window.once("closed", unsubscribeOrchestration);
  /** 只有主控制页能提交固定编排动作，不向网页暴露调用者身份或启动参数。 */
  ipcMain.handle(ORCHESTRATION_CHANNEL, async function managed(event, method: unknown, ...args: unknown[]) {
    if (!isBootstrapRequestAllowed(event.sender.id, window.webContents.id, event.senderFrame === window.webContents.mainFrame, event.senderFrame?.url ?? "", rendererUrl, 0)) throw new Error("DESKTOP_IPC_DENIED");
    try {
      if (method === "terminal" && args.length >= 2 && typeof args[0] === "string" && host.snapshot().workspaces.some(function same(w) { return w.id === args[0] && w.mode === "orchestration"; })) {
        const [workspaceId, operation, generation, a, b, location] = args;
        if (operation === "ensure" && args.length <= 4 && (generation === undefined || typeof generation === "string" && /^[\w-]{1,128}$/u.test(generation))
          && (a === undefined || typeof generation === "string" && typeof a === "string" && /^[\w-]{1,128}$/u.test(a))) return controllerTerminals.ensure(workspaceId as string, generation, a as string | undefined);
        if (operation === "closeView" && args.length === 4 && typeof generation === "string" && /^[\w-]{1,128}$/u.test(generation)
          && Array.isArray(a) && a.length > 0 && a.length <= 1000 && new Set(a).size === a.length
          && a.every(function view(id) { return typeof id === "string" && /^[\w-]{1,128}$/u.test(id); })) return await controllerTerminals.closeViews(workspaceId as string, generation, a);
        if (typeof operation === "string" && Number.isSafeInteger(generation) && args.length <= 6 && (location === undefined || typeof location === "string" && /^[\w:-]{1,257}$/u.test(location))) return controllerTerminals.io(workspaceId as string, generation as number, operation, a, b, location);
      }
      if (method === "snapshot") {
        const [reconcile, sessions] = args;
        const validSessions = Array.isArray(sessions) && sessions.length <= 64 && sessions.every(function exact(id) { return typeof id === "string" && /^[\w-]{1,128}$/u.test(id); });
        if (args.length <= 2 && (reconcile === undefined || typeof reconcile === "boolean") && (sessions === undefined || reconcile === false && validSessions)) return await orchestration.snapshot(reconcile, sessions as string[] | undefined);
      }
      if (method === "command" && args.length === 1) {
        const command = args[0] as import("./orchestration-contract").OrchestrationUiCommand;
        // 直接恢复只由原受管 CLI 接纳；图形交互在原决定确认后由宿主续跑。
        if ((command?.type === "controller" || command?.type === "control") && command.operation === "resume") throw new Error("DESKTOP_IPC_DENIED");
        if (command && (command.type === "newTask" || command.type === "selectRun") && typeof command.workspaceId === "string") {
          await controllerTerminals.switchRun(command.workspaceId, function change() { return orchestration.command(command); });
        } else await orchestration.command(args[0]);
        return;
      }
      throw new Error("DESKTOP_IPC_DENIED");
    } catch (error) { throw new Error(error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message) ? error.message : "ORCHESTRATION_OPERATION_FAILED"); }
  });
  /** 所有固定方法复用已有窗口、frame 与完整 URL 来源校验。 */
  ipcMain.handle(PARALLEL_CHANNEL, async function parallel(event, method: unknown, ...args: unknown[]) {
    if (!isBootstrapRequestAllowed(event.sender.id, window.webContents.id, event.senderFrame === window.webContents.mainFrame, event.senderFrame?.url ?? "", rendererUrl, 0)) throw new Error("DESKTOP_IPC_DENIED");
    if (method === "workspace" && (args.length === 0 || args.length === 2 && typeof args[0] === "string" && /^[0-9a-f-]{36}$/.test(args[0]) && Number.isSafeInteger(args[1]) && (args[1] as number) >= 0)) return host.snapshotPage(args[0] as string | undefined, args[1] as number | undefined);
    if (method === "showMainWindow" && args.length === 0) { window.show(); return; }
    if (method === "appearance" && args.length === 0) { const value = appearance(); window.setBackgroundColor(value.theme === "dark" ? "#0A0A0A" : "#FAFAF9"); return value; }
    if (method === "agentInstallations" && args.length === 0) return getAgentInstallations();
    if (method === "closeConfirmation" && args.length === 0) return closeConfirmation.snapshot();
    if (method === "answerClose" && args.length === 2 && typeof args[0] === "string" && /^[0-9a-f-]{36}$/.test(args[0]) && typeof args[1] === "boolean") return closeConfirmation.answer(args[0], args[1]);
    if (method === "copyTerminalText" && args.length === 1 && typeof args[0] === "string" && args[0].length <= 4 * 1024 * 1024) {
      const text = args[0];
      // 异步写入与读回串行完成，避免不同终端的复制请求交错。
      const copied = clipboardWrites.then(async function copySelection() {
        try {
          await clipboard.writeText(text);
          // Windows 剪贴板竞争可能静默失败，读回确认且不向页面返回内容。
          if (await clipboard.readText() !== text) throw new Error("DESKTOP_CLIPBOARD_WRITE_FAILED");
        } catch { throw new Error("DESKTOP_CLIPBOARD_WRITE_FAILED"); }
      });
      clipboardWrites = copied.catch(function continueCopyQueue() {});
      return copied;
    }
    if (method === "notificationHeight" && args.length === 2 && ["center", "bottom-right"].includes(args[0] as string) && Number.isSafeInteger(args[1]) && (args[1] as number) > 0 && (args[1] as number) <= 32768) {
      const position = args[0] as NotificationPosition;
      notificationHeights.set(position, args[1] as number);
      positionNotifications();
      const child = notificationWindows.get(position);
      if (!window.isMinimized() && window.isVisible() && child && !child.isDestroyed()) { child.showInactive(); return true; }
      return false;
    }
    if (method === "pick" && args.length === 0) {
      if (pickerPending) return null;
      pickerPending = true;
      try {
        const selected = await dialog.showOpenDialog(window, { title: "选择默认工作区", properties: ["openDirectory"] });
        return selected.canceled || !selected.filePaths[0] ? null : await host.registerDirectory(selected.filePaths[0]);
      } finally { pickerPending = false; }
    }
    if (method === "command" && args.length === 1 && isWorkspaceCommand(args[0])) {
      await host.command(args[0]); if (args[0].type === "uiPreference") publishAppearance(); return;
    }
    if (method === "prepareResize" && isTerminalRequest(args, "resize")) return preparePtyResize(host.session(args[0] as string, args[1] as number), args[2] as number, args[3] as number);
    if ((method === "read" || method === "write" || method === "resize") && isTerminalRequest(args, method)) {
      const terminal = host.session(args[0] as string, args[1] as number);
      if (method === "read") return terminal.output.read(args[2] as number);
      if (terminal.exited) throw new Error("终端已退出。");
      if (method === "write") {
        if (args[2] === "\x03" || args[2] === "\x1b") agentStatusHost.inputUncertain(args[0] as string, args[1] as number);
        terminal.pty.write(args[2] as string);
      }
      else resizePty(terminal, args[2] as number, args[3] as number);
      return;
    }
    throw new Error("DESKTOP_IPC_DENIED");
  });
  /** Windows 关窗走应用退出确认，Mac 只销毁窗口并保留受管 PTY。 */
  let browserClosed = false;
  let closingBrowser = false;
  window.on("close", function closeWindow(event) {
    if (process.platform !== "darwin" && !quitting) { event.preventDefault(); app.quit(); return; }
    if (process.platform === "darwin" && !quitting && !browserClosed) {
      event.preventDefault();
      if (closingBrowser) return;
      closingBrowser = true;
      void browserHost.confirmExit().then(async function confirmed(confirmed) { if (confirmed) { await browserHost.clear(); browserClosed = true; window.close(); } }).catch(function failed() { console.error("Browser cleanup failed"); }).finally(function done() { closingBrowser = false; });
    }
  });
  // 页面刷新或丢失时取消尚未回答的确认，避免宿主队列永久等待。
  window.webContents.on("did-start-navigation", function cancelNavigation(_event, _url, _inPlace, mainFrame) { if (mainFrame) { closeNotifications(); closeConfirmation.cancel(); browserHost.layout({ x: 0, y: 0, width: 0, height: 0, hidden: true }); } });
  window.webContents.on("render-process-gone", function cancelCrashedConfirmation() { closeNotifications(); closeConfirmation.cancel(); browserHost.layout({ x: 0, y: 0, width: 0, height: 0, hidden: true }); });
  window.on("closed", function cancelClosedConfirmation() { closeConfirmation.cancel(); });
  await window.loadURL(rendererUrl);
}

/** 就绪后禁止页面权限请求，再创建唯一主窗口。 */
async function startDesktop(): Promise<void> {
  browserHost = new BrowserHost(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), function save(data) { return host.saveBrowser(data); });
  browserAccess = new BrowserAccess({ preferences: function preferences() { return browserHost.settings(); }, prepare: function prepare(principal, operation) { return browserHost.prepare(principal, operation); }, target: function target(operation, principal) { return browserHost.target(operation, principal); }, execute: function execute(principal, turnId, operation, signal) { return browserHost.agentRequest(principal, turnId, operation, signal); }, release: function release(principal, turnId) { return browserHost.endTurn(principal, turnId); } });
  browserHost.onPermissionTightened = function tighten() { browserAccess.tighten(); };
  browserHost.onTakeover = function takeover(pageId) { browserAccess.revokePage(pageId); };
  browserHost.onClear = function clear() { return browserAccess.clear(); };
  /** 下载退出沿用同一宿主确认身份，先完成此卡再进入终端关闭确认。 */
  browserHost.onConfirmExit = async function confirmDownloads() {
    if (closeConfirmation.snapshot()) return false;
    try { return await closeConfirmation.request("仍有下载正在进行", "继续退出会取消未完成的下载。取消退出可继续等待下载。", "取消下载并继续退出"); }
    finally { closeConfirmation.finish(); }
  };
  browserServer = new BrowserServer(browserAccess);
  await browserServer.start();
  // 运行时只解析一次；失败清除缓存，让用户补齐 Node 后能重试目标窗格。
  let launch: ReturnType<typeof resolveCliRuntime> | undefined;
  let integration: ReturnType<typeof prepareAgentIntegration> | undefined;
  /** 检测与启动复用同一运行时和包装入口，失败后允许重试。 */
  async function agentRuntime() {
    launch ??= resolveCliRuntime(app.getAppPath(), process.resourcesPath, app.isPackaged);
    try {
      const runtime = await launch;
      integration ??= prepareAgentIntegration(app.getPath("userData"), runtime.node).catch(function retryIntegration(error) { integration = undefined; throw error; });
      return { ...runtime, runner: await integration };
    } catch (error) { launch = undefined; throw error; }
  }
  /** 并行检查固定四种 CLI，运行时异常统一表达为检测失败。 */
  getAgentInstallations = async function detectInstallations() {
    try {
      const { node, runner } = await agentRuntime();
      const entries = await Promise.all((["claude", "codex", "opencode", "codebuddy"] as const).map(async function detect(agent) { return [agent, await getAgentInstallation(node, runner, agent)] as const; }));
      return Object.fromEntries(entries) as AgentInstallations;
    } catch { return { claude: "error", codex: "error", opencode: "error", codebuddy: "error" }; }
  };
  const bootstrap = await prepareShell(app.getPath("userData"));
  statusHost = new ApStatusHost(function statusChanged() { host?.statusChanged(); });
  await statusHost.start();
  agentStatusHost = new AgentStatusHost(function statusChanged() { host?.statusChanged(); });
  await agentStatusHost.start();
  host = new ParallelHost(join(app.getPath("userData"), "parallel-layout.json"), {
    status: statusHost,
    agents: agentStatusHost,
    browser: browserServer,
    browserWorkspaceChanged: function browserWorkspaceChanged(active, workspaces) { return browserHost.setWorkspaces(active, workspaces); },
    spawn: spawnPty, stop: stopPty, confirm: confirmClose,
    confirmationFinished: function finishConfirmation() { closeConfirmation.finish(); },
    hasWorkingTurn: function hasWorkingTurn(id) { return orchestration.hasWorkingTurn(id); },
    removeWorkspace: function removeWorkspace(id, stopTerminals) { return orchestration.removeWorkspace(id, async function stop() { await Promise.all([stopTerminals(), controllerTerminals.reset(id)]); }); },
    /** 在明确兼容的独立 Node 中运行 CLI，普通 ap 退出不影响交互 shell。 */
    launch: async function launchShell(agent) {
      try {
        const runtime = await agentRuntime();
        if (agent !== "shell") await checkAgentInstallation(runtime.node, runtime.runner, agent);
        return shellSpec(process.platform, runtime.node, runtime.cli, bootstrap, { ...process.env, AUTOPILOT_AGENT_RUNNER: runtime.runner });
      } catch (error) {
        if (agent !== "shell") throw error;
        console.warn("Desktop CLI 运行时不可用，空白终端仅提供系统命令。", error);
        return shellSpec(process.platform, null, "", bootstrap, process.env);
      }
    },
  });
  const orchestrationBrowser = new OrchestrationBrowser(browserAccess);
  orchestration = new OrchestrationDesktop(join(app.getPath("userData"), "orchestration"), function workspaces() { return host.snapshot().workspaces; }, async function launchManaged(channel, checkout, stateRoot) {
    const runtime = await agentRuntime();
    await channel.start(join(__dirname, "orchestration-worker.cjs"), { execPath: runtime.node, execArgv: [], env: { AUTOPILOT_MANAGED_WORKSPACE: checkout, AUTOPILOT_MANAGED_STATE: stateRoot } });
  }, app.getVersion(), function defaultPermission() { return host.snapshot().defaultApPermission; }, orchestrationBrowser);
  controllerTerminals = new ManagedTerminalHost(async function launchController(env) {
    const runtime = await agentRuntime();
    const environment = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(function defined(entry): entry is [string, string] { return typeof entry[1] === "string"; }));
    // 仅编排主控固定采用 CLI 无彩色模式。
    environment.NO_COLOR = "1"; environment.CLICOLOR = "0"; delete environment.FORCE_COLOR;
    return spawnPty(runtime.node, [runtime.cli, "managed-attach"], { name: "xterm-256color", cols: 100, rows: 30, env: environment });
  }, function controllerRequest(workspaceId, frame, runId, target, isCurrent) { return orchestration.terminalRequest(workspaceId, frame, runId, target, isCurrent); }, {
    selected: function selected(workspaceId) { return orchestration.selectedTerminalRunId(workspaceId); },
    executor: function executor(workspaceId, runId, assignmentId) { return orchestration.executorTerminalTarget(workspaceId, runId, assignmentId); },
    prepareClose: function prepareClose(workspaceId, runId, targets, remaining, isCurrent, lastRecorded) {
      return orchestration.prepareViewsClose(workspaceId, runId, targets, remaining, isCurrent, async function confirm() {
        const browser = targets.some(function primary(target) { return target.id === "controller"; }) ? "关闭主控视图会撤销已附着的浏览器许可及在途浏览器动作。" : "";
        const confirmed = await confirmClose("关闭正在执行的终端视图？", "任务会继续执行。执行者先保存当前真实进度，保存期间仍可使用原终端处理审批、回答和收尾。" + browser, "确认关闭视图");
        if (confirmed) closeConfirmation.finish();
        return confirmed;
      }, lastRecorded);
    },
    ready: function ready(workspaceId, runId) { orchestrationBrowser.connect(workspaceId, runId); },
    closed: function closed(workspaceId) { orchestrationBrowser.disconnect(workspaceId); },
  });
  const removedNavigation = await orchestration.store.restoreRemovedNavigation();
  const { runs } = await orchestration.store.read();
  const retained = new Set(runs.filter(function visible(run) { return !run.navigationRemoved; }).map(function workspace(run) { return run.workspaceId; }));
  const removed = new Set(runs.filter(function hidden(run) { return run.navigationRemoved && !retained.has(run.workspaceId); }).map(function workspace(run) { return run.workspaceId; }));
  await host.initialize([...retained], new Set([...removedNavigation, ...removed]));
  orchestration.restoreApprovalWork(runs);
  await browserHost.setWorkspaces(host.snapshot().activeWorkspace, host.snapshot().workspaces);
  browserHost.restore(host.snapshot().browser);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    process.platform === "darwin" ? { role: "appMenu" } : { role: "fileMenu" },
    { role: "editMenu" },
    ...(!app.isPackaged ? [{ role: "viewMenu" as const }] : []),
  ]));
  // 页面申请系统权限时直接拒绝。
  session.defaultSession.setPermissionRequestHandler(function denyPermission(_contents, _permission, callback) { callback(false); });
  // 同步权限检查沿用拒绝策略。
  session.defaultSession.setPermissionCheckHandler(function denyPermissionCheck() { return false; });
  await createWindow();
}

/** 初始化失败时记录诊断并正常退出。 */
function failStartup(error: unknown): void {
  console.error("Desktop startup failed", error);
  app.quit();
}

if (process.platform === "win32") app.setAppUserModelId("com.autopilot.desktop");
app.whenReady().then(startDesktop).catch(failStartup);
// 从 Dock 激活时重开已关闭的窗口。
app.on("activate", function activateDesktop() {
  if (!BrowserWindow.getAllWindows().some(function main(window) { return !window.getParentWindow(); })) void createWindow().catch(failStartup);
});
// macOS 关闭窗口后保留 Dock；系统 Quit、应用菜单与 ⌘Q 继续使用原生退出流程。
app.on("window-all-closed", function closeDesktop() {
  ipcMain.removeHandler(BOOTSTRAP_CHANNEL);
  ipcMain.removeHandler(PARALLEL_CHANNEL);
  ipcMain.removeHandler(BROWSER_CHANNEL);
  if (process.platform !== "darwin") app.quit();
});
// 显式 Quit 与 Windows 退出都先确认并收割，取消后保持原窗口和终端。
app.on("before-quit", function beforeQuit(event) {
  if (quitting || !host) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void browserHost.confirmExit().then(async function downloadsConfirmed(confirmed) {
    if (!confirmed) return false;
    if (orchestration.hasRuntime()) {
      try { if (!await confirmClose("退出编排宿主？", "退出会结束本应用的 AP 执行进程。任务与占用保留，重启后须核查再恢复；不会标记为完成。")) return false; }
      finally { closeConfirmation.finish(); }
    }
    return host.shutdown();
  }).then(async function finished(confirmed) {
    if (confirmed) { await controllerTerminals.close(); orchestration.close(); await browserHost.clear(); await browserServer.stop(); await statusHost.stop(); await agentStatusHost.stop(); quitting = true; app.quit(); }
  }).catch(function report(error) { console.error("Desktop shutdown failed", error); }).finally(function settled() { quitPending = false; });
});
