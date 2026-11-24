// S1/S2 非实机检查：单页 CDP 边界、占用、固定动作、历史地址与下载文件保留。
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { BrowserCdp, type PageDebugger } from "../src/browser-cdp";
import { BrowserOccupancy } from "../src/browser-occupancy";
import { browserUrl, isBrowserAction, isBrowserBounds, isBrowserCommand } from "../src/browser-contract";
import { browserDriverRequest } from "../src/browser-driver";
import { browserHistoryUrl, reserveDownload } from "../src/browser-data";

/** 模拟 debugger 仅记录固定页面的命令，不加载 Electron 或网页。 */
class Debugger extends EventEmitter implements PageDebugger {
  attached = false;
  calls: string[] = [];
  attach(): void { this.attached = true; }
  detach(): void { this.attached = false; }
  isAttached(): boolean { return this.attached; }
  async sendCommand(method: string): Promise<unknown> { this.calls.push(method); return { page: "one" }; }
}

test("browser CDP binds target and session, rejects privilege escalation and inactive writes", async function boundary() {
  const target = new Debugger(); const cdp = new BrowserCdp(target, "one", function info() { return { url: "https://example.test", title: "one" }; });
  cdp.setActive(true);
  assert.deepEqual(await cdp.dispatch("Target.attachToTarget", { targetId: "one" }), { sessionId: "one" });
  for (const [method, params, session] of [["Target.attachToTarget", { targetId: "main" }, undefined], ["Runtime.evaluate", {}, "two"], ["Browser.close", {}, undefined], ["Target.createTarget", {}, undefined], ["Page.navigate", { url: "file:///secret" }, "one"]] as const) await assert.rejects(cdp.dispatch(method, params, session), /DENIED/);
  await cdp.dispatch("DOM.getDocument", {}, "one"); assert.deepEqual(target.calls, ["DOM.getDocument"]);
  cdp.setActive(false); await assert.rejects(cdp.dispatch("Input.dispatchKeyEvent", {}, "one"), /DENIED/);
  await cdp.close(); cdp.setActive(true); await assert.rejects(cdp.dispatch("DOM.getDocument", {}), /DENIED/);
});

test("browser CDP authenticates websocket path and rejects browser Origin", async function authentication() {
  const cdp = new BrowserCdp(new Debugger(), "one", function info() { return { url: "https://example.test", title: "one" }; });
  await cdp.start(); cdp.setActive(true);
  try {
    /** 连接失败预期只验证代理认证，不启动真正 driver。 */
    async function denied(url: string, origin?: string): Promise<void> { await new Promise<void>(function connect(resolve, reject) { const socket = new WebSocket(url, origin ? { origin } : {}); socket.on("open", function unexpected() { socket.close(); reject(new Error("authenticated unexpectedly")); }); socket.on("error", function expected() { resolve(); }); }); }
    await denied(cdp.url.replace(/\/[a-f0-9]+$/, "/wrong")); await denied(cdp.url, "https://example.test");
    await new Promise<void>(function connect(resolve, reject) { const socket = new WebSocket(cdp.url); socket.on("open", function request() { socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" })); }); socket.on("message", function reply(data) { try { assert.equal(JSON.parse(data.toString()).result.targetInfos[0].targetId, "one"); socket.close(); resolve(); } catch (error) { reject(error); } }); socket.on("error", reject); });
  } finally { await cdp.close(); }
});

test("browser CDP cancellation closes pending startup and rejects reopening", async function cancelledStartup() {
  const cdp = new BrowserCdp(new Debugger(), "one", function info() { return { url: "about:blank", title: "" }; });
  const starting = cdp.start();
  const cancelled = assert.rejects(starting, /BROWSER_CDP_DENIED/);
  await cdp.close();
  await cancelled;
  assert.equal(cdp.url, "");
  await assert.rejects(cdp.start(), /BROWSER_CDP_DENIED/);
});

test("browser CDP idle waits for submitted commands before handing off", async function draining() {
  const target = new Debugger();
  let finish!: () => void; let entered!: () => void;
  const started = new Promise<void>(function ready(resolve) { entered = resolve; });
  target.sendCommand = async function delayed() { entered(); await new Promise<void>(function wait(resolve) { finish = resolve; }); return {}; };
  const cdp = new BrowserCdp(target, "one", function info() { return { url: "https://example.test", title: "one" }; });
  await cdp.start(); cdp.setActive(true);
  const socket = new WebSocket(cdp.url);
  try {
    await new Promise<void>(function open(resolve, reject) { socket.on("open", resolve); socket.on("error", reject); });
    socket.send(JSON.stringify({ id: 1, method: "Input.dispatchKeyEvent", sessionId: "one" }));
    await started;
    let done = false; const idle = cdp.idle().then(function stopped() { done = true; });
    await new Promise(function tick(resolve) { setImmediate(resolve); }); assert.equal(done, false);
    await assert.rejects(cdp.dispatch("DOM.getDocument", {}), /DENIED/);
    finish(); await idle; assert.equal(done, true);
  } finally { socket.terminate(); await cdp.close(); }
});

test("browser page occupancy spans commands and blocks simultaneous or uncertain takeover", function ownership() {
  const locks = new BrowserOccupancy(); locks.enter("one", "agentA", "turn1"); locks.enter("two", "agentB", "turn2");
  assert.throws(function concurrent() { locks.enter("one", "agentA", "turn1"); }, /等待/);
  assert.equal(locks.release("one"), false); locks.settle("one");
  assert.throws(function other() { locks.enter("one", "agentB", "turn2"); }, /等待/);
  locks.enter("one", "agentA", "turn1"); locks.settle("one", true);
  assert.throws(function uncertain() { locks.enter("one", "agentA", "turn1"); }, /等待/);
  assert.equal(locks.release("one", "agentB", "turn2"), false); assert.equal(locks.release("one", "agentA", "turn1"), true);
  locks.enter("one", "agentB", "turn2"); assert.equal(locks.owner("two"), "agentB");
});

test("browser actions reject scripts, extra fields and arbitrary targets", function actions() {
  assert.equal(isBrowserAction({ type: "fill", ref: "@e2", value: "normal input" }), true);
  for (const value of [{ type: "eval", script: "1" }, { type: "click", ref: "body" }, { type: "snapshot", commands: [] }, { type: "scroll", direction: "down", amount: NaN }]) assert.equal(isBrowserAction(value), false);
  assert.deepEqual(browserDriverRequest({ type: "fill", ref: "@e2", value: "--cdp something" }, "r"), { id: "r", action: "fill", selector: "@e2", value: "--cdp something" });
  assert.equal(isBrowserCommand({ type: "open", url: "file:///secret" }), false); assert.equal(isBrowserCommand({ type: "open", url: "https://example.test", cdp: "other" }), false);
  assert.equal(isBrowserBounds({ x: 0, y: 0, width: 100, height: 100, hidden: false }), true); assert.equal(isBrowserBounds({ x: -1, y: 0, width: 100, height: 100, hidden: false }), false);
  assert.throws(function credentials() { browserUrl("https://user:password@example.test"); });
});

test("browser history retains ordinary routing and download reservations never overwrite", async function data() {
  assert.equal(browserHistoryUrl("https://example.test/?q=hello&page=2&access_token=secret#token"), "https://example.test/?q=hello&page=2");
  assert.equal(browserHistoryUrl("javascript:alert(1)"), undefined);
  const directory = await mkdtemp(join(tmpdir(), "browser-data-test-"));
  try { await writeFile(join(directory, "report.txt"), "keep"); const first = reserveDownload(directory, "report.txt"); const second = reserveDownload(directory, "report.txt"); assert.notEqual(first, second); assert.equal(await readFile(join(directory, "report.txt"), "utf8"), "keep"); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

// 原生截图不启动driver，取消时丢弃迟到结果；收尾失败不能覆盖原始动作错误。
test("native screenshot keeps trusted PNG bounds and original driver errors", async function nativeCapture() {
  const { captureBrowserScreenshot, BrowserDriver } = await import("../src/browser-driver");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = { isEmpty: function empty() { return false; }, getSize: function size() { return { width: 10, height: 10 }; }, toPNG: function encode() { return png; } };
  const result = await captureBrowserScreenshot(async function capture() { return image; }, new AbortController().signal) as any;
  assert.deepEqual(result.content[0], { type: "image", mimeType: "image/png", data: png.toString("base64") });
  await assert.rejects(captureBrowserScreenshot(async function huge() { return { ...image, getSize: function size() { return { width: 20000, height: 20000 }; } }; }, new AbortController().signal), /SCREENSHOT_INVALID/);
  const abort = new AbortController();
  const pending = captureBrowserScreenshot(function pending() { return new Promise(function wait() {}); }, abort.signal);
  abort.abort(); await assert.rejects(pending, /BROWSER_CANCELLED/);
  const original = new Error("BROWSER_ORIGINAL_ACTION_FAILED");
  const driver = new BrowserDriver("unused", { setActive: function active() {}, diagnostics: function diagnostics() { return []; } } as any);
  (driver as any).endpoint = async function fail() { throw original; };
  driver.stop = async function cleanup() { throw new Error("BROWSER_CDP_OUTCOME_UNKNOWN"); };
  await assert.rejects(driver.execute({ type: "snapshot" }, new AbortController().signal), function unchanged(error) { return error === original; });
});

// 清理一直未完成时仍在固定期限内返回原动作错误，页面保持未知/暂停语义。
test("driver cleanup deadline retains original action failure", async function boundedCleanup(context) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { BrowserDriver } = await import("../src/browser-driver");
  const original = new Error("BROWSER_ORIGINAL_ACTION_FAILED");
  const driver = new BrowserDriver("unused", { setActive: function active() {}, diagnostics: function diagnostics() { return []; } } as any);
  (driver as any).endpoint = async function fail() { throw original; };
  driver.stop = function never() { return new Promise(function pending() {}); };
  const rejected = assert.rejects(driver.execute({ type: "snapshot" }, new AbortController().signal), function preserved(error) { return error === original; });
  await new Promise(function flush(resolve) { setImmediate(resolve); });
  context.mock.timers.tick(6500); await rejected;
  context.mock.timers.reset();
});
