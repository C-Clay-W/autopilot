// CLI浏览器客户端作为模块连接替身宿主，验证解析与原生会话身份，不运行CLI入口。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserServer } from "../src/browser-server";
import { BrowserAccess } from "../src/browser-access";
import { createDesktopBrowserCapability, parseBrowserArgs } from "../../cli/src/browser-client";
import type { BrowserPreferences } from "../src/browser-contract";

test("CLI browser parser and native transport preserve independent Core session identities", async function client() {
  assert.deepEqual(parseBrowserArgs(["list", "{}"]), { operation: { type: "list" } });
  for (const args of [["list", '{"turnId":"fake"}'], ["list", '{"type":"list"}'], ["eval", "{}"], ["list", "{}", "--permit", "fake"]]) assert.throws(function denied() { parseBrowserArgs(args); });
  assert.equal(createDesktopBrowserCapability({}), undefined);
  const owners: string[] = []; const released: string[] = [];
  let permission: BrowserPreferences["permission"] = "always";
  const access = new BrowserAccess({ preferences: function preferences() { return { permission, historyDays: 30, askDownload: false }; }, target: function target() { return { url: "list" }; }, async execute(principal) { owners.push(principal.id); return { ok: true }; }, async release(principal) { released.push(principal.id); } });
  const server = new BrowserServer(access); await server.start();
  const capability = createDesktopBrowserCapability(server.register("pane", 1, "workspace"))!;
  try {
    const a = { sessionId: "a", turnId: "one" }; const b = { sessionId: "b", turnId: "one" };
    await capability.request(a, "call", { type: "list" }, new AbortController().signal);
    await capability.request(b, "call", { type: "list" }, new AbortController().signal);
    assert.notEqual(owners[0], owners[1]);
    await assert.rejects(capability.request(a, "call", { type: "list" }, new AbortController().signal), /REPLAY/);
    const page = { pageId: "12345678-1234-4234-8234-123456789012", revision: 0 };
    for (const operation of [{ type: "wait", ...page, condition: "load", timeout: 1000 }, { type: "downloads", ...page }, { type: "cancel-download", ...page, id: page.pageId }] as const) {
      await capability.request(a, operation.type, operation, new AbortController().signal);
    }
    await capability.endTurn(a); assert.ok(released.includes(owners[0])); assert.ok(!released.includes(owners[1]));
    await capability.endTurn(b);
    permission = "follow_ap";
    const c = { sessionId: "c", turnId: "one" };
    const signal = AbortSignal.timeout(1000);
    await capability.request(c, "list", { type: "list" }, signal, { mode: "full_access" });
    await capability.request(c, "click", { type: "click", ...page, ref: "@e1" }, signal, { mode: "full_access", approvedOnce: true });
    assert.equal(access.snapshot().length, 0);
    await capability.endTurn(c);
  } finally { await server.stop(); }
});
