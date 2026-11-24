// 浏览器持久字段检查只读写隔离测试数据，不启动 Electron 或第三方 CLI。
import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreBrowserSaved } from "../src/browser-history";
import { emptyWorkspace, restoreWorkspace, savedWorkspace } from "../src/workspace";

test("browser preferences extend layout v2 and restore only sanitized unexpired deduplicated history", function persistence() {
  const original = emptyWorkspace();
  const old = savedWorkspace(original);
  const restored = restoreWorkspace(old);
  assert.deepEqual(restored.browser, { preferences: { permission: "follow_ap", historyDays: 30, askDownload: false }, history: [] });
  const priorOnce = { preferences: { permission: "once", historyDays: 30, askDownload: false }, history: [] };
  assert.deepEqual(restoreBrowserSaved(priorOnce), priorOnce);
  const now = Date.now();
  original.browser = restoreBrowserSaved({ preferences: { permission: "always", historyDays: 7, askDownload: true }, history: [
    { url: "https://example.test/?q=retained&token=secret", title: "new", visited: now - 1 },
    { url: "https://example.test/?q=retained", title: "old", visited: now - 2 },
    { url: "https://example.test/expired", title: "expired", visited: now - 8 * 86400000 },
    { url: "file:///private", title: "invalid", visited: now - 1 },
  ] }, now);
  const saved = savedWorkspace(original) as { version: number };
  assert.equal(saved.version, 2);
  const next = restoreWorkspace(saved);
  assert.deepEqual(next.browser, original.browser);
  assert.deepEqual(next.browser?.history, [{ url: "https://example.test/?q=retained", title: "new", visited: now - 1 }]);
  assert.equal(next.tabs.length, 0);
  assert.deepEqual(restoreBrowserSaved({ preferences: { ...original.browser.preferences, historyDays: 0 }, history: original.browser.history }).history, []);
});
