/**
 * Web Search Stage 1 契约测试：验证 Core capability、工具可见性、审批、取消、超时、裁剪与非持久化。
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentOptions } from "../../internal/agent-runtime";
import { createWebFetchTool } from "../../internal/tools/builtins/web-fetch-tool";
import { createWebSearchTool } from "../../internal/tools/builtins/web-search-tool";
import { createBrowserTool } from "../../internal/tools/builtins/browser-tool";
import { applyWebFetchRedirect } from "../../internal/tools/web-fetch-redirect";
import { ToolExecutor } from "../../internal/tools/tool-executor";
import { ToolRegistry } from "../../internal/tools/tool-registry";
import type { AgentToolDefinition, ToolPermissionMode } from "../../internal/tools/types";
import { getAgentMessageText, type AgentMessage } from "../../internal/types/agent-message";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { WebFetchCapabilityError, resolveRunConfig, type WebCapability, type WebFetchCapability, type WebFetchCapabilityErrorCode, type WebSearchCapability } from "../protocol";
import { sanitizeEventForExternal } from "../protocol/sanitize-checkpoint";
import type { BrowserOperation } from "../protocol/browser-capability";

/** 为单个 Web 工具创建不依赖文件系统或 Provider 的执行器。 */
function createWebExecutor<TInput, TOutput>(definition: AgentToolDefinition<TInput, TOutput>, permissionMode: ToolPermissionMode = "ask", extraContext: Record<string, unknown> = {}): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(definition);
  return new ToolExecutor(registry, {
    permissionMode,
    workspaceTrusted: true,
    agentFlow: { async search() { return []; } },
    ...extraContext,
  });
}

/** 创建返回固定脱敏来源的搜索能力。 */
function createSearchCapability(): WebSearchCapability {
  return {
    async search() {
      return { answer: "fixture answer", sources: [{ title: "Example", url: "https://example.com/source", snippet: "fixture snippet" }], truncated: false };
    },
  };
}

/** 创建返回固定脱敏正文的网页读取能力。 */
function createFetchCapability(): WebFetchCapability {
  return {
    async fetch(input) {
      return { url: input.url, finalUrl: input.url, title: "Fixture", content: "fixture content", contentType: "text/html", truncated: false };
    },
  };
}

/** 消费一次 Agent 事件流，使系统提示进入 mock sampler。 */
async function consumeRuntime(runtime: ReturnType<typeof createAgentRuntime>): Promise<void> {
  for await (const _event of runtime.run({ turnId: "web-stage1", messages: [{ role: "user", content: [{ type: "text", text: "查询最新公开信息" }] }] })) {
    // 只需消费事件流以触发首轮采样。
  }
}

describe("Web Search Stage 1 contract", function webStage1ContractSuite() {
  it("Search 与 Fetch 子能力按四种组合精确控制工具可见性", function registersToolsByCapability() {
    const search = createSearchCapability();
    const fetch = createFetchCapability();
    const webToolNames = function readWebToolNames(web?: WebCapability) {
      return createAgentRuntime({ web }).getToolDefinitions().map(function readName(definition) { return definition.name; }).filter(function isWebTool(name) { return name === "web_search" || name === "web_fetch"; });
    };

    expect(webToolNames()).toEqual([]);
    expect(webToolNames({ search })).toEqual(["web_search"]);
    expect(webToolNames({ fetch })).toEqual(["web_fetch"]);
    expect(webToolNames({ search, fetch })).toEqual(["web_search", "web_fetch"]);
  });

  it("工具 Schema 只接受有界 query 与无 userinfo 的 HTTP(S) URL", function validatesSchemas() {
    const searchTool = createWebSearchTool(createSearchCapability());
    const fetchTool = createWebFetchTool(createFetchCapability());

    expect(searchTool.inputSchema.safeParse({ query: " current news " }).success).toBe(true);
    expect(searchTool.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchTool.inputSchema.safeParse({ query: "x".repeat(4_001) }).success).toBe(false);
    expect(searchTool.inputSchema.safeParse({ query: "ok", extra: true }).success).toBe(false);
    expect(fetchTool.inputSchema.safeParse({ url: "https://example.com/page" }).success).toBe(true);
    expect(fetchTool.inputSchema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(fetchTool.inputSchema.safeParse({ url: "https://user:secret@example.com/" }).success).toBe(false);
    expect(fetchTool.inputSchema.safeParse({ url: "https://example.com/" + "x".repeat(1_980) }).success).toBe(true);
    expect(fetchTool.inputSchema.safeParse({ url: "https://example.com/" + "x".repeat(1_981) }).success).toBe(false);
  });

  it("启用 Search 即授权最小 query 外发，输出与展示均保持有界", async function executesBoundedSearch() {
    const search = vi.fn(async function fakeSearch(input: { query: string; signal?: AbortSignal }) {
      return {
        answer: "答".repeat(40_000),
        sources: Array.from({ length: 12 }, function createSource(_value, index) {
          return { title: `Source ${index}`, url: `https://example.com/${index}`, snippet: "摘".repeat(4_000) };
        }),
        truncated: false,
      };
    });
    const controller = new AbortController();
    const result = await createWebExecutor(createWebSearchTool({ search })).execute({ callId: "search-bounded", toolName: "web_search", input: { query: "  fixture query  " } }, { signal: controller.signal });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(search).toHaveBeenCalledWith({ query: "fixture query", signal: expect.any(AbortSignal) });
    expect((result.output as { sources: unknown[] }).sources).toHaveLength(10);
    expect(result.meta.outputBytes).toBeLessThanOrEqual(64 * 1024);
    expect(result.meta.truncated).toBe(true);
    expect(result.display?.titleKey).toBe("tool.web_search.completed");
    expect(result.display?.detail).toEqual({ kind: "web_search", sourceCount: 10, truncated: true });
    expect(JSON.stringify(result.display)).not.toContain("fixture query");
    expect(JSON.stringify(result.display)).not.toContain("example.com/0");
  });

  it("Fetch 在 ask 模式按域名审批，审批事实不泄露路径、query 或 userinfo", async function requiresDomainApproval() {
    const fetch = vi.fn(createFetchCapability().fetch);
    const url = "https://example.com/private/path?token=must-not-display#fragment";
    const result = await createWebExecutor(createWebFetchTool({ fetch })).execute({ callId: "fetch-approval", toolName: "web_fetch", input: { url } });

    expect(result.status).toBe("approval_required");
    if (result.status !== "approval_required") return;
    expect(fetch).not.toHaveBeenCalled();
    expect(result.approval.constraint).toBe("web-fetch-host:example.com");
    expect(result.approval.preview).toEqual({ host: "example.com" });
    expect(result.approval.display?.resource).toBe("example.com");
    expect(JSON.stringify(result.approval)).not.toContain("private/path");
    expect(JSON.stringify(result.approval)).not.toContain("must-not-display");
  });

  it("公开 Fetch 和已启用 Search 在自动批准与完全访问直行，Skill 禁止仍优先", async function admitsPublicWebForWorkModes() {
    const fetch = vi.fn(createFetchCapability().fetch);
    const search = vi.fn(createSearchCapability().search);
    const fetchTool = createWebFetchTool({ fetch });
    const searchTool = createWebSearchTool({ search });
    const fetchRequest = { callId: "public-fetch", toolName: "web_fetch", input: { url: "https://example.com/page" } };
    const searchRequest = { callId: "public-search", toolName: "web_search", input: { query: "public fixture" } };
    expect(await createWebExecutor(fetchTool, "ask").execute(fetchRequest)).toMatchObject({ status: "approval_required" });
    expect(await createWebExecutor(searchTool, "ask").execute(searchRequest)).toMatchObject({ status: "approval_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    for (const mode of ["auto_approve", "full_access"] as const) {
      expect(await createWebExecutor(fetchTool, mode).execute(fetchRequest)).toMatchObject({ status: "success" });
      expect(await createWebExecutor(searchTool, mode).execute(searchRequest)).toMatchObject({ status: "success" });
      expect(await createWebExecutor(fetchTool, mode, { allowedTools: [] }).execute(fetchRequest)).toMatchObject({ status: "denied" });
      expect(await createWebExecutor(searchTool, mode, { allowedTools: [] }).execute(searchRequest)).toMatchObject({ status: "denied" });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("浏览器在自动批准与完全访问只免公开导航和观察的 Core 卡，宿主仍接收精确动作", async function preservesBrowserHostAuthority() {
    const request = vi.fn(async function acceptBrowserOperation() { return { ok: true }; });
    const binding = { sessionId: "fixture-session", turnId: "fixture-turn" };
    const tool = createBrowserTool({ request, async endTurn() {} }, binding);
    const page = { pageId: "11223344-1122-4122-8122-112233445566", revision: 3 };
    const reads: BrowserOperation[] = [
      { type: "open", url: "https://example.com/read" }, { type: "navigate", ...page, url: "https://example.com/next" },
      { type: "list" }, { type: "snapshot", ...page }, { type: "screenshot", ...page }, { type: "wait", ...page, condition: "load", timeout: 1000 },
    ];
    const approvalOperations: BrowserOperation[] = [
      { type: "open", url: "http://localhost:8080/" }, { type: "navigate", ...page, url: "http://127.0.0.1/" },
      { type: "document", path: "README.md" }, { type: "click", ...page, ref: "@e1" }, { type: "fill", ...page, ref: "@e1", value: "fixture" },
      { type: "press", ...page, key: "Enter" }, { type: "downloads", ...page },
    ];
    for (const mode of ["auto_approve", "full_access"] as const) {
      const execution = createWebExecutor(tool, mode);
      for (const [index, operation] of reads.entries()) {
        const callId = `browser-${index}-${mode}`;
        expect(await execution.execute({ callId, toolName: "browser", input: operation })).toMatchObject({ status: "success" });
        const authorization = mode === "full_access" ? [{ mode }] : [];
        expect(request).toHaveBeenLastCalledWith(binding, callId, operation, expect.any(AbortSignal), ...authorization);
      }
      for (const [index, operation] of approvalOperations.entries()) {
        expect(await execution.execute({ callId: `browser-guard-${index}`, toolName: "browser", input: operation })).toMatchObject({ status: "approval_required" });
      }
      expect(await createWebExecutor(tool, mode, { allowedTools: [] }).execute({ callId: "browser-skill-deny", toolName: "browser", input: reads[0] })).toMatchObject({ status: "denied" });
    }
    expect(await createWebExecutor(tool).execute({ callId: "browser-ask", toolName: "browser", input: reads[0] })).toMatchObject({ status: "approval_required" });
    expect(request).toHaveBeenCalledTimes(reads.length * 2);
  });

  it("浏览器只传递本次动作已消费的批准，精确文件可由可信宿主确认", async function passesConsumedBrowserApproval() {
    const request = vi.fn(async function acceptBrowserOperation() { return { ok: true }; });
    const binding = { sessionId: "fixture-session", turnId: "fixture-turn" };
    const tool = createBrowserTool({ confirmsDocument: true, request, async endTurn() {} }, binding);
    const execution = createWebExecutor(tool, "full_access");
    const input = { type: "click", pageId: "11223344-1122-4122-8122-112233445566", revision: 3, ref: "@e1" };
    const click = { callId: "browser-click", toolName: "browser", input };
    const pending = await execution.execute(click);
    expect(pending).toMatchObject({ status: "approval_required", approval: { display: { operation: "click", resource: `网页地址待确认（标签 ${input.pageId}） · @e1` } } });
    if (pending.status !== "approval_required") throw new Error("missing click approval");
    const approval = { approvalId: pending.approval.approvalId, decision: "allow_once" as const };
    expect(await execution.execute({ ...click, callId: "wrong-call", approval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    expect(request).not.toHaveBeenCalled();
    expect(await execution.execute({ ...click, approval })).toMatchObject({ status: "success" });
    expect(request).toHaveBeenLastCalledWith(binding, click.callId, input, expect.any(AbortSignal), { mode: "full_access", approvedOnce: true });
    expect(await execution.execute({ ...click, approval })).toMatchObject({ status: "error", error: { code: "APPROVAL_MISMATCH" } });
    expect(request).toHaveBeenCalledTimes(1);
    const document = { type: "document", path: "README.md" };
    expect(await execution.execute({ callId: "browser-document", toolName: "browser", input: document })).toMatchObject({ status: "success" });
    expect(request).toHaveBeenLastCalledWith(binding, "browser-document", document, expect.any(AbortSignal), { mode: "full_access" });
    expect(await createWebExecutor(tool, "auto_approve").execute({ callId: "auto-document", toolName: "browser", input: document })).toMatchObject({ status: "approval_required" });
  });

  it("可信浏览器宿主收到真实 AP 档位，普通点击与文件动作不重复创建 Core 审批", async function delegatesNativeBrowserApproval() {
    const request = vi.fn(async function acceptBrowserOperation() { return { ok: true }; });
    const binding = { sessionId: "fixture-session", turnId: "fixture-turn" };
    const tool = createBrowserTool({ confirmsDocument: true, managesApprovals: true, request, async endTurn() {} }, binding);
    const click = { type: "click", pageId: "11223344-1122-4122-8122-112233445566", revision: 3, ref: "@e1" };
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      for (const input of [click, { type: "document", path: "README.md" }]) {
        const callId = `${mode}-${input.type}`;
        expect(await createWebExecutor(tool, mode).execute({ callId, toolName: "browser", input })).toMatchObject({ status: "success" });
        expect(request).toHaveBeenLastCalledWith(binding, callId, input, expect.any(AbortSignal), { mode });
      }
    }
  });

  it("浏览器单次审批显示已观察的同代站点和元素并隐藏敏感地址字段", async function describesBrowserApprovalTarget() {
    const pageId = "11223344-1122-4122-8122-112233445566";
    let revision = 3;
    const tool = createBrowserTool({
      async request(_binding, _callId, operation) {
        if (operation.type === "snapshot") return { origin: "https://example.org/next?token=secret", snapshot: "private page title" };
        return [{ id: pageId, revision, title: "private page title", url: "https://user:secret@example.com/private-path?q=token#fragment" }];
      },
      async endTurn() {},
    }, { sessionId: "fixture-session", turnId: "fixture-turn" });
    const execution = createWebExecutor(tool, "full_access");
    expect(await execution.execute({ callId: "browser-list", toolName: "browser", input: { type: "list" } })).toMatchObject({ status: "success" });
    const click = { callId: "browser-click", toolName: "browser", input: { type: "click", pageId, revision, ref: "@e2" } };
    const displayed = await execution.execute(click);
    expect(displayed).toMatchObject({ status: "approval_required", approval: { display: { operation: "click", resource: "https://example.com · @e2" } } });
    expect(JSON.stringify(displayed)).not.toMatch(/user:|secret|private-path|q=token|fragment|private page title/);
    expect(await execution.execute({ ...click, callId: "close", input: { type: "close", pageId, revision } })).toMatchObject({ status: "approval_required", approval: { display: { operation: "close", resource: "https://example.com" } } });

    revision = 4;
    expect(await execution.execute({ callId: "browser-new-list", toolName: "browser", input: { type: "list" } })).toMatchObject({ status: "success" });
    expect(await execution.execute({ ...click, callId: "stale-click" })).toMatchObject({ status: "approval_required", approval: { display: { resource: `网页地址待确认（标签 ${pageId}） · @e2` } } });
    expect(await execution.execute({ callId: "browser-snapshot", toolName: "browser", input: { type: "snapshot", pageId, revision } })).toMatchObject({ status: "success" });
    expect(await execution.execute({ ...click, callId: "click-after-snapshot", input: { ...click.input, revision } })).toMatchObject({ status: "approval_required", approval: { display: { resource: "https://example.org · @e2" } } });
  });

  it("Fetch 成功展示只含域名、类型和裁剪状态，不含网页正文", async function projectsSafeFetchDisplay() {
    const content = "PAGE_BODY_MUST_NOT_ENTER_DISPLAY".repeat(4_000);
    const fetch: WebFetchCapability = {
      async fetch(input) {
        return { url: input.url, finalUrl: "https://docs.example.com/final?secret=hidden", title: "T".repeat(600), content, contentType: "text/html", truncated: false };
      },
    };
    const result = await createWebExecutor(createWebFetchTool(fetch), "full_access").execute({ callId: "fetch-success", toolName: "web_fetch", input: { url: "https://example.com/start" } });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect((result.output as { content: string }).content).toHaveLength(100_000);
    expect(result.meta.truncated).toBe(true);
    expect(result.display?.titleKey).toBe("tool.web_fetch.completed");
    expect(result.display?.detail).toEqual({ kind: "web_fetch", host: "docs.example.com", contentType: "text/html", truncated: true });
    expect(JSON.stringify(result.display)).not.toContain("PAGE_BODY_MUST_NOT_ENTER_DISPLAY");
    expect(JSON.stringify(result.display)).not.toContain("secret=hidden");
  });

  /** Adapter 在第一跳交回剩余九跳时，Core 必须接受新预算并保持目标重新校验。 */
  it.each(["auto_approve", "full_access"] as const)("Core 接受十跳预算中的跨域续接（%s）", async function resumesExpandedRedirectBudget(mode) {
    const seen: Array<{ url: string; redirectsRemaining?: number }> = [];
    const capability: WebFetchCapability = {
      async fetch(input) {
        seen.push(input);
        if (seen.length === 1) throw new WebFetchCapabilityError("WEB_REDIRECT_REQUIRES_APPROVAL", "redirect", { url: "https://other.example.com/final", remainingRedirects: 9 });
        return { url: input.url, finalUrl: input.url, content: "ok", contentType: "text/plain", truncated: false };
      },
    };
    const executor = createWebExecutor(createWebFetchTool(capability), mode);
    const call = { id: "redirect-expanded", name: "web_fetch", input: { url: "https://example.com/start" } };
    const initial = await executor.execute({ callId: call.id, toolName: call.name, input: call.input });
    expect(initial).toMatchObject({ status: "approval_required", approval: { preview: { host: "other.example.com" } } });
    if (initial.status !== "approval_required") throw new Error("missing redirect approval");
    expect(seen).toHaveLength(1);
    applyWebFetchRedirect(call, initial, []);
    const result = await executor.execute({ callId: call.id, toolName: call.name, input: call.input, approval: { approvalId: initial.approval.approvalId, decision: "allow_once" } });
    expect(result.status).toBe("success");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ url: "https://other.example.com/final", redirectsRemaining: 9 });
  });

  it("Fetch 不会把畸形 Content-Type 响应头投影到安全展示", async function sanitizesFetchContentType() {
    const fetch: WebFetchCapability = {
      async fetch(input) {
        return { url: input.url, finalUrl: input.url, content: "fixture", contentType: "text/html\nAuthorization: Bearer RAW_SECRET", truncated: false };
      },
    };
    const result = await createWebExecutor(createWebFetchTool(fetch), "full_access").execute({ callId: "fetch-content-type", toolName: "web_fetch", input: { url: "https://example.com/start" } });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect((result.output as { contentType: string }).contentType).toBe("application/octet-stream");
    expect(result.display?.detail).toEqual({ kind: "web_fetch", host: "example.com", contentType: "application/octet-stream", truncated: true });
    expect(JSON.stringify(result)).not.toContain("RAW_SECRET");
  });

  it("AbortSignal 与 ToolExecutor 超时贯穿 capability 且产生稳定终态", async function handlesCancellationAndTimeout() {
    const pendingSearch: WebSearchCapability = {
      search(input) {
        return new Promise(function waitForAbort(_resolve, reject) {
          if (input.signal?.aborted) {
            reject(new Error("RAW_ABORT_REASON"));
            return;
          }
          input.signal?.addEventListener("abort", function rejectOnAbort() { reject(new Error("RAW_ABORT_REASON")); }, { once: true });
        });
      },
    };
    const cancelledController = new AbortController();
    const cancelledPromise = createWebExecutor(createWebSearchTool(pendingSearch)).execute({ callId: "search-cancel", toolName: "web_search", input: { query: "cancel" } }, { signal: cancelledController.signal });
    cancelledController.abort();
    const cancelled = await cancelledPromise;
    const timedOut = await createWebExecutor(createWebSearchTool(pendingSearch)).execute({ callId: "search-timeout", toolName: "web_search", input: { query: "timeout" } }, { timeoutMs: 5 });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.status === "cancelled" && cancelled.error.code).toBe("EXECUTION_CANCELLED");
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.status === "timeout" && timedOut.error.code).toBe("EXECUTION_TIMEOUT");
    expect(JSON.stringify([cancelled, timedOut])).not.toContain("RAW_ABORT_REASON");
  });

  /** 重现真实 Search 超过旧 15 秒期限的场景，同时验证新预算到期仍会真正取消能力。 */
  it("Search 等待超过旧期限并在 300 秒结束", async function usesLongerSearchDeadline() {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      const executor = createWebExecutor(createWebSearchTool({
        /** 模拟已返回响应头、正文一直未结束的 Provider。 */
        search(input) {
          signal = input.signal;
          return new Promise(function waitForDeadline(_resolve, reject) {
            signal?.addEventListener("abort", function rejectOnDeadline() { reject(new Error("aborted")); }, { once: true });
          });
        },
      }));
      const result = executor.execute({ callId: "long-search", toolName: "web_search", input: { query: "public" } });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(280_000);
      expect(await result).toMatchObject({ status: "timeout", error: { code: "EXECUTION_TIMEOUT" } });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未知 capability 异常被脱敏且 Web capability 不进入 FrozenRunConfig", async function sanitizesFailureAndAvoidsPersistence() {
    const web: WebCapability = {
      search: { async search() { throw new Error("RAW_PROVIDER_SECRET_BODY"); } },
    };
    const result = await createWebExecutor(createWebSearchTool(web.search!)).execute({ callId: "search-error", toolName: "web_search", input: { query: "fixture" } });
    const frozen = resolveRunConfig({ runtimeDefault: { web } });

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "网络搜索失败" });
    expect(JSON.stringify(result)).not.toContain("RAW_PROVIDER_SECRET_BODY");
    expect(frozen).not.toHaveProperty("web");
    expect(JSON.stringify(frozen)).not.toContain("search");
  });

  /** Fetch Adapter 的稳定安全码必须保留，但私有 URL、响应正文与底层错误消息不得穿透。 */
  it("保留 Fetch 稳定错误码并使用 Core 固定文案", async function preservesSafeFetchErrors() {
    const cases: Array<[WebFetchCapabilityErrorCode, string, string?]> = [
      ["WEB_URL_BLOCKED", "网页地址被安全策略阻止"],
      ["WEB_URL_BLOCKED", "网页地址被安全策略阻止", "__proto__"],
      ["WEB_URL_BLOCKED", "网页地址或协议不允许访问", "url_not_allowed"],
      ["WEB_URL_BLOCKED", "网页域名解析失败，请检查 DNS 或网络设置", "dns_failed"],
      ["WEB_URL_BLOCKED", "网页目标地址位于非公网网段，请检查 DNS 或代理设置", "non_public_address"],
      ["WEB_URL_BLOCKED", "网页重定向无效或超过安全上限", "redirect_rejected"],
      ["WEB_REDIRECT_REQUIRES_APPROVAL", "网页重定向到其他域名，需要重新审批"],
      ["WEB_RESPONSE_TOO_LARGE", "网页响应超过安全读取上限"],
      ["WEB_CONTENT_TYPE_UNSUPPORTED", "网页内容类型不受支持"],
    ];
    for (const [code, message, blockReason] of cases) {
      const capability: WebFetchCapability = {
        /** 模拟 Adapter 携带稳定错误码但附带不可公开的内部消息。 */
        async fetch() { throw Object.assign(new WebFetchCapabilityError(code, "PRIVATE_FETCH_ERROR_BODY"), { blockReason }); },
      };
      const executor = createWebExecutor(createWebFetchTool(capability));
      const request = { callId: `fetch-${code}`, toolName: "web_fetch", input: { url: "https://example.com/hidden?token=private" } };
      const approval = await executor.execute(request);
      if (approval.status !== "approval_required") throw new Error("missing fixture approval");
      const result = await executor.execute({ ...request, approval: { approvalId: approval.approval.approvalId, decision: "allow_once" } });
      expect(result.status).toBe("error");
      expect(result.status === "error" && result.error).toEqual({ code, message });
      if (code === "WEB_URL_BLOCKED") {
        const event = sanitizeEventForExternal({ type: "tool_result", turnId: "test", stepId: "test-step", callId: result.callId, toolName: "web_fetch", result, retryCount: 0, summary: code });
        expect(event).toMatchObject({ result: { error: { code, message }, display: { summary: message } } });
        expect(JSON.stringify(event)).not.toContain("blockReason");
      }
      expect(JSON.stringify(result)).not.toContain("PRIVATE_FETCH_ERROR_BODY");
      expect(JSON.stringify(result)).not.toContain("token=private");
    }
  });

  /** Adapter 的错误可以来自另一份 Core 产物，但跨域输入仍必须重新经过 Schema/Policy。 */
  it("识别跨模块异常并重新审批目标，拒绝畸形错误载荷", async function recognizesCrossModuleRedirect() {
    const fetch = vi.fn(async function redirectFromOtherModule() {
      throw Object.assign(new Error("PRIVATE_ERROR"), { name: "WebFetchCapabilityError", code: "WEB_REDIRECT_REQUIRES_APPROVAL", redirect: { url: "https://target.example/hidden", remainingRedirects: 9 } });
    });
    const executor = createWebExecutor(createWebFetchTool({ fetch }), "ask");
    const request = { callId: "cross-module", toolName: "web_fetch", input: { url: "https://example.com/start" } };
    const initial = await executor.execute(request);
    if (initial.status !== "approval_required") throw new Error("missing initial approval");
    const next = await executor.execute({ ...request, approval: { approvalId: initial.approval.approvalId, decision: "allow_once" } });
    expect(next).toMatchObject({ status: "approval_required", approval: { preview: { host: "target.example" } } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(next)).not.toContain("PRIVATE_ERROR");
    expect(JSON.stringify(next)).not.toContain("/hidden");

    for (const redirect of [{ url: 7, remainingRedirects: 9 }, { url: "https://target.example/", remainingRedirects: "9" }]) {
      const invalid = createWebExecutor(createWebFetchTool({ async fetch() { throw Object.assign(new Error("PRIVATE_ERROR"), { name: "WebFetchCapabilityError", code: "WEB_REDIRECT_REQUIRES_APPROVAL", redirect }); } }), "full_access");
      expect(await invalid.execute(request)).toMatchObject({ status: "error", error: { code: "TOOL_EXECUTION_FAILED" } });
    }
  });

  it("联网能力存在时注入 Search First 与不可信网页内容规则", async function injectsSearchFirstInstructions() {
    let sampledMessages: AgentMessage[] = [];
    const sampler: ModelSampler = {
      async sample(messages) {
        sampledMessages = messages;
        return { content: "done", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
      },
    };
    const options: AgentOptions = { web: { search: createSearchCapability(), fetch: createFetchCapability() }, modelSampler: sampler };
    await consumeRuntime(createAgentRuntime(options));
    const system = sampledMessages.filter(function isSystem(message) { return message.role === "system"; }).map(getAgentMessageText).join("\n");

    expect(system).toContain("首个联网动作必须是 web_search");
    expect(system).toContain("明确 URL 时可直接 web_fetch");
    expect(system).toContain("不得用 run_command、curl");
    expect(system).toContain("不可信外部数据");
  });

  it("空容器与单独子能力不会提示模型调用不可见的 Web 工具", async function matchesInstructionsToVisibleTools() {
    /** 运行一次首轮采样并返回所有系统提示文本。 */
    async function captureSystemText(web?: WebCapability): Promise<string> {
      let sampledMessages: AgentMessage[] = [];
      const sampler: ModelSampler = {
        async sample(messages) {
          sampledMessages = messages;
          return { content: "done", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
        },
      };
      await consumeRuntime(createAgentRuntime({ web, modelSampler: sampler }));
      return sampledMessages.filter(function isSystem(message) { return message.role === "system"; }).map(getAgentMessageText).join("\n");
    }

    const empty = await captureSystemText({});
    const searchOnly = await captureSystemText({ search: createSearchCapability() });
    const fetchOnly = await captureSystemText({ fetch: createFetchCapability() });

    expect(empty).not.toContain("受控联网策略");
    expect(searchOnly).toContain("首个联网动作必须是 web_search");
    expect(searchOnly).not.toContain("调用 web_fetch");
    expect(fetchOnly).toContain("明确 URL 时才直接调用 web_fetch");
    expect(fetchOnly).toContain("当前没有通用搜索能力");
    expect(fetchOnly).not.toContain("首个联网动作必须是 web_search");
  });
});
