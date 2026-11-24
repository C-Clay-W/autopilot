// 工作台宿主串行拥有 Tab、PTY 身份及配置写入，renderer 导航与终端生命周期相互独立。
import { defaultUiPreferences } from "./ui-preferences";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getHeapStatistics } from "node:v8";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { IPty, IPtyForkOptions } from "node-pty";
import { arrange, isolateWorkspaceModes, emptyWorkspace, removePane, restoreWorkspace, savedWorkspace, setRatio, splitPane, summarizeAp, type TerminalType, type DesktopWorkspace, type Pane, type Tab, type Workspace, type WorkspaceCommand } from "./workspace";
import type { ApStatusHost } from "./ap-status-host";
import type { AgentStatusHost } from "./agent-status-host";
import type { BrowserServer } from "./browser-server";
import type { WorkspacePage } from "./contract";
import type { BrowserSaved } from "./browser-contract";
import { OutputBuffer, shellSpec, validDirectory, type TerminalSession, type LaunchSpec } from "./terminal-host";

export interface HostDependencies {
  status?: ApStatusHost;
  agents?: AgentStatusHost;
  browser?: BrowserServer;
  browserWorkspaceChanged?(active: string | null, workspaces: DesktopWorkspace[]): Promise<void>;
  launch(agent: TerminalType): Promise<LaunchSpec>;
  spawn(shell: string, args: string[], options: IPtyForkOptions): IPty;
  stop(session: TerminalSession): Promise<void>;
  confirm(message: string, detail: string, confirmLabel?: string): Promise<boolean>;
  confirmationFinished?(): void;
  hasWorkingTurn?(id: string): Promise<boolean>;
  removeWorkspace?(id: string, stopTerminals: () => Promise<void>): Promise<void>;
  directory?: typeof validDirectory;
}

/** 主进程单所有者，无跨窗口共享 renderer 状态或额外 daemon。 */
export class ParallelHost {
  private workspace: Workspace = emptyWorkspace();
  private navigationVersion = 0;
  private sessions = new Map<string, TerminalSession>();
  private retiring = new Set<TerminalSession>();
  private directories = new Set<string>();
  private submissions = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private quitting = false;
  private closes = new Map<string, Promise<Workspace>>();
  private shutdownPending?: Promise<boolean>;
  private snapshots = new Map<string, { revision: number; json: string; seen: number }>();
  constructor(private file: string, private dependencies: HostDependencies) {}

  /** 浏览器IPC只需导航身份，不复制全部终端状态。 */
  activeWorkspaceId(): string | null { return this.workspace.activeWorkspace; }

  /** 返回可序列化副本，调用方不能修改权威状态。 */
  snapshot(): Workspace {
    const snapshot = structuredClone(this.workspace);
    const tabNumbers = new Map<string, number>();
    for (const tab of snapshot.tabs) {
      const number = (tabNumbers.get(tab.desktopWorkspaceId) ?? 0) + 1;
      tabNumbers.set(tab.desktopWorkspaceId, number);
      tab.name = `${tab.directory ? basename(tab.directory) || tab.directory : "自由终端"} ${number}`;
    }
    if (this.dependencies.status && !this.dependencies.status.available()) snapshot.notice = "AP 状态连接不可用，终端仍可使用。";
    for (const tab of snapshot.tabs) tab.panes.forEach(function present(this: ParallelHost, pane: Pane, index: number) {
      // 当前 Tab 的显示序号独立于持久编号和 PTY 身份，关闭失败时自然按实际保留集合排列。
      pane.number = index + 1;
      pane.aps = this.dependencies.status?.snapshot(pane.id) ?? [];
      pane.agents = this.dependencies.agents?.snapshot(pane.id) ?? [];
      pane.observation = !this.dependencies.agents?.available() ? "第三方观察不可用" : "受管命令支持局部观察，Codex hooks 需在 /hooks 审核信任。可设置 AUTOPILOT_AGENT_OBSERVATION=off 禁用后重启 CLI。";
    }.bind(this));
    return snapshot;
  }
  /** 状态接收独立于关闭命令队列，只推进安全快照版本。 */
  statusChanged(): void { this.workspace.revision++; }
  /** 浏览器偏好与历史复用布局文件的单写队列，保存失败保留上一份数据。 */
  saveBrowser(value: BrowserSaved): Promise<void> {
    const result = this.queue.then(async function save(this: ParallelHost) {
      const previous = this.workspace.browser;
      this.workspace.browser = structuredClone(value);
      if (!await this.persist()) { this.workspace.browser = previous; throw new Error("浏览器设置保存失败，请检查应用数据目录权限。"); }
    }.bind(this));
    this.queue = result.catch(function keepQueue() {});
    return result;
  }
  /** 大规模快照按固定版本分块，单次 IPC 有界，过期请求重新获取而不混合版本。 */
  snapshotPage(snapshotId?: string, offset = 0): WorkspacePage {
    for (const [id, snapshot] of this.snapshots) if (Date.now() - snapshot.seen > 15000) this.snapshots.delete(id);
    if (!snapshotId) {
      if (this.snapshots.size >= 4) this.snapshots.delete(this.snapshots.keys().next().value!);
      const snapshot = this.snapshot();
      snapshotId = randomUUID();
      this.snapshots.set(snapshotId, { revision: snapshot.revision, json: JSON.stringify(snapshot), seen: Date.now() });
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || offset > snapshot.json.length) throw new Error("DESKTOP_SNAPSHOT_EXPIRED");
    snapshot.seen = Date.now();
    const chunk = snapshot.json.slice(offset, offset + 16000);
    const final = offset + chunk.length === snapshot.json.length;
    if (final) this.snapshots.delete(snapshotId);
    return { snapshotId, revision: snapshot.revision, offset, chunk, final };
  }

  /** 确认保留存活 Shell 边界，文案采用当前安全聚合。 */
  private closeDetail(targets: Pane[], quitting = false): string {
    const panes = targets.map(function current(this: ParallelHost, pane: Pane) { return { ...pane, aps: this.dependencies.status?.snapshot(pane.id) ?? [] }; }.bind(this));
    const counts = summarizeAp(panes);
    const agents = targets.flatMap(function observed(this: ParallelHost, pane: Pane) { return this.dependencies.agents?.snapshot(pane.id) ?? []; }.bind(this));
    const thirdRunning = agents.filter(function running(agent) { return !agent.exited && agent.status === "running"; }).length;
    const thirdWaiting = agents.filter(function waiting(agent) { return !agent.exited && agent.status === "waiting"; }).length;
    return `第三方运行实例 ${thirdRunning}，第三方待处理实例 ${thirdWaiting}。AP 执行中 ${counts.running}，待审批 ${counts.approval}，待回答 ${counts.answering}，已知未完成 ${counts.unfinished}，待确认任务 ${counts.unknown}，待确认实例 ${counts.uncertain}，未接入终端 ${counts.unavailable}。${quitting ? "退出将结束所有" : "确认将结束目标"}终端及其所属程序。`;
  }

  /** 目录选择成功只登记目录，不创建终端或提升 CLI 权限。 */
  async registerDirectory(path: string): Promise<{ path: string; name: string }> {
    const canonical = await (this.dependencies.directory ?? validDirectory)(path);
    this.directories.add(canonical);
    return { path: canonical, name: basename(canonical) || canonical };
  }

  /** 初始化只读取白名单布局，再为每个实际窗格创建新的生命周期。 */
  async initialize(runWorkspaces: string[] = [], removedWorkspaces: ReadonlySet<string> = new Set()): Promise<void> {
    try {
      const file = await stat(this.file);
      // 读取保护随当前可用堆容量变化，不把合法保存规模绑定为固定窗格配额。
      if (!file.isFile() || file.size > getHeapStatistics().total_available_size / 4) throw new Error("layout resource unavailable");
      this.workspace = restoreWorkspace(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.workspace.ui = defaultUiPreferences(true);
      // 无效配置原件先留副本，失败时不覆盖原件。
      try { await copyFile(this.file, `${this.file}.invalid-${Date.now()}`); }
      catch { throw new Error("布局读取失败且无法保留原件，请检查应用数据目录权限。"); }
      this.workspace.notice = "保存的布局无法读取，原文件已保留副本。";
      return;
    }
    // 编排删除先提交账本，布局写入前退出时也不重新挂载已移除的工作区。
    this.workspace.tabs = this.workspace.tabs.filter(function retain(tab) { return !removedWorkspaces.has(tab.desktopWorkspaceId); });
    for (const group of this.workspace.workspaces.filter(function removed(group) { return removedWorkspaces.has(group.id); })) this.removeWorkspaceNavigation(group);
    await this.isolateModes(runWorkspaces);
    for (const group of this.workspace.workspaces) this.directories.add(group.directory);
    for (const tab of this.workspace.tabs) {
      if (tab.directory) this.directories.add(tab.directory);
      for (const pane of tab.panes) await this.start(tab, pane);
    }
  }

  /** 启动时在发布 UI 前原子保存隔离结果；失败回退内存并保留原布局。 */
  async isolateModes(runWorkspaces: string[]): Promise<void> {
    const previous = structuredClone(this.workspace);
    try {
      if (!isolateWorkspaceModes(this.workspace, runWorkspaces)) return;
      await copyFile(this.file, `${this.file}.before-mode-isolation-${Date.now()}`);
      if (!await this.persist()) throw new Error("DESKTOP_MODE_MIGRATION_FAILED");
    } catch (error) { this.workspace = previous; throw error; }
  }

  /** 固定命令串行执行，关闭、重试与新增不会竞态覆盖身份。 */
  command(command: WorkspaceCommand): Promise<Workspace> {
    if (command.type === "activate" || command.type === "workspaceActivate") this.navigationVersion++;
    const navigationVersion = this.navigationVersion;
    const closeKey = command.type === "workspaceDelete" ? `workspace/${command.desktopWorkspaceId}` : command.type === "close" ? `${command.tabId}/${command.paneId ?? "*"}` : null;
    if (closeKey && this.closes.has(closeKey)) return this.closes.get(closeKey)!;
    const result = this.queue.then(async function apply(this: ParallelHost) {
      if (this.quitting) throw new Error("应用正在退出。");
      const previousUi = this.workspace.ui;
      const previousDefault = this.workspace.defaultAgent;
      const previousNewTerminal = this.workspace.newTerminal;
      const previousPermission = this.workspace.defaultApPermission;
      let applied: void | false = undefined;
      try { applied = await this.apply(command, navigationVersion); }
      finally {
        if (applied !== false) {
          const browserUpdate = this.dependencies.browserWorkspaceChanged?.(this.workspace.activeWorkspace, this.workspace.workspaces);
          if (command.type === "workspaceDelete") void browserUpdate?.catch(function failed() { console.warn("已删除工作区的浏览器资源收尾未确认。"); });
          else await browserUpdate;
          this.workspace.revision++;
          if (!await this.persist()) {
            if (command.type === "uiPreference") this.workspace.ui = previousUi;
            if (command.type === "preference") this.workspace.defaultAgent = previousDefault;
            if (command.type === "terminalPreference") this.workspace.newTerminal = previousNewTerminal;
            if (command.type === "apPermissionPreference") this.workspace.defaultApPermission = previousPermission;
          }
        }
      }
      return this.snapshot();
    }.bind(this));
    this.queue = result.catch(function keepQueue() {});
    if (closeKey) {
      this.closes.set(closeKey, result);
      const closes = this.closes;
      void result.finally(function releaseClose() { closes.delete(closeKey); }).catch(function alreadyReported() {});
    }
    return result;
  }

  /** 查找目标 Tab，迟到或伪造身份不落到其他对象。 */
  private tab(id: string): Tab {
    const tab = this.workspace.tabs.find(function matches(item) { return item.id === id; });
    if (!tab) throw new Error("目标 Tab 已关闭。");
    return tab;
  }

  /** 只接受主进程 picker 或保存布局登记过的目录，并重新检查可用性。 */
  private async directory(path: string | null): Promise<string> {
    if (!path || !this.directories.has(path)) throw new Error("请先选择默认工作区。");
    return (this.dependencies.directory ?? validDirectory)(path);
  }

  /** 新增稳定编号，先登记视图再启动 shell，失败只归属于目标窗格。 */
  private async add(tab: Tab, axis: "row" | "column", agent: TerminalType, apPermission = this.workspace.defaultApPermission): Promise<void> {
    const pane: Pane = { id: randomUUID(), number: tab.nextNumber++, agent, apPermission, generation: 0, process: "starting", task: "unknown" };
    tab.panes.push(pane);
    tab.layout = splitPane(tab.layout, tab.focused, pane.id, axis);
    tab.focused = pane.id;
    this.workspace.revision++;
    await this.start(tab, pane);
  }

  /** 创建独立 PTY，回调核对会话对象与代次，ap 状态保持未知。 */
  private async start(tab: Tab, pane: Pane): Promise<void> {
    pane.generation++;
    pane.process = "starting";
    pane.error = undefined;
    pane.task = "unknown";
    try {
      const agent = pane.agent ?? tab.agent;
      const directory = agent === "shell" ? this.workspace.workspaces.find(function belongs(group) { return group.id === tab.desktopWorkspaceId; })!.directory : tab.directory;
      const cwd = await this.directory(directory);
      const spec = await this.dependencies.launch(agent);
      const statusEnv = this.dependencies.status?.register(pane.id, pane.generation) ?? {};
      const agentEnv = this.dependencies.agents?.register(pane.id, pane.generation) ?? {};
      const browserEnv = this.dependencies.browser?.register(pane.id, pane.generation, basename(cwd), cwd, tab.desktopWorkspaceId) ?? {};
      const pty = this.dependencies.spawn(spec.shell, spec.args, { cwd, env: { ...spec.env, ...statusEnv, ...agentEnv, ...browserEnv, AUTOPILOT_DESKTOP_AP_PERMISSION: pane.apPermission ?? "ask" }, name: "xterm-256color", cols: 100, rows: 28 });
      const session: TerminalSession = { pty, generation: pane.generation, output: new OutputBuffer(), exited: false, startCommand: agent, resizePipe: spec.env.AUTOPILOT_DESKTOP_RESIZE_PIPE };
      this.sessions.set(pane.id, session);
      pty.onData(function append(data) { if (!session.exited) session.output.append(data); });
      const host = this;
      pty.onExit(function exited() {
        session.exited = true;
        host.retiring.delete(session);
        if (host.sessions.get(pane.id) === session && pane.generation === session.generation) {
          pane.process = "exited";
          host.dependencies.status?.shellExited(pane.id, pane.generation);
          host.dependencies.agents?.shellExited(pane.id, pane.generation);
          host.dependencies.browser?.release(pane.id, pane.generation);
          host.workspace.revision++;
        }
      });
      pane.process = "shell";
    } catch (error) {
      this.dependencies.status?.release(pane.id);
      this.dependencies.agents?.release(pane.id);
      this.dependencies.browser?.release(pane.id);
      pane.process = "failed";
      pane.error = error instanceof Error && /^(需要兼容|工作区|请先选择|所选 CLI)/.test(error.message) ? error.message : "终端创建失败，请检查原生 PTY 与 CLI 依赖后重试。";
    }
    this.workspace.revision++;
  }

  /** 应用工作台动作，导航与布局分支不触碰 PTY。 */
  private async apply(command: WorkspaceCommand, navigationVersion: number): Promise<void | false> {
    if (command.type === "apPermissionPreference") { this.workspace.defaultApPermission = command.permission; return; }
    if (command.type === "uiPreference") { this.workspace.ui = structuredClone(command.ui); return; }
    if (command.type === "preference") { this.workspace.defaultAgent = command.agent; return; }
    if (command.type === "terminalPreference") { this.workspace.newTerminal = command.terminal; return; }
    if (command.type === "workspaceActivate" || command.type === "workspaceRename" || command.type === "workspaceDelete") {
      const group = this.workspace.workspaces.find(function target(group) { return group.id === command.desktopWorkspaceId; });
      if (!group) throw new Error("目标工作区已不存在。");
      if (command.type === "workspaceRename") group.name = command.name.trim();
      else if (command.type === "workspaceDelete") {
        return this.deleteWorkspace(group);
      }
      else { this.workspace.activeWorkspace = group.id; this.workspace.activeTab = group.activeTab; }
      return;
    }
    if (command.type === "workspaceCreate") {
      if (this.submissions.has(command.requestId)) return;
      const directory = await this.directory(command.directory);
      const number = this.workspace.nextWorkspaceNumber++;
      const group: DesktopWorkspace = { id: randomUUID(), name: `工作区 ${number}`, number, directory, apPermission: command.apPermission ?? this.workspace.defaultApPermission, mode: "orchestration", activeTab: null };
      this.workspace.workspaces.push(group);
      this.submissions.add(command.requestId);
      if (navigationVersion === this.navigationVersion) { this.workspace.activeWorkspace = group.id; this.workspace.activeTab = null; }
      return;
    }
    if (command.type === "create") {
      if (this.submissions.has(command.requestId)) return;
      let group = this.workspace.workspaces.find(function target(group) { return group.id === command.desktopWorkspaceId; });
      if (command.desktopWorkspaceId && !group) throw new Error("目标工作区已不存在。");
      if (group?.mode === "orchestration") throw new Error("编排工作区不能创建自由终端 Tab。");
      // Freedom 无目录时只为 Shell 登记宿主主目录；智能体仍需选择 Tab 默认目录。
      const directory = command.mode === "freedom" && !command.directory
        ? group ? await this.directory(group.directory) : (await this.registerDirectory(homedir())).path
        : await this.directory(command.directory);
      if (!group) {
        const number = this.workspace.nextWorkspaceNumber++;
        group = { id: randomUUID(), name: `工作区 ${number}`, number, directory, mode: "parallel", activeTab: null };
        this.workspace.workspaces.push(group);
      }
      this.submissions.add(command.requestId);
      const baseName = directory ? basename(directory) || directory : "自由终端";
      const name = `${baseName} ${this.workspace.tabs.filter(function belongs(tab) { return tab.desktopWorkspaceId === group.id; }).length + 1}`;
      const tab: Tab = { id: randomUUID(), desktopWorkspaceId: group.id, agent: command.agent, agentSelected: command.agentSelected, name, directory: command.directory ? directory : null, panes: [], layout: null, focused: null, expanded: null, nextNumber: 1 };
      this.workspace.tabs.push(tab);
      group.activeTab = tab.id;
      if (navigationVersion === this.navigationVersion) { this.workspace.activeWorkspace = group.id; this.workspace.activeTab = tab.id; }
      await this.dependencies.browserWorkspaceChanged?.(this.workspace.activeWorkspace, this.workspace.workspaces);
      const count = command.mode === "x4" ? 4 : command.mode === "x2" ? 2 : 1;
      for (let index = 0; index < count; index++) await this.add(tab, "row", command.mode === "freedom" ? "shell" : tab.agent, command.apPermission ?? this.workspace.defaultApPermission);
      tab.layout = arrange(tab.panes.map(function id(pane) { return pane.id; }), "row");
      return;
    }
    const tab = this.tab(command.tabId);
    switch (command.type) {
      case "directory": tab.directory = await this.directory(command.directory); return;
      case "add": {
        const agent = tab.agentSelected ? tab.agent : this.workspace.newTerminal;
        const directory = agent === "shell" ? this.workspace.workspaces.find(function belongs(group) { return group.id === tab.desktopWorkspaceId; })!.directory : tab.directory;
        await this.directory(directory);
        await this.add(tab, command.axis, agent);
        return;
      }
      case "activate":
        if (command.paneId && !tab.panes.some(function exists(pane) { return pane.id === command.paneId; })) throw new Error("终端已关闭。");
        this.workspace.activeWorkspace = tab.desktopWorkspaceId;
        this.workspace.activeTab = tab.id;
        this.workspace.workspaces.find(function belongs(group) { return group.id === tab.desktopWorkspaceId; })!.activeTab = tab.id;
        if (command.paneId && tab.panes.some(function exists(pane) { return pane.id === command.paneId; })) tab.focused = command.paneId;
        if (command.paneId && tab.expanded !== command.paneId) tab.expanded = null;
        return;
      case "expand":
        if (command.paneId && !tab.panes.some(function exists(pane) { return pane.id === command.paneId; })) throw new Error("终端已关闭。");
        tab.expanded = command.paneId; return;
      case "arrange": tab.layout = arrange(tab.panes.map(function id(pane) { return pane.id; }), command.axis); return;
      case "ratio": tab.layout = setRatio(tab.layout, command.path, command.ratio); return;
      case "retry": {
        const pane = tab.panes.find(function exists(item) { return item.id === command.paneId; });
        if (!pane || !["failed", "exited"].includes(pane.process)) throw new Error("仅可重试启动失败或已退出的终端。");
        const previous = this.sessions.get(pane.id);
        if (previous && !previous.exited) throw new Error("终端仍在运行。");
        this.sessions.delete(pane.id);
        await this.start(tab, pane); return;
      }
      case "close": await this.closeTabs([tab], command.paneId); return;
    }
  }

  /** 删除组只以目标组正在执行的 Turn 决定是否确认，提交后立即移除导航。 */
  private async deleteWorkspace(group: DesktopWorkspace): Promise<void | false> {
    const panes = this.workspace.tabs.filter(function belongs(tab) { return tab.desktopWorkspaceId === group.id; }).flatMap(function panes(tab) { return tab.panes; });
    const host = this;
    const working = group.mode === "orchestration"
      ? await this.dependencies.hasWorkingTurn?.(group.id).catch(function unknown() { return false; })
      : summarizeAp(panes.map(function observed(pane) { return { ...pane, aps: host.dependencies.status?.snapshot(pane.id) }; })).running > 0
        || panes.some(function working(pane) { return host.dependencies.agents?.hasWorkingTurn(pane.id); });
    if (working && !await this.dependencies.confirm(`删除工作区“${group.name}”？`, "此工作区有正在执行的任务。确认后将移除工作区并关闭所属终端，保留项目文件和任务历史。", "删除工作区")) return false;
    try {
      /** 立即撤销窗格能力，后台终止本次捕获的 PTY，不按当前位置重新寻找目标。 */
      async function stopTerminals(): Promise<void> {
        const sessions: TerminalSession[] = [];
        for (const pane of panes) {
          const session = host.sessions.get(pane.id);
          if (session && !session.exited) { sessions.push(session); host.retiring.add(session); }
          host.sessions.delete(pane.id);
          host.dependencies.status?.release(pane.id);
          host.dependencies.agents?.release(pane.id);
          host.dependencies.browser?.release(pane.id);
        }
        if (await host.stopTargets(sessions, async function stop(session) { await host.dependencies.stop(session); host.retiring.delete(session); })) console.warn("已删除工作区的部分终端未确认退出。");
      }
      if (this.dependencies.removeWorkspace) await this.dependencies.removeWorkspace(group.id, stopTerminals);
      else void stopTerminals().catch(function failed() { console.warn("已删除工作区的终端收尾未确认。"); });
      this.workspace.tabs = this.workspace.tabs.filter(function keep(tab) { return tab.desktopWorkspaceId !== group.id; });
      this.removeWorkspaceNavigation(group);
    } finally { if (working) this.dependencies.confirmationFinished?.(); }
  }

  /** 单 Tab/窗格仍按存活 Shell 确认，并保留停止失败的终端。 */
  private async closeTabs(tabs: Tab[], paneId?: string): Promise<boolean> {
    const targets = tabs.flatMap(function targets(tab) { return tab.panes.filter(function target(pane) { return !paneId || pane.id === paneId; }).map(function owner(pane) { return { tab, pane }; }); });
    const panes = targets.map(function pane(target) { return target.pane; });
    const live = panes.some(function live(pane) { return pane.process === "shell" || pane.process === "starting"; });
    if (live && !await this.dependencies.confirm(paneId ? "关闭此终端？" : "关闭此 Tab？", this.closeDetail(panes))) return false;
    const host = this;
    try {
      /** 仅关闭本次确认覆盖的终端，复用部分失败保留处理。 */
      async function stopTerminals(): Promise<void> {
        const failed = await host.stopTargets(targets, async function stop({ tab, pane }) {
          const session = host.sessions.get(pane.id);
          if (session) await host.dependencies.stop(session);
          host.sessions.delete(pane.id);
          host.dependencies.status?.release(pane.id);
          host.dependencies.agents?.release(pane.id);
          host.dependencies.browser?.release(pane.id);
          tab.panes = tab.panes.filter(function retain(item) { return item.id !== pane.id; });
          tab.layout = removePane(tab.layout, pane.id);
          if (tab.expanded === pane.id) tab.expanded = null;
          if (tab.focused === pane.id) tab.focused = tab.panes[0]?.id ?? null;
          host.workspace.revision++;
        });
        for (const tab of tabs) if (!paneId && !tab.panes.length) {
          host.workspace.tabs = host.workspace.tabs.filter(function retain(item) { return item.id !== tab.id; });
          const group = host.workspace.workspaces.find(function belongs(group) { return group.id === tab.desktopWorkspaceId; })!;
          if (group.activeTab === tab.id) group.activeTab = host.workspace.tabs.find(function sameGroup(item) { return item.desktopWorkspaceId === group.id; })?.id ?? null;
          if (host.workspace.activeWorkspace === group.id) host.workspace.activeTab = group.activeTab;
        }
        if (failed) throw new Error("部分终端尚未确认退出，请重试关闭。");
      }
      await stopTerminals();
      return true;
    } finally { this.dependencies.confirmationFinished?.(); }
  }

  /** 移除导航并在删除当前组时选择相邻项，不回收编号。 */
  private removeWorkspaceNavigation(workspace: DesktopWorkspace): void {
    const index = this.workspace.workspaces.indexOf(workspace);
    this.workspace.workspaces.splice(index, 1);
    if (this.workspace.activeWorkspace === workspace.id) {
      const next = this.workspace.workspaces[Math.min(index, this.workspace.workspaces.length - 1)];
      this.workspace.activeWorkspace = next?.id ?? null;
      this.workspace.activeTab = next?.activeTab ?? null;
    }
  }

  /** 固定快照最多八路停止并等待全部结果，单项失败不会阻断其他目标。 */
  private async stopTargets<T>(targets: T[], stop: (target: T) => Promise<void>): Promise<boolean> {
    let next = 0;
    let failed = false;
    /** 每个工作者领取唯一目标，所有状态更新仍处于宿主命令事务内。 */
    async function worker(): Promise<void> {
      while (next < targets.length) {
        const target = targets[next++];
        try { await stop(target); } catch { failed = true; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
    return failed;
  }

  /** 原子串行保存界面白名单，失败保留运行终端并显示提示。 */
  private async persist(): Promise<boolean> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(savedWorkspace(this.workspace)), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      if (this.workspace.notice?.startsWith("布局保存失败")) this.workspace.notice = undefined;
      return true;
    } catch { this.workspace.notice = "布局保存失败，请检查应用数据目录权限。当前终端仍保留。"; return false; }
  }

  /** 所有 IO 都核对当前会话代次，防止旧组件写入重试后的新进程。 */
  session(id: string, generation: number): TerminalSession {
    const session = this.sessions.get(id);
    if (!session || session.generation !== generation) throw new Error("终端连接已更新，请重新连接。");
    return session;
  }

  /** 应用退出与普通关闭分别处理，保留布局配置以供下次启动新 ap。 */
  shutdown(): Promise<boolean> {
    if (this.shutdownPending) return this.shutdownPending;
    const host = this;
    this.shutdownPending = this.shutdownOnce().finally(function settled() { host.shutdownPending = undefined; });
    return this.shutdownPending;
  }

  /** 等待已提交命令后冻结退出范围，取消或任一失败均恢复可重试状态。 */
  private async shutdownOnce(): Promise<boolean> {
    this.quitting = true;
    try {
      await this.queue;
      const targets = [...this.sessions.values(), ...this.retiring];
      if (targets.some(function live(session) { return !session.exited; }) && !await this.dependencies.confirm("仍有终端正在运行", this.closeDetail(this.workspace.tabs.flatMap(function panes(tab) { return tab.panes; }), true))) { this.quitting = false; return false; }
      await this.persist();
      const failed = await this.stopTargets(targets, this.dependencies.stop);
      if (failed) throw new Error("stop incomplete");
      return true;
    } catch {
      this.quitting = false;
      this.workspace.notice = "部分终端尚未确认退出，请重试。";
      return false;
    } finally { this.dependencies.confirmationFinished?.(); }
  }
}
