// S2 生命周期通过模块替身验证，不启动 Electron、真实网页、driver 或系统对话框。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

/** 假网页保存导航事实与销毁次数，不模拟操作成功的真实浏览器证据。 */
class Contents extends EventEmitter {
  static next = 0;
  id = ++Contents.next;
  url = "";
  loads: string[] = [];
  destroyed = false;
  debugger = Object.assign(new EventEmitter(), { attach: function attach() {}, isAttached: function attached() { return true; }, detach: function detach() {}, sendCommand: async function sendCommand() { return {}; } });
  navigationHistory = { canGoBack: function back() { return false; }, canGoForward: function forward() { return false; }, goBack: function back() {}, goForward: function forward() {} };
  setWindowOpenHandler(): void {}
  async loadURL(url: string): Promise<void> { this.loads.push(url); this.url = url; this.emit("did-navigate"); }
  getURL(): string { return this.url; }
  getTitle(): string { return "test page"; }
  isLoading(): boolean { return false; }
  isFocused(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; }
  reload(): void {}
  stop(): void {}
}
/** View 替身只记录边界配置及可见性。 */
class View {
  static all: View[] = [];
  webContents = new Contents(); visible = false;
  constructor(readonly options: { webPreferences: Record<string, unknown> }) { View.all.push(this); }
  setVisible(value: boolean): void { this.visible = value; }
  setBounds(): void {}
  setBackgroundColor(): void {}
}

test("browser host isolates manual and agent partitions, tracks pages and destroys sessions without terminals", async function lifecycle(t) {
  const partitions: Array<EventEmitter & { cleared: boolean }> = [];
  const downloadRoot = await mkdtemp(path.join(tmpdir(), "ap-browser-download-confirm-"));
  const effects: string[] = [];
  let allowEffect = false;
  const guards = new Map<EventEmitter, (request: { url: string; method: string; resourceType: string; webContentsId: number }, callback: (value: { cancel?: boolean }) => void) => void>();
  const electron = {
    WebContentsView: View,
    session: { fromPartition: function partition(name: string) {
      assert.ok(!name.startsWith("persist:"));
      const value = Object.assign(new EventEmitter(), { cleared: false, webRequest: { onBeforeRequest(listener: NonNullable<ReturnType<typeof guards.get>>) { guards.set(value, listener); } }, setPermissionRequestHandler: function permissions() {}, setPermissionCheckHandler: function permissions() {}, clearStorageData: async function clear() { value.cleared = true; }, clearCache: async function cache() {}, closeAllConnections: function connections() {} });
      partitions.push(value); return value;
    } },
    clipboard: { writeText: function copy() {} }, dialog: { showMessageBoxSync(_window: unknown, options: { message: string }) { effects.push(options.message); return allowEffect ? 1 : 0; } }, app: { getPath() { return downloadRoot; } },
  };
  const require = createRequire(__filename); const modulePath = require.resolve("electron");
  const old = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: electron } as NodeModule;
  const { BrowserHost } = require("../src/browser-host") as typeof import("../src/browser-host");
  const host = new BrowserHost("unused");
  const children = new Set<View>();
  host.bind({ isDestroyed: function destroyed() { return false; }, getContentSize: function size() { return [1200, 800]; }, contentView: { addChildView: function add(view: View) { children.add(view); }, removeChildView: function remove(view: View) { children.delete(view); } } } as unknown as Electron.BrowserWindow);
  try {
    const shield = View.all[0];
    const one = await host.open("https://example.test/?q=retained&token=secret");
    const two = await host.open("https://example.test/next");
    await host.open("https://example.test/agent", "agent1", "workspace1");
    const pages = View.all.slice(1);
    assert.deepEqual(pages[0].webContents.loads, ["about:blank", "https://example.test/?q=retained&token=secret"]);
    assert.equal(partitions.length, 2);
    assert.equal(pages[0].options.webPreferences.session, pages[1].options.webPreferences.session);
    assert.notEqual(pages[0].options.webPreferences.session, pages[2].options.webPreferences.session);
    for (const view of View.all) { assert.equal(view.options.webPreferences.sandbox, true); assert.equal(view.options.webPreferences.nodeIntegration, false); assert.equal(view.options.webPreferences.preload, undefined); }
    host.layout({ x: 600, y: 100, width: 600, height: 650, hidden: false });
    await host.command({ type: "select", pageId: one }); assert.equal(pages[0].visible, true); assert.equal(pages[1].visible, false);
    // renderer布局回报比原生窗口resize晚一帧时仍应显示交集，不能整页空白。
    host.layout({ x: 600, y: 100, width: 601, height: 701, hidden: false }); assert.equal(pages[0].visible, true);
    host.layout({ x: 1300, y: 100, width: 600, height: 650, hidden: false }); assert.equal(pages[0].visible, false);
    host.layout({ x: 600, y: 100, width: 600, height: 650, hidden: true }); assert.equal(pages[0].visible, false);
    await host.preferencesUpdate(host.settings());
    await assert.rejects(host.execute(one, "agent1", "turn1", host.snapshot().pages[0].revision, { type: "click", ref: "@e1" }, new AbortController().signal), /BROWSER_PAGE_UNAVAILABLE/);
    assert.equal(host.snapshot().pages[0].occupied, undefined);
    assert.ok(host.snapshot().history.some(function entry(item) { return item.url === "https://example.test/?q=retained"; }));
    await host.preferencesUpdate({ permission: "once", historyDays: 0, askDownload: false });
    assert.equal(host.snapshot().history.length, 0);
    await host.command({ type: "takeover", pageId: one }); assert.equal(host.snapshot().pages.find(function page(page) { return page.id === one; })?.paused, true);
    await host.command({ type: "resume", pageId: one });
    assert.equal(host.snapshot().pages.find(function page(page) { return page.id === one; })?.paused, false);
    host.layout({ x: 600, y: 100, width: 600, height: 650, hidden: false });
    await assert.rejects(host.execute(one, "agent1", "turn1", host.snapshot().pages[0].revision, { type: "snapshot" }, new AbortController().signal));
    assert.equal(shield.visible, true);
    let prevented = false;
    shield.webContents.emit("before-mouse-event", { preventDefault: function prevent() { prevented = true; } }, { type: "mouseDown" });
    await new Promise(function settle(resolve) { setImmediate(resolve); });
    assert.equal(prevented, true); assert.equal(shield.visible, false); assert.equal(host.snapshot().pages[0].occupied, undefined);
    await host.close(two); assert.equal(pages[1].webContents.destroyed, true); assert.equal(host.snapshot().pages.length, 2);
    const documentRoot = await mkdtemp(path.join(tmpdir(), 'ap-host-document-'));
    const documentFile = path.join(documentRoot, 'selected.md'); await writeFile(documentFile, '# page-owned service');
    const principal = { id: 'document-owner', kind: 'third-party' as const, label: 'fixture', workspace: documentRoot };
    const selected = await host.prepare(principal, { type: 'document', path: documentFile });
    const documentPage = await host.agentRequest(principal, 'document-turn', selected, new AbortController().signal) as { id: string; url: string };
    assert.match(await (await fetch(documentPage.url)).text(), /page-owned service/);
    await host.close(documentPage.id); await assert.rejects(fetch(documentPage.url));
    const closingPage = await host.agentRequest(principal, 'document-turn', selected, new AbortController().signal) as { id: string; url: string };
    await host.clear(); await assert.rejects(fetch(closingPage.url)); assert.equal(host.snapshot().pages.length, 0); assert.equal(host.snapshot().expanded, false); assert.equal(children.size, 0); assert.ok(partitions.every(function cleared(partition) { return partition.cleared; })); assert.ok(View.all.every(function closed(view) { return view.webContents.destroyed; }));
    await t.test("workspace IDs retain pages, selection and collapse without background focus or stale layout", async function workspaceScopes(scope) {
      host.bind({ isDestroyed: function destroyed() { return false; }, getContentSize: function size() { return [1200, 800]; }, contentView: { addChildView: function add(view: View) { children.add(view); }, removeChildView: function remove(view: View) { children.delete(view); } } } as unknown as Electron.BrowserWindow);
      // 相同目录标签不参与归属；ID 才是唯一键。
      const groups = [{ id: "A", name: "same-directory" }, { id: "B", name: "same-directory" }];
      const bounds = { x: 600, y: 100, width: 600, height: 650, hidden: false };
      await host.setWorkspaces("A", groups);
      const first = await host.open("https://example.test/a1"); const firstView = View.all.at(-1)!;
      const second = await host.open("https://example.test/a2"); const secondView = View.all.at(-1)!;
      host.layout(bounds, "A");
      await host.command({ type: "select", pageId: first }, "A");
      assert.equal(firstView.visible, true); assert.equal(secondView.visible, false);
      const firstLoads = [...firstView.webContents.loads];
      // 同工作区顶部Tab导航会同步同一组ID，不能改变浏览器状态与实例。
      await host.setWorkspaces("A", groups);
      assert.equal(host.snapshot().active, first); assert.equal(firstView.visible, true);
      await host.setWorkspaces("B", groups);
      assert.deepEqual(host.snapshot().pages, []); assert.equal(host.snapshot().active, null); assert.equal(host.snapshot().expanded, false);
      assert.equal(firstView.visible, false); assert.equal(firstView.webContents.destroyed, false);
      host.layout(bounds, "A"); assert.equal(firstView.visible, false);
      await assert.rejects(host.command({ type: "open", url: "https://example.test/stale" }, "A"), /BROWSER_WORKSPACE_CHANGED/);
      await host.command({ type: "open", url: "https://example.test/b" }, "B");
      const b = host.snapshot().active!; const bView = View.all.at(-1)!;
      assert.equal(host.snapshot().pages[0].desktopWorkspaceId, "B");
      assert.equal(host.snapshot().pages[0].owner, "manual");
      host.layout(bounds, "B"); assert.equal(bView.visible, true);
      const owner = { id: "agent-A", kind: "ap" as const, label: "Autopilot", workspace: "same-directory", desktopWorkspaceId: "A" };
      const background = await host.agentRequest(owner, "turn-A", { type: "open", url: "https://example.test/background" }, new AbortController().signal) as { id: string; revision: number };
      assert.equal(host.snapshot().active, b); assert.equal(bView.visible, true);
      assert.equal(host.snapshot("A").active, background.id);
      await host.agentRequest(owner, "turn-A", { type: "select", pageId: first, revision: host.snapshot("A").pages[0].revision }, new AbortController().signal);
      assert.equal(host.snapshot().active, b); assert.equal(host.snapshot("A").active, first);
      const ownedList = await host.agentRequest(owner, "turn-A", { type: "list" }, new AbortController().signal) as Array<{ desktopWorkspaceId: string }>;
      assert.ok(ownedList.every(function belongs(page) { return page.desktopWorkspaceId === "A"; }));
      await assert.rejects(host.prepare(owner, { type: "select", pageId: b, revision: 0 }), /BROWSER_PAGE_UNAVAILABLE/);
      const documentOwner = { ...owner, workspaceRoot: documentRoot };
      const document = await host.prepare(documentOwner, { type: "document", path: documentFile });
      const backgroundDocument = await host.agentRequest(documentOwner, "turn-A", document, new AbortController().signal) as { id: string; url: string };
      await scope.test("AP 实际下载在磁盘写入前确认，新本机导航与 HTTP 删除同样受保护", function browserEffects() {
        const view = View.all.at(-1)!;
        const partition = view.options.webPreferences.session as EventEmitter;
        const guard = guards.get(partition)!;
        /** 模拟 Chromium 在实际网络请求发送前向宿主询问。 */
        function dispatch(url: string, method = "GET", resourceType = "mainFrame"): boolean | undefined {
          let cancelled: boolean | undefined;
          guard({ url, method, resourceType, webContentsId: view.webContents.id }, function checked(result) { cancelled = result.cancel; });
          return cancelled;
        }
        assert.equal(dispatch(backgroundDocument.url), undefined);
        assert.equal(dispatch("http://127.0.0.1:8080/other", "GET", "xhr"), true);
        assert.equal(dispatch("http://127.0.0.1:8080/other"), true);
        assert.equal(dispatch("https://example.test/resource", "DELETE", "xhr"), true);
        assert.equal(dispatch("https://example.test/resource"), undefined);
        assert.deepEqual(effects, ["浏览器访问本机或内网需要确认", "浏览器删除操作需要确认"]);
        const file = path.join(downloadRoot, "fixture.txt");
        let cancelled = false;
        let saved: string | undefined;
        const item = Object.assign(new EventEmitter(), {
          getFilename() { return "fixture.txt"; }, getURL() { return "https://example.test/fixture.txt"; }, getTotalBytes() { return 1; },
          setSavePath(value: string) { saved = value; }, cancel() { cancelled = true; },
        });
        partition.emit("will-download", {}, item, view.webContents);
        assert.equal(cancelled, true);
        assert.equal(saved, undefined);
        assert.equal(existsSync(file), false);
        allowEffect = true;
        partition.emit("will-download", {}, item, view.webContents);
        assert.equal(saved, file);
        assert.equal(existsSync(file), true);
        assert.equal(effects.at(-1), "下载文件需要确认");
      });
      assert.equal(host.snapshot().active, b); assert.equal(bView.visible, true);
      assert.match(await (await fetch(backgroundDocument.url)).text(), /page-owned service/);
      await host.setWorkspaces("A", groups);
      assert.equal(host.snapshot().active, backgroundDocument.id); assert.equal(host.snapshot().expanded, true);
      assert.equal(bView.visible, false); assert.deepEqual(firstView.webContents.loads, firstLoads);
      await host.command({ type: "select", pageId: first }); host.layout(bounds, "A");
      assert.equal(firstView.visible, true);
      await host.command({ type: "expand", expanded: false });
      await host.setWorkspaces("B", groups); await host.setWorkspaces("A", groups);
      assert.equal(host.snapshot().expanded, false); assert.equal(host.snapshot().active, first); assert.equal(firstView.visible, false);
      await host.command({ type: "close", pageId: first });
      assert.equal(firstView.webContents.destroyed, true); assert.equal(host.snapshot().pages.length, 3);
      assert.ok(host.snapshot().pages.some(function selected(page) { return page.id === host.snapshot().active; }));
      // 初始化跨越切换时保持发起ID，完成不能抢B的页面或展开状态。
      const originalLoad = Contents.prototype.loadURL;
      let continueOpening!: () => void;
      Contents.prototype.loadURL = async function deferred(url: string) { if (url === "about:blank") await new Promise<void>(function blocked(resolve) { continueOpening = resolve; }); await originalLoad.call(this, url); };
      let late: Promise<string>;
      try {
        late = host.open("https://example.test/late");
        await host.setWorkspaces("B", groups); await host.command({ type: "expand", expanded: false });
        continueOpening(); await late;
        assert.equal(host.snapshot().active, b); assert.equal(host.snapshot().expanded, false);
        assert.equal(host.snapshot("A").pages.at(-1)?.url, "https://example.test/late");
      } finally { Contents.prototype.loadURL = originalLoad; }
      await host.setWorkspaces("B", [groups[1]]);
      assert.equal(secondView.webContents.destroyed, true);
      assert.deepEqual(host.snapshot("A").pages, []);
      await assert.rejects(fetch(backgroundDocument.url));
      await assert.rejects(host.agentRequest(owner, "turn-A", { type: "open", url: "https://example.test/deleted" }, new AbortController().signal), /BROWSER_WORKSPACE_UNAVAILABLE/);
      assert.equal(host.snapshot().pages.length, 1); assert.equal(bView.webContents.destroyed, false);
      await host.setWorkspaces(null, []); assert.equal(bView.webContents.destroyed, true); assert.equal(host.snapshot().expanded, false);
      await host.clear();
    });
  } finally { await host.clear(); if (old) require.cache[modulePath] = old; else delete require.cache[modulePath]; }
});
