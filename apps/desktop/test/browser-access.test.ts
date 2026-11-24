// 宿主审批状态测试仅使用假的网页执行器，覆盖真实身份之外的权限规则。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserAccess } from "../src/browser-access";
import type { BrowserOperation, BrowserRequestAuthorization } from "@autopilot-agent/core";
import type { BrowserPreferences } from "../src/browser-contract";
import { OrchestrationBrowser } from "../src/orchestration-browser";
import type { OrchestrationRun } from "../src/orchestration-store";

test("browser approvals bind a single operation, turn and policy revision", async function permissions() {
  const executed: unknown[] = [];
  let permission: "once" | "always" = "once";
  const service = new BrowserAccess({ preferences: function preferences() { return { permission, historyDays: 30, askDownload: false }; }, target: function target() { return { url: "https://example.test" }; }, async execute(principal, turn, operation) { executed.push({ principal: principal.id, turn, operation }); return {}; }, async release() {} });
  service.begin({ id: "ap", kind: "ap", label: "AP", workspace: "w" }, "one");
  const signal = new AbortController().signal;
  await service.request("ap", "one", { type: "open", url: "https://example.test" }, signal);
  assert.equal(service.snapshot().length, 0); assert.equal(executed.length, 1);
  const one = service.request("ap", "one", { type: "list" }, signal);
  service.answer(service.snapshot()[0].id, "once"); await one;
  const two = service.request("ap", "one", { type: "list" }, signal);
  const old = service.snapshot()[0].id;
  service.answer(old, "always"); await two;
  await service.request("ap", "one", { type: "list" }, signal);
  assert.throws(function replay() { service.answer(old, "always"); }, /失效/);
  await service.end("ap", "one");
  await assert.rejects(service.request("ap", "one", { type: "list" }, signal), /TURN_UNAVAILABLE/);
  permission = "always";
  service.begin({ id: "other", kind: "third-party", label: "Other", workspace: "w" }, "one");
  const third = service.request("other", "one", { type: "open", url: "https://example.test" }, signal);
  assert.equal(service.snapshot()[0].modal, true);
  service.answer(service.snapshot()[0].id, "always"); service.tighten();
  await assert.rejects(third, /DENIED/);
  const cancelled = new AbortController();
  const pending = service.request("other", "one", { type: "list" }, cancelled.signal);
  cancelled.abort(); await assert.rejects(pending, /CANCELLED/); assert.equal(service.snapshot().length, 0);
  const ending = service.request("other", "one", { type: "list" }, signal);
  await service.end("other", "one"); await assert.rejects(ending, /CANCELLED/);
});

test("AP full access respects browser settings, exact documents, local targets and takeover", async function fullAccess() {
  let permission: BrowserPreferences["permission"] = "follow_ap";
  let pageUrl = "https://example.com/";
  let approvedLocal: true | undefined;
  const service = new BrowserAccess({
    preferences() { return { permission, historyDays: 30, askDownload: false }; },
    target(operation) {
      return { pageId: "pageId" in operation ? operation.pageId : undefined, url: "url" in operation ? operation.url : pageUrl, approvedLocal };
    },
    async execute(_principal, _turn, operation) { return operation.type; },
    async release() {},
  });
  service.begin({ id: "ap", kind: "ap", label: "AP", workspace: "w" }, "one");
  const signal = new AbortController().signal;
  const mode = { mode: "full_access" } as const;
  const authorized = { ...mode, approvedOnce: true } as const;
  const page = { pageId: "11223344-1122-4122-8122-112233445566", revision: 3 };
  const open = { type: "open", url: pageUrl } as const;
  const list = { type: "list" } as const;
  const look = { type: "snapshot", ...page } as const;
  const click = { type: "click", ...page, ref: "@e1" } as const;

  /** 卡片出现时核对动作和批准范围。 */
  async function ask(operation: BrowserOperation, authorization?: BrowserRequestAuthorization) {
    const pending = service.request("ap", "one", operation, signal, authorization);
    const [approval] = service.snapshot();
    assert.equal(approval?.operation, operation.type);
    service.answer(approval.id, "once");
    assert.equal(await pending, operation.type);
  }

  for (const operation of [open, list, look, { type: "screenshot", ...page }, { type: "wait", ...page, timeout: 1000, condition: "load" }, { type: "navigate", ...page, url: "https://example.com/next" }] as BrowserOperation[]) {
    const pending = service.request("ap", "one", operation, signal, mode);
    assert.equal(service.snapshot().length, 0);
    assert.equal(await pending, operation.type);
  }
  await ask(list);
  assert.equal(await service.request("ap", "one", click, signal, mode), "click");
  assert.equal(await service.request("ap", "one", click, signal, authorized), "click");
  await ask(click, { mode: "auto_approve" });
  assert.equal(await service.request("ap", "one", look, signal, { mode: "auto_approve" }), "snapshot");
  await ask({ type: "document", path: "README.md" }, authorized);
  await ask({ type: "open", url: "http://127.0.0.1:4200" }, mode);
  pageUrl = "http://[::1]:4200";
  await ask(look, mode);
  approvedLocal = true;
  assert.equal(await service.request("ap", "one", look, signal, mode), "snapshot");
  assert.equal(await service.request("ap", "one", click, signal, mode), "click");
  approvedLocal = undefined;
  pageUrl = open.url;
  permission = "once";
  await ask(open, mode);
  await ask(look, mode);
  assert.equal(await service.request("ap", "one", click, signal, authorized), "click");
  permission = "follow_ap";
  service.revokePage(page.pageId);
  await ask(look, mode);
  await ask(click, authorized);
});

test("orchestration passes browser authorization only through its bound execution segment", async function orchestration() {
  const service = new BrowserAccess({
    preferences() { return { permission: "follow_ap", historyDays: 30, askDownload: false }; },
    target() { return { url: "https://example.com/" }; },
    async execute(principal, _turn, operation) { return { workspace: principal.desktopWorkspaceId, operation: operation.type }; },
    async release() {},
  });
  const browser = new OrchestrationBrowser(service);
  const binding = { sessionId: "session", turnId: "turn" };
  const generation = "generation";
  const run = { id: "run", workspaceId: "example-workspace", checkout: "E:\\example-workspace", controller: { execution: { sessionId: binding.sessionId, generation } } } as OrchestrationRun;
  const signal = AbortSignal.timeout(1000);
  browser.connect(run.workspaceId, run.id);
  const key = browser.register(run, binding, generation, "example-workspace");
  assert.ok(key);
  const input = { key, callId: "list", operation: { type: "list" }, authorization: { mode: "full_access" } };
  await assert.rejects(browser.request(run, binding, "old-generation", input, signal), /TURN_UNAVAILABLE/);
  await assert.rejects(browser.request(run, binding, generation, { ...input, operation: { ...input.operation, authorization: input.authorization } }, signal), /ACTION_INVALID/);
  assert.deepEqual(await browser.request(run, binding, generation, input, signal), { workspace: "example-workspace", operation: "list" });
  assert.equal(browser.register(run, binding, generation, "example-workspace"), key);
  await assert.rejects(browser.request(run, binding, generation, input, signal), /REPLAY/);
  browser.disconnect(run.workspaceId);
  await assert.rejects(browser.request(run, binding, generation, input, signal), /TURN_UNAVAILABLE/);
});
