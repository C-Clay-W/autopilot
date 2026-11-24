// 浏览器原生能力的信任边界与单步参数测试，不连接 Desktop、Provider 或网页。
import { expect, it } from "vitest";
import type { Session } from "../../src/runtime/domain";
import type { BrowserCapability } from "../../src/runtime/protocol/browser-capability";
import { resolveRunConfig } from "../../src/runtime/protocol/run-config";
import { resolveTurnCapabilities } from "../../src/runtime/application/turn/turn-capability-ceiling";
import { browserOperationSchema, createBrowserTool } from "../../src/internal/tools/builtins/browser-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SessionImageStore } from "../../src/runtime/ports/session-image-store";

it("browser capability freezes only trusted host and cannot be injected into old turns or Chat", async function authority() {
  const capability: BrowserCapability = { async request() { return {}; }, async endTurn() {} };
  const work = { id: "s", productMode: "work", projectId: "p" } as Session;
  expect(resolveRunConfig({ runtimeDefault: {}, turnOverride: { browser: capability } }).browserEnabled).toBe(false);
  expect(resolveRunConfig({ runtimeDefault: { browser: capability } }).browserEnabled).toBe(true);
  const old = await resolveTurnCapabilities({ session: work, turnId: "t", runtimeDefault: { browser: capability }, override: { browser: capability }, frozen: {}, continuing: true, now: 1 });
  expect(old.capabilities.browser).toBeUndefined();
  const fresh = await resolveTurnCapabilities({ session: work, turnId: "t", runtimeDefault: { browser: capability }, override: { browser: { async request() { throw new Error("injected"); }, async endTurn() {} } }, frozen: { browserEnabled: true }, now: 1 });
  expect(fresh.capabilities.browser).toBe(capability);
  const chat = await resolveTurnCapabilities({ session: { id: "c", productMode: "chat", chatRetrievalMode: "none" } as Session, turnId: "t", runtimeDefault: { browser: capability }, frozen: { browserEnabled: true }, now: 1 });
  expect(chat.capabilities.browser).toBeUndefined(); expect(chat.frozen.browserEnabled).toBe(false);
});

it("browser screenshots use the existing image store and never retain raw base64 in output", async function screenshots() {
  const sessions: string[] = [];
  const capability: BrowserCapability = { async request() { return { content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }; }, async endTurn() {} };
  const store: SessionImageStore = { async put(input) { sessions.push(input.sessionId); return { id: "safe-image", name: "image", mimeType: "image/png", relativePath: "images/image.png", sha256: "hash", width: 1, height: 1, bytes: 5, gifFirstFrame: false }; }, async read() { throw new Error("unused"); } };
  for (const available of [true, false]) {
    const registry = new ToolRegistry({ productMode: "work" });
    registry.register(createBrowserTool(capability, { sessionId: "trusted", turnId: "turn" }, available ? store : undefined));
    const executor = new ToolExecutor(registry, { capabilityCeiling: { productMode: "work" }, permissionMode: "ask", workspaceTrusted: true });
    const result = await executor.execute({ callId: "screenshot", toolName: "browser", input: { type: "screenshot", pageId: "12345678-1234-4234-8234-123456789012", revision: 0 } });
    expect(result.status).toBe("success"); expect(JSON.stringify(result)).not.toContain("aW1hZ2U=");
    if (result.status === "success") expect(result.images?.length ?? 0).toBe(available ? 1 : 0);
  }
  expect(sessions).toEqual(["trusted"]);
});

it("browser tool passes actual call identity and rejects extra actions or caller identity", async function invocation() {
  const calls: unknown[] = [];
  const capability: BrowserCapability = { async request(binding, callId, operation) { calls.push({ binding, callId, operation }); return { pageId: "p" }; }, async endTurn() {} };
  const registry = new ToolRegistry({ productMode: "work" });
  registry.register(createBrowserTool(capability, { sessionId: "trusted", turnId: "turn1" }));
  const executor = new ToolExecutor(registry, { capabilityCeiling: { productMode: "work" }, permissionMode: "ask", workspaceTrusted: true });
  const result = await executor.execute({ callId: "actual-call", toolName: "browser", input: { type: "open", url: "https://example.test/?q=kept" } });
  expect(result.status).toBe("success");
  expect(calls).toEqual([{ binding: { sessionId: "trusted", turnId: "turn1" }, callId: "actual-call", operation: { type: "open", url: "https://example.test/?q=kept" } }]);
  for (const input of [{ type: "list", turnId: "fake" }, { type: "open", url: "file:///private" }, { type: "open", url: "https://example.test", actions: [] }, { type: "eval", script: "1" }]) expect(browserOperationSchema.safeParse(input).success).toBe(false);
});

// 新增固定动作沿真实工具验证调用身份，拒绝超界等待及自由参数。
it("browser bounded wait and downloads use the native tool contract", async function bounded() {
  const calls: unknown[] = [];
  const capability: BrowserCapability = { async request(binding, callId, operation) { calls.push({ binding, callId, operation }); return {}; }, async endTurn() {} };
  const registry = new ToolRegistry({ productMode: "work" });
  registry.register(createBrowserTool(capability, { sessionId: "trusted", turnId: "turn" }));
  const executor = new ToolExecutor(registry, { capabilityCeiling: { productMode: "work" }, permissionMode: "ask", workspaceTrusted: true });
  const page = { pageId: "12345678-1234-4234-8234-123456789012", revision: 0 };
  for (const operation of [{ type: "wait", ...page, condition: "load", timeout: 30000 }, { type: "downloads", ...page }, { type: "cancel-download", ...page, id: page.pageId }]) {
    expect((await executor.execute({ callId: operation.type, toolName: "browser", input: operation })).status).toBe("success");
    expect(calls.at(-1)).toEqual({ binding: { sessionId: "trusted", turnId: "turn" }, callId: operation.type, operation });
  }
  for (const operation of [{ type: "wait", ...page, condition: "load", timeout: 0 }, { type: "wait", ...page, condition: "load", timeout: 30001 }, { type: "wait", ...page, condition: "selector", timeout: 10 }, { type: "downloads", ...page, path: "private" }]) expect(browserOperationSchema.safeParse(operation).success).toBe(false);
});
