// loopback真实HTTP与假网页执行器验证身份、许可、回合和断连，不启动CLI或Electron。
import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserServer } from "../src/browser-server";
import { BrowserAccess } from "../src/browser-access";

test("browser transport rejects role spoofing, changed/replayed permits and ended turns", async function transport() {
  const executed: string[] = [];
  const access = new BrowserAccess({ preferences: function preferences() { return { permission: "always", historyDays: 30, askDownload: false }; }, target: function target() { return { url: "https://example.test" }; }, async execute(principal) { executed.push(principal.kind); assert.equal(principal.desktopWorkspaceId, "desktop-A"); return { ok: true }; }, async release() {} });
  const server = new BrowserServer(access); await server.start();
  const env = server.register("pane", 1, "workspace", "workspace", "desktop-A");
  let watch: ClientRequest | undefined;
  /** 只发送固定测试JSON，不调用真实浏览器动作。 */
  async function post(token: string, path: string, value: unknown) { return (await fetch(server.endpoint + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(value) })).json() as Promise<{ ok: boolean; result?: { token?: string; permit?: string }; error?: string }>; }
  try {
    assert.equal((await post(env.AUTOPILOT_BROWSER_AGENT_TOKEN, "/connect-native", { runId: "fake-ap" })).ok, false);
    const connection = await post(env.AUTOPILOT_BROWSER_AGENT_TOKEN, "/connect-agent", { runId: "agent", agent: "codex" });
    const token = connection.result!.token!;
    assert.equal((await post(token, "/turn/begin", { turnId: "one" })).ok, false);
    await new Promise<void>(function monitor(resolve, reject) { watch = httpRequest(server.endpoint + "/watch", { method: "POST", headers: { Authorization: `Bearer ${token}` } }, function ready(response) { response.resume(); resolve(); }); watch.on("error", reject); watch.end("{}"); });
    await post(token, "/turn/begin", { turnId: "one" });
    const authorization = { mode: "full_access", approvedOnce: true };
    assert.equal((await post(token, "/request", { turnId: "one", callId: "fake", operation: { type: "list" }, authorization })).ok, false);
    const operation = { type: "open", url: "https://example.test" };
    const permit = (await post(token, "/permit", { turnId: "one", callId: "native-call", operation })).result!.permit!;
    assert.equal((await post(token, "/call", { permit, operation: { type: "list" } })).ok, false);
    const executing = post(token, "/call", { permit, operation, authorization });
    for (let n = 0; n < 100 && !access.snapshot().length; n++) await delay(5);
    assert.equal(access.snapshot().length, 1); access.answer(access.snapshot()[0].id, "always");
    assert.equal((await executing).ok, true); assert.deepEqual(executed, ["third-party"]);
    assert.equal((await post(token, "/call", { permit, operation })).ok, false);
    const page = { pageId: "12345678-1234-4234-8234-123456789012", revision: 0 };
    for (const action of [{ type: "wait", ...page, condition: "load", timeout: 1000 }, { type: "downloads", ...page }, { type: "cancel-download", ...page, id: page.pageId }]) {
      access.tighten();
      const granted = (await post(token, "/permit", { turnId: "one", callId: action.type, operation: action })).result!.permit!;
      const request = post(token, "/call", { permit: granted, operation: action });
      for (let n = 0; n < 100 && !access.snapshot().length; n++) await delay(5);
      assert.equal(access.snapshot()[0].operation, action.type);
      access.answer(access.snapshot()[0].id, "once");
      assert.equal((await request).ok, true);
      assert.equal((await post(token, "/call", { permit: granted, operation: action })).ok, false);
    }
    await post(token, "/turn/suspend", { turnId: "one" });
    assert.equal((await post(token, "/call", { permit, operation })).ok, false);
    await post(token, "/turn/begin", { turnId: "one" });
    const next = (await post(token, "/permit", { turnId: "one", callId: "next-call", operation })).result!.permit!;
    const nextRequest = post(token, "/call", { permit: next, operation });
    for (let n = 0; n < 100 && !access.snapshot().length; n++) await delay(5);
    access.answer(access.snapshot()[0].id, "once");
    assert.equal((await nextRequest).ok, true); assert.equal(access.snapshot().length, 0);
    await post(token, "/turn/end", { turnId: "one" });
    assert.equal((await post(token, "/turn/begin", { turnId: "one" })).ok, false);
    watch!.destroy(); await delay(10);
    assert.equal((await post(token, "/turn/begin", { turnId: "new" })).ok, false);
  } finally { watch?.destroy(); await server.stop(); }
});
