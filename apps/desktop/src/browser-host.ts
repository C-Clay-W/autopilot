// Electron 主进程管理独立网页、临时分区、下载和窗口生命周期，网页不获得 Desktop preload。
import { BrowserWindow, WebContentsView, session, clipboard, dialog, app, type DownloadItem, type Session } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { browserHistoryUrl, restoreBrowserSaved, isBrowserPreferences, reserveDownload } from "./browser-data";
import { openBrowserDocument, resolveBrowserDocumentFile, resolveReviewDocument } from "./browser-document";
import { BrowserCdp } from "./browser-cdp";
import { BrowserDriver, browserDriverPath, captureBrowserScreenshot } from "./browser-driver";
import { BrowserOccupancy } from "./browser-occupancy";
import { isPublicBrowserUrl, type BrowserOperation } from "@autopilot-agent/core";
import type { BrowserPrincipal } from "./browser-access";
import { browserUrl, type BrowserAction, type BrowserBounds, type BrowserCommand, type BrowserDownload, type BrowserHistory, type BrowserPage, type BrowserPreferences, type BrowserSnapshot, type BrowserSaved } from "./browser-contract";

interface PageRecord { document?: () => Promise<void>; reviewUrl?: string; visible?: boolean; state: BrowserPage; view: WebContentsView; cdp: BrowserCdp; initializing?: boolean; closing?: Promise<void>; driver?: BrowserDriver; abort?: AbortController; execution?: Promise<unknown>; input?: boolean; takeover?: Promise<void>; dialogResponse?: Promise<void>; apControlled?: boolean; localOrigin?: string }

/** 浏览器独立于终端导航，关闭 Mac 窗口也销毁全部网页与临时 session。 */
export class BrowserHost {
  private pages = new Map<string, PageRecord>();
  private sessions = new Map<string, Session>();
  private downloads = new Map<string, { state: BrowserDownload; item: DownloadItem }>();
  private occupancy = new BrowserOccupancy();
  private window?: BrowserWindow;
  private inputShield?: WebContentsView;
  private bounds?: BrowserBounds;
  private workspaceId: string | null = null;
  private workspaces?: Map<string, string>;
  private scopes = new Map<string | null, { active: string | null; expanded: boolean }>();
  private notice?: string;
  private closing = false;
  private history: BrowserHistory[] = [];
  private preferences: BrowserPreferences = { permission: "follow_ap", historyDays: 30, askDownload: false };
  private dataQueue: Promise<void> = Promise.resolve();
  onPermissionTightened?: () => void;
  onTakeover?: (pageId: string) => void;
  onClear?: () => Promise<void>;
  onConfirmExit?: () => Promise<boolean>;
  constructor(private resources: string, private save?: (value: BrowserSaved) => Promise<void>) {}
  /** 页面选中和开关只按 Desktop 工作区 ID 保存，终端 Tab 不参与。 */
  private scope(id = this.workspaceId): { active: string | null; expanded: boolean } {
    let scope = this.scopes.get(id);
    if (!scope) { scope = { active: null, expanded: false }; this.scopes.set(id, scope); }
    return scope;
  }
  /** 工作区导航先隐藏全部旧视图，删除只回收目标工作区的页面。 */
  async setWorkspaces(active: string | null, workspaces: Array<{ id: string; name: string }>): Promise<void> {
    this.workspaces = new Map(workspaces.map(function entry(workspace) { return [workspace.id, workspace.name]; }));
    if (this.workspaceId !== active) { this.workspaceId = active; this.bounds = undefined; }
    this.show();
    for (const page of this.pages.values()) if (!page.state.desktopWorkspaceId || !this.workspaces.has(page.state.desktopWorkspaceId)) await this.close(page.state.id);
    for (const id of this.scopes.keys()) if (id === null || !this.workspaces.has(id)) this.scopes.delete(id);
  }
  /** 调用身份必须来自仍存在的工作区；未接导航的独立宿主沿用原调用。 */
  private principalWorkspace(principal: BrowserPrincipal): string | null {
    const id = principal.desktopWorkspaceId ?? (this.workspaces ? undefined : this.workspaceId);
    if (id === undefined || this.workspaces && (id === null || !this.workspaces.has(id))) throw new Error("BROWSER_WORKSPACE_UNAVAILABLE");
    return id;
  }
  /** 初始化只恢复偏好与净化历史，不创建任何旧网页。 */
  restore(value?: BrowserSaved): void { const saved = restoreBrowserSaved(value); this.preferences = saved.preferences; this.history = saved.history; }
  /** 设置读取使用副本，renderer 不能直接改变权威值。 */
  settings(): BrowserPreferences { return { ...this.preferences }; }
  /** 只解析路径和文件元数据，审批冻结canonical单文件，尚未读取文档正文。 */
  async prepare(principal: BrowserPrincipal, operation: BrowserOperation): Promise<BrowserOperation> {
    const workspaceId = this.principalWorkspace(principal);
    if ("pageId" in operation && this.pages.get(operation.pageId)?.state.desktopWorkspaceId !== workspaceId) throw new Error("BROWSER_PAGE_UNAVAILABLE");
    return operation.type === "document" ? { type: "document", path: await resolveBrowserDocumentFile(operation.path, principal.workspaceRoot ?? principal.workspace) } : operation;
  }
  /** 审批与执行使用同一目标校验，旧文档代次不能套用新页面。 */
  target(operation: BrowserOperation, principal?: BrowserPrincipal): { pageId?: string; url: string; approvedLocal?: true } {
    if (operation.type === "open") return { url: browserUrl(operation.url) };
    if (operation.type === "document") return { url: operation.path };
    if (operation.type === "list") return { url: "当前内置浏览器标签列表" };
    const page = this.pages.get(operation.pageId);
    if (!page || page.state.revision !== operation.revision) throw new Error("BROWSER_PAGE_CHANGED");
    if (page.initializing) throw new Error("BROWSER_PAGE_INITIALIZING");
    if (principal?.review && (page.state.owner !== principal.id || !page.reviewUrl || page.state.url !== page.reviewUrl)) throw new Error("BROWSER_REVIEW_SCOPE_DENIED");
    if (principal?.review && ["snapshot", "screenshot", "click", "fill", "select-option", "check"].includes(operation.type)
      && (page.view.webContents.getURL() !== page.reviewUrl || page.state.loading || page.state.error)) throw new Error("BROWSER_PAGE_NOT_READY");
    const url = operation.type === "navigate" ? browserUrl(operation.url) : page.state.url;
    const approvedLocal = operation.type !== "navigate" && page.state.owner === principal?.id && page.localOrigin !== undefined && new URL(url).origin === page.localOrigin;
    return { pageId: page.state.id, url, ...(approvedLocal ? { approvedLocal: true } : {}) };
  }
  /** 宿主审批后按固定动作执行；智能体导航不借用会撤销授权的手动命令。 */
  async agentRequest(principal: BrowserPrincipal, turnId: string, operation: BrowserOperation, signal: AbortSignal): Promise<unknown> {
    const workspaceId = this.principalWorkspace(principal);
    if ("pageId" in operation && this.pages.get(operation.pageId)?.state.desktopWorkspaceId !== workspaceId) throw new Error("BROWSER_PAGE_UNAVAILABLE");
    this.target(operation, principal);
    if (signal.aborted || this.closing) throw new Error("BROWSER_CANCELLED");
    if (operation.type === "list") {
      const pages = this.snapshot(workspaceId).pages;
      return principal.review ? pages.filter(function owned(page) { return page.owner === principal.id; }) : pages;
    }
    if (operation.type === "document") {
      const file = await resolveBrowserDocumentFile(operation.path, principal.workspaceRoot ?? principal.workspace);
      if (file !== operation.path) throw new Error("BROWSER_DOCUMENT_CHANGED");
      const review = principal.review ? await resolveReviewDocument(file, principal.workspaceRoot!, principal.review.documents) : undefined;
      const preview = await openBrowserDocument(file, signal, review?.evidence.contentVersion);
      try {
        return await this.openForAgent(principal, turnId, preview.url, signal, workspaceId, preview.close);
      } catch (error) { await preview.close(); throw error; }
    }
    if (operation.type === "open") return this.openForAgent(principal, turnId, operation.url, signal, workspaceId);
    const { pageId, revision, ...action } = operation;
    const page = this.pages.get(pageId)!;
    if (operation.type === "release") { if (!this.occupancy.release(pageId, principal.id, turnId)) throw new Error("有其他智能体正在操控，请等待后再试"); page.state.occupied = undefined; this.show(); return { released: true }; }
    if (page.state.paused || page.takeover) throw new Error("BROWSER_PAGE_UNAVAILABLE");
    if (principal.kind === "ap") page.apControlled = true;
    if (operation.type === "dialog") {
      const running = Boolean(page.execution);
      if (running && !this.occupancy.matches(pageId, principal.id, turnId)) throw new Error("有其他智能体正在操控，请等待后再试");
      if (!running) { this.occupancy.enter(pageId, principal.id, turnId); page.state.occupied = principal.id; }
      try { await this.answerDialog(page, operation.accept, operation.text, signal); return { ...page.state }; }
      finally { if (!running) this.occupancy.settle(pageId); }
    }
    if (["snapshot", "screenshot", "click", "fill", "press", "scroll", "select-option", "check"].includes(action.type)) return this.execute(pageId, principal.id, turnId, revision, action as BrowserAction, signal);
    this.occupancy.enter(pageId, principal.id, turnId); page.state.occupied = principal.id; this.show();
    try {
      const contents = page.view.webContents;
      switch (operation.type) {
        case "select": this.scope(workspaceId).active = pageId; this.scope(workspaceId).expanded = true; break;
        case "navigate": {
          const address = browserUrl(operation.url);
          if (page.apControlled) page.localOrigin = isPublicBrowserUrl(address) ? undefined : new URL(address).origin;
          void contents.loadURL(address).catch(function failed() { page.state.loading = false; page.state.error ??= "网页加载失败。"; });
          break;
        }
        case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
        case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
        case "reload": contents.reload(); break;
        case "downloads": return this.snapshot(workspaceId).downloads.filter(function owned(download) { return download.pageId === pageId; });
        case "cancel-download": {
          const download = this.downloads.get(operation.id);
          if (!download || download.state.pageId !== pageId) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
          download.item.cancel(); break;
        }
        case "wait": {
          const self = this;
          const timeout = operation.timeout;
          page.abort = new AbortController();
          const waitSignal = AbortSignal.any([signal, page.abort.signal]);
          /** 加载等待占用本页执行位，超时仅结束观察，导航代次变化立即失效。 */
          async function loaded() {
            const deadline = Date.now() + timeout;
            while (contents.isLoading()) {
              if (waitSignal.aborted) throw new Error("BROWSER_CANCELLED");
              self.target(operation);
              if (Date.now() >= deadline) return { loaded: false, timedOut: true };
              // 取消映射为固定浏览器错误，不把原生AbortError降为通用请求失败。
              await delay(Math.min(50, deadline - Date.now()), undefined, { signal: waitSignal }).catch(function cancelled() { throw new Error("BROWSER_CANCELLED"); });
            }
            if (waitSignal.aborted) throw new Error("BROWSER_CANCELLED");
            self.target(operation);
            return { loaded: true, timedOut: false };
          }
          page.execution = loaded();
          return await page.execution;
        }
        case "close": this.occupancy.settle(pageId); await this.close(pageId); return { closed: true };
      }
      this.show(); return { ...page.state };
    } catch (error) { this.occupancy.settle(pageId, true); page.state.paused = true; throw error; }
    finally { this.occupancy.settle(pageId); page.execution = undefined; page.abort = undefined; }
  }
  /** 页面与预览 Worker 同时受原所有者和原回合占用；复核只允许预览文档路由。 */
  private async openForAgent(principal: BrowserPrincipal, turnId: string, url: string, signal: AbortSignal, workspaceId: string | null, document?: () => Promise<void>): Promise<BrowserPage> {
    if (principal.review && !document) throw new Error("BROWSER_REVIEW_SCOPE_DENIED");
    const id = await this.open(url, principal.id, principal.workspace, signal, workspaceId, principal.kind === "ap", !!principal.review);
    const page = this.pages.get(id)!;
    page.document = document;
    if (signal.aborted || this.closing) { await this.close(id); throw new Error("BROWSER_CANCELLED"); }
    this.occupancy.enter(id, principal.id, turnId);
    this.occupancy.settle(id);
    page.state.occupied = principal.id;
    page.state.ownerLabel = principal.label;
    this.show();
    return { ...page.state };
  }
  /** 原生回合结束先取消并等候本人的在途页，不影响其他调用者。 */
  async endTurn(principal: BrowserPrincipal, turnId: string): Promise<void> {
    for (const page of this.pages.values()) if (this.occupancy.matches(page.state.id, principal.id, turnId)) {
      page.abort?.abort();
      if (page.execution) { try { await page.execution; } catch { /* 未知结果已经暂停。 */ } }
      if (page.dialogResponse) { try { await page.dialogResponse; } catch { /* 应答失败保留暂停状态。 */ } }
    }
    this.release(principal.id, turnId);
    if (principal.review) {
      for (const page of this.pages.values()) if (page.state.owner === principal.id && page.reviewUrl) await this.close(page.state.id);
      const partition = this.sessions.get(principal.id);
      if (partition) {
        this.sessions.delete(principal.id);
        await partition.clearStorageData();
        await partition.clearCache();
        await partition.closeAllConnections();
      }
    }
  }
  /** 变更复用现有布局单写队列，落盘成功后才更新浏览器内存。 */
  private changeData(change: (data: BrowserSaved) => void): Promise<void> {
    const task = this.dataQueue.then(async function save(this: BrowserHost) {
      const data = restoreBrowserSaved({ preferences: this.preferences, history: this.history });
      change(data);
      const saved = restoreBrowserSaved(data);
      await this.save?.(saved);
      this.preferences = saved.preferences; this.history = saved.history;
    }.bind(this));
    this.dataQueue = task.catch(function keepQueue() {});
    return task;
  }
  /** 设置仅允许固定选项，收紧权限的授权撤销由统一审批服务接线。 */
  async preferencesUpdate(value: BrowserPreferences): Promise<void> {
    if (!isBrowserPreferences(value)) throw new Error("BROWSER_PREFERENCES_INVALID");
    await this.changeData(function update(data) { data.preferences = { ...value }; });
    if (value.permission !== "always") this.onPermissionTightened?.();
  }
  /** 清空历史不关闭网页、不删除下载文件。 */
  clearHistory(): Promise<void> { return this.changeData(function clear(data) { data.history = []; }); }
  /** 下载目录由系统选择器产生，取消不修改已保存配置。 */
  async chooseDownloadDirectory(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) throw new Error("浏览器窗口不可用。");
    const selected = await dialog.showOpenDialog(this.window, { title: "选择下载保存目录", properties: ["openDirectory", "createDirectory"] });
    if (!selected.canceled && selected.filePaths[0]) await this.changeData(function update(data) { data.preferences.downloadDirectory = selected.filePaths[0]; });
  }
  /** 只挂接当前主窗口，重开窗口不会恢复旧网页。 */
  bind(window: BrowserWindow): void {
    this.window = window; this.bounds = undefined;
    if (this.inputShield && !this.inputShield.webContents.isDestroyed()) this.inputShield.webContents.close({ waitForBeforeUnload: false });
    const shield = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    shield.setBackgroundColor("#00000000"); shield.setVisible(false);
    const self = this;
    /** 独立透明原生视图接收人工输入，避免把 CDP 产生的输入误判为用户接管。 */
    function takeover(event: Electron.Event) {
      event.preventDefault();
      const active = self.scope().active;
      const page = active ? self.pages.get(active) : undefined;
      if (!page || !page.state.occupied) return;
      void self.takeover(page).then(function stopped() { self.notice = "已手动接管，请再次点击网页继续操作。"; self.show(); }).catch(function failed() { self.notice = "上一步尚未确认停止，请重试手动接管。"; });
    }
    shield.webContents.on("before-mouse-event", function mouse(event, input) { if (["mouseDown", "mouseWheel"].includes(input.type)) takeover(event); });
    shield.webContents.on("before-input-event", function key(event, input) { if (input.type === "keyDown") takeover(event); });
    this.inputShield = shield; window.contentView.addChildView(shield);
  }
  /** 快照不暴露 WebContents/debugger/端点或下载绝对路径。 */
  snapshot(workspaceId = this.workspaceId): BrowserSnapshot {
    const fresh = restoreBrowserSaved({ preferences: this.preferences, history: this.history }).history;
    if (fresh.length !== this.history.length) {
      this.history = fresh;
      const self = this;
      void this.changeData(function prune() {}).catch(function failed() { self.notice = "浏览历史清理保存失败。"; });
    }
    const pages = [...this.pages.values()].filter(function belongs(page) { return page.state.desktopWorkspaceId === workspaceId; });
    const ids = new Set(pages.map(function id(page) { return page.state.id; }));
    return { pages: pages.map(function copy(page) { return { ...page.state }; }), active: this.scope(workspaceId).active, expanded: this.scope(workspaceId).expanded, downloads: [...this.downloads.values()].filter(function belongs(download) { return ids.has(download.state.pageId); }).map(function copy(download) { return { ...download.state }; }), history: [...this.history], notice: this.notice }; }
  /** 会话以调用者身份隔离，用户手动页使用独立 manual 分区。 */
  private partition(owner: string): Session {
    let partition = this.sessions.get(owner);
    if (partition) return partition;
    partition = session.fromPartition(`ap-browser-${randomUUID()}`, { cache: false });
    const self = this;
    partition.setPermissionRequestHandler(function deny(_webContents, _permission, callback) { callback(false); self.notice = "此站点需要系统权限，请复制链接到本机浏览器处理。"; });
    partition.setPermissionCheckHandler(function deny() { return false; });
    // 网页脚本和重定向也经过实际请求检查，避免点击免确认后直接访问新本机地址。
    partition.webRequest.onBeforeRequest(function authorize(details, callback) {
      const page = [...self.pages.values()].find(function owner(candidate) { return candidate.view.webContents.id === details.webContentsId; });
      if (page?.reviewUrl && (details.url !== "about:blank" || !page.initializing)) { callback({ cancel: details.url !== page.reviewUrl || !["GET", "HEAD"].includes(details.method) }); return; }
      if (!page?.apControlled) { callback({}); return; }
      const url = new URL(details.url);
      if (url.protocol === "file:") { callback({ cancel: true }); return; }
      if (!/^https?:$/.test(url.protocol)) { callback({}); return; }
      const newLocal = !isPublicBrowserUrl(url.href) && page.localOrigin !== url.origin;
      const deletion = details.method === "DELETE";
      if (newLocal && details.resourceType !== "mainFrame") { callback({ cancel: true }); return; }
      if (newLocal || deletion) {
        const reason = deletion ? "浏览器删除操作需要确认" : "浏览器访问本机或内网需要确认";
        if (!self.confirmBrowserEffect(reason, browserHistoryUrl(url.href) ?? url.origin)
            || !page.apControlled || self.pages.get(page.state.id) !== page) { callback({ cancel: true }); return; }
        if (newLocal) page.localOrigin = url.origin;
      }
      callback({});
    });
    partition.on("will-download", function download(_event, item, contents) { self.download(item, contents.id); });
    this.sessions.set(owner, partition); return partition;
  }
  /** 页面先登记再导航，任何外部网页都没有宿主 preload、Node 或弹窗权限。 */
  async open(url: string, owner = "manual", workspace = "手动浏览", signal?: AbortSignal, desktopWorkspaceId = this.workspaceId, apControlled = false, review = false): Promise<string> {
    const address = browserUrl(url);
    if (this.workspaces && (desktopWorkspaceId === null || !this.workspaces.has(desktopWorkspaceId))) throw new Error("BROWSER_WORKSPACE_UNAVAILABLE");
    if (signal?.aborted) throw new Error("BROWSER_CANCELLED");
    if (this.closing || !this.window || this.window.isDestroyed()) throw new Error("浏览器窗口不可用。");
    const id = randomUUID();
    const view = new WebContentsView({ webPreferences: { session: this.partition(owner), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false } });
    const contents = view.webContents;
    const state: BrowserPage = { id, owner, workspace, desktopWorkspaceId, url: address, title: "正在初始化", loading: true, back: false, forward: false, revision: 0, paused: false };
    const cdp = new BrowserCdp(contents.debugger, id, function info() { return { url: contents.getURL(), title: contents.getTitle() }; });
    const abort = new AbortController();
    const page: PageRecord = { state, view, cdp, initializing: true, abort, apControlled,
      ...(review ? { reviewUrl: address } : {}),
      ...(apControlled && !isPublicBrowserUrl(address) ? { localOrigin: new URL(address).origin } : {}) };
    this.pages.set(id, page);
    const self = this;
    /** 非 HTTP(S) 导航拒绝，正常跳转保留浏览器行为。 */
    function navigation(event: Electron.Event, next: string) {
      if (page.reviewUrl && next !== page.reviewUrl) { event.preventDefault(); return; }
      try { browserUrl(next); } catch { event.preventDefault(); self.notice = "不支持此链接协议，请复制链接到本机浏览器处理。"; }
    }
    contents.on("will-navigate", navigation); contents.on("will-redirect", navigation);
    contents.setWindowOpenHandler(function rejectPopup() { self.notice = "暂不支持网站新窗口或登录弹窗，请复制链接到本机浏览器处理。"; return { action: "deny" }; });
    contents.on("did-start-navigation", function changed(_event, _url, _inPlace, mainFrame) { if (mainFrame) { state.revision++; state.error = undefined; state.dialog = undefined; if (!page.initializing) state.title = "正在加载"; } });
    contents.on("did-start-loading", function started() { state.loading = true; });
    contents.on("did-stop-loading", function stopped() { self.update(page); });
    contents.on("page-title-updated", function title(_event, title) { if (!page.initializing) state.title = title.slice(0, 256); });
    contents.on("did-navigate", function navigated() { if (!page.initializing) { self.update(page); self.recordHistory(state); } });
    contents.on("did-navigate-in-page", function navigated(_event, _url, mainFrame) { if (mainFrame && !page.initializing) { state.revision++; self.update(page); self.recordHistory(state); } });
    contents.on("did-fail-load", function failed(_event, code, _description, _url, mainFrame) { if (mainFrame && code !== -3) { state.loading = false; state.error = `网页加载失败（${code}），请检查地址或重试。`; } });
    contents.on("render-process-gone", function crashed() { state.error = "网页进程已退出，请关闭后重新打开。"; state.loading = false; state.paused = true; page.abort?.abort(); });
    contents.debugger.on("message", function browserEvent(_event, method, params) {
      if (method === "Page.javascriptDialogOpening") { state.revision++; state.dialog = { type: String(params.type), message: String(params.message).slice(0, 8192), defaultValue: String(params.defaultPrompt ?? "").slice(0, 16384) }; self.show(); }
      if (method === "Page.javascriptDialogClosed") { state.revision++; state.dialog = undefined; self.show(); }
    });
    let stage = "FRAME";
    const timeout = AbortSignal.timeout(10000);
    const opening = AbortSignal.any([abort.signal, timeout, ...(signal ? [signal] : [])]);
    /** 每个异步阶段之后检查取消，迟到初始化结果不得继续导航或重新挂接。 */
    function checkOpening() {
      if (timeout.aborted) throw new Error("BROWSER_PAGE_INIT_TIMEOUT");
      if (opening.aborted || contents.isDestroyed() || self.pages.get(id) !== page || self.closing || self.workspaces && (desktopWorkspaceId === null || !self.workspaces.has(desktopWorkspaceId))) throw new Error("BROWSER_CANCELLED");
    }
    /** 先启动可信空白文档的渲染 frame，再启用 Page 域，保留目标页脚本之前的对话框监听。 */
    async function initialize() {
      await contents.loadURL("about:blank"); checkOpening();
      stage = "CDP";
      await cdp.start(); checkOpening();
      stage = "PAGE";
      await contents.debugger.sendCommand("Page.enable"); checkOpening();
    }
    let cancelled: (() => void) | undefined;
    try {
      this.window.contentView.addChildView(view); view.setVisible(false);
      this.scope(desktopWorkspaceId).active = id; this.scope(desktopWorkspaceId).expanded = true; this.show();
      await new Promise<void>(function prepare(resolve, reject) {
        cancelled = function cancel() { try { checkOpening(); } catch (error) { reject(error); } };
        opening.addEventListener("abort", cancelled, { once: true });
        if (opening.aborted) { cancelled(); return; }
        void initialize().then(resolve, reject);
      });
      checkOpening();
      page.initializing = false; page.abort = undefined;
      state.url = address; state.title = "正在加载"; state.loading = true; state.error = undefined;
      void contents.loadURL(address).catch(function loadFailed() { state.loading = false; state.error ??= "网页加载失败，请检查地址或重试。"; });
      return id;
    } catch (error) {
      abort.abort();
      await this.close(id);
      if (error instanceof Error && /^(BROWSER_CANCELLED|BROWSER_PAGE_INIT_TIMEOUT)$/.test(error.message)) throw error;
      console.error("Browser page initialization failed", { stage, code: (error as NodeJS.ErrnoException)?.code });
      throw new Error(`BROWSER_PAGE_INIT_${stage}_FAILED`);
    } finally { if (cancelled) opening.removeEventListener("abort", cancelled); }
  }
  /** 导航状态仅从实际 WebContents 投影，不根据按钮点击猜测成功。 */
  private update(page: PageRecord): void {
    if (page.view.webContents.isDestroyed() || page.initializing) return;
    const contents = page.view.webContents;
    page.state.url = contents.getURL() || page.state.url; page.state.title = contents.getTitle().slice(0, 256) || page.state.url;
    page.state.loading = contents.isLoading(); page.state.back = contents.navigationHistory.canGoBack(); page.state.forward = contents.navigationHistory.canGoForward();
  }
  /** 历史去重并按设置裁剪，保存失败显示提示，不影响已加载页面。 */
  private recordHistory(page: BrowserPage): void {
    const url = browserHistoryUrl(page.url);
    if (!url || !this.preferences.historyDays) return;
    const entry = { url, title: page.title, visited: Date.now() };
    const self = this;
    void this.changeData(function visited(data) { data.history = [entry, ...data.history.filter(function retained(item) { return item.url !== url; })]; }).catch(function failed() { self.notice = "浏览历史保存失败，请检查应用数据目录权限。"; });
  }
  /** 原生 View 只覆盖测量区域；弹层/菜单/输入法组字时 renderer 必须隐藏原生内容。 */
  layout(bounds: BrowserBounds, workspaceId = this.workspaceId): void {
    if (workspaceId !== this.workspaceId) return;
    this.bounds = bounds;
    if (bounds.hidden) for (const page of this.pages.values()) if (page.input && page.execution) { page.cdp.setActive(false); page.abort?.abort(); }
    this.show();
  }
  /** 切换可见页不改变任何自动操作 target，弹层存在时不依赖 CSS z-index。 */
  private show(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    let shieldVisible = false;
    for (const page of this.pages.values()) {
      const raw = this.bounds;
      // renderer尺寸可能落后原生resize一帧，裁到当前内容区，完全离屏仍隐藏。
      const b = raw ? { ...raw, width: Math.min(raw.width, Math.max(0, width - raw.x)), height: Math.min(raw.height, Math.max(0, height - raw.y)) } : undefined;
      const visible = Boolean(page.state.desktopWorkspaceId === this.workspaceId && this.scope().expanded && page.state.id === this.scope().active && b && !b.hidden && !page.state.dialog && b.width > 0 && b.height > 0 && b.x + b.width <= width && b.y + b.height <= height);
      if (visible && b) page.view.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
      page.view.setVisible(visible);
      if (page.visible !== visible) {
        console.info("AP browser view", { visible, loading: page.state.loading, hidden: b?.hidden ?? true, width: b?.width ?? 0, height: b?.height ?? 0 });
        page.visible = visible;
      }
      if (visible && page.state.occupied && b) { this.inputShield?.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }); shieldVisible = true; }
    }
    if (this.inputShield) { this.inputShield.setVisible(shieldVisible); if (shieldVisible) this.window.contentView.addChildView(this.inputShield); }
  }
  /** 固定手动动作，操作前接管该页；切页/复制/收起不撤销其他页面。 */
  async command(command: BrowserCommand, workspaceId = this.workspaceId): Promise<void> {
    if (workspaceId !== this.workspaceId) throw new Error("BROWSER_WORKSPACE_CHANGED");
    if (command.type === "open") { await this.open(command.url, "manual", this.workspaceId ? this.workspaces?.get(this.workspaceId) ?? "手动浏览" : "手动浏览"); return; }
    if (command.type === "expand") { this.scope().expanded = command.expanded; this.show(); return; }
    if (command.type === "cancel-download") { const download = this.downloads.get(command.id);
      if (!download || this.pages.get(download.state.pageId)?.state.desktopWorkspaceId !== this.workspaceId) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
      download.item.cancel(); return; }
    const page = this.pages.get(command.pageId);
    if (!page || page.state.desktopWorkspaceId !== this.workspaceId) throw new Error("网页已关闭。");
    const contents = page.view.webContents;
    if (command.type === "select") { this.scope().active = command.pageId; this.scope().expanded = true; this.show(); return; }
    if (command.type === "copy") { clipboard.writeText(page.state.url); return; }
    if (command.type === "close") { await this.close(command.pageId); return; }
    if (page.initializing) throw new Error("BROWSER_PAGE_INITIALIZING");
    if (command.type === "resume") { if (page.execution) throw new Error("上一步尚未停止。"); await this.takeover(page); page.state.paused = false; return; }
    if (command.type === "dialog") {
      if (!page.state.dialog || page.dialogResponse) throw new Error("BROWSER_DIALOG_UNAVAILABLE");
      const stopped = this.takeover(page);
      try { await this.answerDialog(page, command.accept, command.text); }
      finally { await stopped; }
      return;
    }
    await this.takeover(page);
    switch (command.type) {
      case "navigate": void contents.loadURL(browserUrl(command.url)).catch(function failed() { page.state.loading = false; page.state.error ??= "网页加载失败。"; }); break;
      case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload": contents.reload(); break;
      case "stop": contents.stop(); break;
    }
  }
  /** 弹窗应答独立于被阻塞动作，仅允许当前弹窗的一次应答，不释放原动作执行位。 */
  private async answerDialog(page: PageRecord, accept: boolean, text: string, signal?: AbortSignal): Promise<void> {
    if (!page.state.dialog || page.dialogResponse) throw new Error("BROWSER_DIALOG_UNAVAILABLE");
    const current = page.state.dialog;
    page.dialogResponse = page.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept, promptText: text }).then(function answered() {});
    try {
      await page.dialogResponse;
      if (signal?.aborted) throw new Error("BROWSER_OUTCOME_UNKNOWN");
      if (page.state.dialog === current) { page.state.dialog = undefined; page.state.revision++; }
      this.show();
    } catch { page.state.paused = true; throw new Error("BROWSER_OUTCOME_UNKNOWN"); }
    finally { page.dialogResponse = undefined; }
  }
  /** 用户接管等待旧 driver 确认结束，不能将发出取消误报为已回滚。 */
  private async takeover(page: PageRecord, reopen = true): Promise<void> {
    if (page.takeover) return page.takeover;
    page.takeover = this.stopPage(page, reopen);
    try { await page.takeover; } finally { page.takeover = undefined; }
  }
  /** 收割驱动并重建专属连接，暂停状态只由显式恢复动作解除。 */
  private async stopPage(page: PageRecord, reopen: boolean): Promise<void> {
    page.state.revision++;
    this.onTakeover?.(page.state.id);
    page.state.paused = true; page.abort?.abort();
    if (page.execution) { try { await page.execution; } catch { /* 已记录失败，继续收割自有 helper。 */ } }
    if (page.driver) {
      await page.driver.stop(); page.driver = undefined;
      if (reopen && !page.view.webContents.isDestroyed()) {
        const contents = page.view.webContents;
        page.cdp = new BrowserCdp(contents.debugger, page.state.id, function info() { return { url: contents.getURL(), title: contents.getTitle() }; });
        await page.cdp.start();
      }
    }
    this.occupancy.release(page.state.id); page.state.occupied = undefined;
    page.apControlled = false;
    page.localOrigin = undefined;
    this.show();
  }
  /** 受信调用方在上层审批后进入，执行期间固定页面及文档代次。 */
  async execute(pageId: string, caller: string, turn: string, revision: number, action: BrowserAction, signal: AbortSignal): Promise<unknown> {
    const page = this.pages.get(pageId);
    if (!page || page.state.revision !== revision) throw new Error("BROWSER_PAGE_CHANGED");
    const input = action.type !== "snapshot" && action.type !== "screenshot";
    if (page.state.paused || page.state.dialog || page.takeover || this.closing || signal.aborted || input && (!this.bounds || this.bounds.hidden)) throw new Error("BROWSER_PAGE_UNAVAILABLE");
    this.occupancy.enter(pageId, caller, turn); page.state.occupied = caller;
    if (page.view.webContents.isFocused()) this.window?.webContents.focus();
    this.show();
    const abort = new AbortController(); page.abort = abort; page.input = input;
    /** 原调用取消只影响该页，不终止别的页面。 */
    function cancel() { abort.abort(); }
    signal.addEventListener("abort", cancel, { once: true });
    const self = this;
    /** 驱动准备也属于占用期间，期间页面变化禁止执行。 */
    async function run() {
      if (action.type === "screenshot") return captureBrowserScreenshot(function capture() { return page!.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); }, abort.signal);
      page!.driver ??= new BrowserDriver(await browserDriverPath(self.resources), page!.cdp);
      if (abort.signal.aborted || page!.state.revision !== revision || input && (!self.bounds || self.bounds.hidden)) throw new Error("BROWSER_PAGE_CHANGED");
      return page!.driver.execute(action, abort.signal);
    }
    try { page.execution = run(); const result = await page.execution; this.occupancy.settle(pageId); return result; }
    catch (error) { this.occupancy.settle(pageId, true); page.state.paused = true; throw error; }
    finally { signal.removeEventListener("abort", cancel); page.execution = undefined; page.abort = undefined; page.input = false; }
  }
  /** 可信回合结束释放本人的空闲页；上层先取消该回合在途操作。 */
  release(caller: string, turn: string): void { for (const page of this.pages.values()) if (this.occupancy.release(page.state.id, caller, turn)) page.state.occupied = undefined; this.show(); }
  /** 事件回调结束前完成单次决定，未确认时不产生外部请求或磁盘写入。 */
  private confirmBrowserEffect(message: string, detail: string): boolean {
    if (!this.window || this.window.isDestroyed() || this.closing) return false;
    try {
      return dialog.showMessageBoxSync(this.window, { type: "warning", title: "浏览器操作待确认", message, detail, buttons: ["拒绝", "仅本次"], defaultId: 0, cancelId: 0 }) === 1;
    } catch { return false; }
  }
  /** 下载归属由 WebContents 反查，保存路径由宿主选择并原子避免覆盖。 */
  private download(item: DownloadItem, webContentsId: number): void {
    const page = [...this.pages.values()].find(function owner(page) { return page.view.webContents.id === webContentsId; });
    if (!page || page.reviewUrl || this.closing) { item.cancel(); return; }
    const id = randomUUID(); const name = basename(item.getFilename());
    try {
      let directory = this.preferences.downloadDirectory ?? app.getPath("downloads");
      if (this.preferences.askDownload && this.window) { const picked = dialog.showOpenDialogSync(this.window, { title: "选择下载保存目录", properties: ["openDirectory", "createDirectory"] }); if (!picked?.[0]) { item.cancel(); return; } directory = picked[0]; }
      if (!existsSync(directory)) throw new Error();
      const source = page.apControlled ? browserHistoryUrl(item.getURL()) ?? "当前页面" : undefined;
      const self = this;
      const path = reserveDownload(directory, name, source ? function approve(destination) {
        return self.confirmBrowserEffect("下载文件需要确认", `来源 ${source}\n保存到 ${destination}`) && page.apControlled === true && self.pages.get(page.state.id) === page;
      } : undefined);
      item.setSavePath(path);
      const state: BrowserDownload = { id, pageId: page.state.id, name: basename(path), received: 0, total: item.getTotalBytes(), state: "progressing" };
      this.downloads.set(id, { state, item });
      item.on("updated", function update(_event, status) { state.received = item.getReceivedBytes(); state.total = item.getTotalBytes(); state.state = status; });
      item.once("done", function done(_event, status) { state.state = status; state.received = item.getReceivedBytes(); });
    } catch (error) {
      item.cancel();
      if (!(error instanceof Error && error.message === "BROWSER_DOWNLOAD_DENIED")) this.notice = "下载保存失败，请检查下载目录。";
    }
  }
  /** 退出提示与终端确认串行，取消则保留浏览器和全部终端。 */
  async confirmExit(): Promise<boolean> {
    if (![...this.downloads.values()].some(function active(download) { return download.state.state === "progressing"; })) return true;
    if (!this.window || this.window.isDestroyed()) return false;
    if (!await this.onConfirmExit?.()) return false;
    for (const download of this.downloads.values()) if (download.state.state === "progressing") download.item.cancel();
    return true;
  }
  /** 关页明确销毁 WebContents；View 移除本身不会销毁网页进程。 */
  async close(id: string): Promise<void> {
    const page = this.pages.get(id); if (!page) return;
    page.closing ??= this.closePage(page);
    return page.closing;
  }
  /** 创建取消与人工关页共享清理，失败也销毁原生内容，迟到初始化不能复活页面。 */
  private async closePage(page: PageRecord): Promise<void> {
    const id = page.state.id;
    for (const download of this.downloads.values()) if (download.state.pageId === id && download.state.state !== "completed" && download.state.state !== "cancelled") download.item.cancel();
    try { await this.takeover(page, false); }
    finally {
      try { await page.cdp.close(); }
      finally {
        this.window?.contentView.removeChildView(page.view);
        if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false });
        await page.document?.();
        this.pages.delete(id);
        const scope = this.scope(page.state.desktopWorkspaceId);
        if (scope.active === id) scope.active = [...this.pages.values()].filter(function belongs(other) { return other.state.desktopWorkspaceId === page.state.desktopWorkspaceId; }).at(-1)?.state.id ?? null;
        for (const [downloadId, download] of this.downloads) if (download.state.pageId === id) this.downloads.delete(downloadId);
        this.show();
      }
    }
  }
  /** 仅销毁本次浏览器临时数据，下载文件和终端生命周期不受影响。 */
  async clear(): Promise<void> {
    this.closing = true;
    try {
      await this.onClear?.();
      for (const download of this.downloads.values()) if (download.state.state === "progressing") download.item.cancel();
      for (const id of [...this.pages.keys()]) await this.close(id);
      if (this.inputShield) { this.window?.contentView.removeChildView(this.inputShield); if (!this.inputShield.webContents.isDestroyed()) this.inputShield.webContents.close({ waitForBeforeUnload: false }); this.inputShield = undefined; }
      for (const partition of this.sessions.values()) { await partition.clearStorageData(); await partition.clearCache(); await partition.closeAllConnections(); }
      this.sessions.clear(); this.downloads.clear(); this.scopes.clear(); this.bounds = undefined;
    } finally { this.closing = false; }
  }
}
