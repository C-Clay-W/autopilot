/** Chat 联网集成：真实 Host/Core/Adapter 配合独占合成状态与 fake HTTP 验证跨域隔离、配置撤销和取消。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunConfig } from "@autopilot-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebChatHost, type WebChatHost } from "@/lib/runtime-host/web-chat-host";
import { runChatSessionRoute } from "@/lib/runtime-host/chat-session-route";

type Sample = NonNullable<RunConfig["modelSampler"]>["sample"];
const roots: string[] = [];
const hosts: WebChatHost[] = [];
const privateValues = ["KNOWLEDGE_CANARY_6", "RAG_HISTORY_CANARY_6", "WORK_CONTEXT_CANARY_6", "MEMORY_CANARY_6", "ATTACHMENT_CANARY_6"];

/** 返回有来源的合成搜索响应，仅通过正式 Adapter 解码。 */
function searchResponse(): Response {
  return Response.json({ object: "response", status: "completed", output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", content: [{ type: "output_text", text: "PUBLIC_SEARCH_BODY_6", annotations: [{ type: "url_citation", title: "Public source", url: "https://example.com/source" }] }] },
  ] });
}

/** 创建隔离 Home/状态；所有凭据与私有材料均为本测试生成的 canary。 */
async function fixture(sample: Sample, http: typeof fetch = vi.fn(async function response() { return searchResponse(); })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-web-stage6-"));
  roots.push(root);
  const homeDirectory = path.join(root, "home");
  const settings = path.join(homeDirectory, ".autopilot", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  /** 原位更新合成 User 配置，证明下一 Turn 重新装配而非复用旧能力缓存。 */
  function configure(enabled: boolean) {
    fs.writeFileSync(settings, JSON.stringify(enabled ? { webSearch: { credentialRef: { provider: "deepseek", key: "SEARCH" } } } : {}));
  }
  configure(true);
  const loadKnowledge = vi.fn(async function knowledge(binding) {
    return { knowledge: {
      knowledgeSpaceId: binding.knowledgeSpaceId,
      /** 合成私有证据与正文进入真实 RAG Turn，再测试新 web 会话。 */
      async prepareSearch() { return { ...binding, batchId: "fixture_batch_0001", evidence: [{ id: "fixture_evidence_0001", text: privateValues[0], sufficient: true }] }; },
      /** 本夹具证据在所属 Turn 内保持有效。 */
      async validateEvidence() { return true; },
    } };
  });
  let credentialReads = 0;
  const env = { NODE_ENV: "test" as const, get DEEPSEEK_SEARCH() { credentialReads++; return "fixture-search-key"; } };
  const host = await createWebChatHost({ globalStateRoot: root, homeDirectory, env, modelSampler: { sample }, webSearchFetch: http, capability: { loadKnowledge } });
  hosts.push(host);
  const workspace = vi.spyOn(host.storage.ports.workspaceAdapter, "resolveWorkspaceRoot");
  /** 调用正式 Route，只注入隔离宿主，不替代 Runtime 或身份验证。 */
  function route(method: string, segments: string[], body?: unknown) {
    return runChatSessionRoute(new Request("http://localhost/api/chat/sessions", { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }), segments, async function load() { return host; });
  }
  /** 创建持久会话，每次来源变化显式使用新 Session。 */
  async function session(mode: string) { const res = await route("POST", [], { chatRetrievalMode: mode }); expect(res.status).toBe(201); return (await res.json()).id as string; }
  /** 消费完整 SSE，保证当前 Turn 已完成后再检查历史或配置变化。 */
  async function send(id: string, content: string, message = "message_0001") { const res = await route("POST", [id, "messages"], { content, clientMessageId: message }); expect(res.status).toBe(200); return res.text(); }
  return { root, host, http, route, session, send, configure, loadKnowledge, workspace, reads: function reads() { return credentialReads; } };
}

/** 只清理经绝对路径和前缀校验的本测试独占目录；先释放宿主 watcher。 */
afterEach(function cleanup() {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("chat-web-stage6-")) throw new Error("Invalid fixture root");
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("Chat Web Stage6", function suite() {
  it("新 web sampler 与搜索 HTTP 不带旧 RAG、知识、Memory、工作区或附件；三态目录和配置撤销有效", async function isolatesDomains() {
    const catalogs: string[][] = [];
    const contexts: string[] = [];
    let calls = 0;
    const sample: Sample = async function sample(messages, tools) {
      catalogs.push(tools.map(function name(tool) { return tool.function.name; }).sort());
      contexts.push(JSON.stringify(messages));
      calls++;
      if (calls === 2) return { reasoningSummary: "fixture", content: "", toolCalls: [{ id: "rag_1", name: "rag_search", input: { query: "私有资料" } }] };
      if (calls === 4) return { reasoningSummary: "fixture", content: "", toolCalls: [{ id: "search_1", name: "web_search", input: { query: "public question" } }] };
      return { reasoningSummary: "fixture", content: calls === 5 ? "公开回答 [Public source](https://example.com/source)" : "讨论完成", toolCalls: [] };
    };
    const f = await fixture(sample);
    fs.mkdirSync(f.host.storage.paths.knowledgeRoot, { recursive: true });
    fs.writeFileSync(path.join(f.host.storage.paths.knowledgeRoot, "metadata.txt"), privateValues[0]);
    const legacy = path.join(f.root, "legacy-work", ".autopilot");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "settings.json"), JSON.stringify({ instructions: privateValues[2] }));
    fs.writeFileSync(path.join(f.host.storage.paths.stateRoot, "memory.json"), privateValues[3]);
    const none = await f.session("none");
    await f.host.storage.attachments.put({ sessionId: none, displayName: "old.txt", bytes: new TextEncoder().encode(privateValues[4]) });
    await f.send(none, "普通讨论");
    const rag = await f.session("rag");
    await f.send(rag, privateValues[1]);
    expect(f.reads()).toBe(0);
    expect(f.http).not.toHaveBeenCalled();
    expect(f.loadKnowledge).toHaveBeenCalledOnce();
    const web = await f.session("web");
    const sse = await f.send(web, "请搜索 public question");
    expect(sse).toContain("turn_completed");
    expect(sse).not.toContain("approval_required");
    expect(catalogs.slice(0, 5)).toEqual([["chat_attachment_read"], ["rag_search"], ["rag_search"], ["web_fetch", "web_search"], ["web_fetch", "web_search"]]);
    expect(f.http).toHaveBeenCalledOnce();
    expect(f.reads()).toBeGreaterThan(0);
    const outgoing = JSON.stringify(vi.mocked(f.http).mock.calls);
    for (const value of privateValues) { expect(contexts.slice(3).join()).not.toContain(value); expect(outgoing).not.toContain(value); }
    expect(contexts[1]).toContain(privateValues[1]);
    expect(contexts[2]).toContain(privateValues[0]);
    expect(contexts[4]).toContain("PUBLIC_SEARCH_BODY_6");
    const history = await (await f.route("GET", [web])).json();
    expect(history.meta.chatRetrievalMode).toBe("web");
    expect(history.attachments).toEqual([]);
    expect(JSON.stringify(history)).toContain("https://example.com/source");
    const turn = await f.host.runtime.turns.getState({ sessionId: web });
    for (const visible of [sse, JSON.stringify(history), JSON.stringify(turn)]) { expect(visible).not.toContain("PUBLIC_SEARCH_BODY_6"); expect(visible).not.toContain("fixture-search-key"); }
    f.configure(false);
    await f.send(web, "已知链接仍可用", "message_0002");
    expect(catalogs.at(-1)).toEqual(["web_fetch"]);
    expect(f.http).toHaveBeenCalledOnce();
    expect(f.loadKnowledge).toHaveBeenCalledOnce();
    expect(f.workspace).not.toHaveBeenCalled();
    expect((await f.route("POST", [], { chatRetrievalMode: "rag", web: true })).status).toBe(400);
    expect((await f.route("POST", [rag, "messages"], { content: "x", clientMessageId: "message_bad1", chatRetrievalMode: "web" })).status).toBe(400);
    expect((await f.route("PATCH", [rag], { chatRetrievalMode: "web" })).status).toBe(405);
  });

  it("搜索错误脱敏且私网 Fetch 在网络前拒绝，Chat 不产生审批或替代工具", async function rejectsFailures() {
    const observed: string[] = [];
    let count = 0;
    const sample: Sample = async function sample(messages) {
      observed.push(JSON.stringify(messages));
      count++;
      if (count === 1) return { reasoningSummary: "fixture", content: "", toolCalls: [{ id: "search_error", name: "web_search", input: { query: "public" } }] };
      if (count === 3) return { reasoningSummary: "fixture", content: "", toolCalls: [{ id: "private_fetch", name: "web_fetch", input: { url: "http://127.0.0.1/private" } }] };
      return { reasoningSummary: "fixture", content: "当前请求失败，无法提供网页事实。", toolCalls: [] };
    };
    const http = vi.fn(async function rejected() { return new Response("PRIVATE_PROVIDER_FAILURE_6", { status: 429 }); });
    const f = await fixture(sample, http);
    const web = await f.session("web");
    const search = await f.send(web, "搜索");
    const fetch = await f.send(web, "读取", "message_0002");
    expect(observed.join()).toContain("WEB_SEARCH_RATE_LIMITED");
    expect(observed.join()).toContain("WEB_URL_BLOCKED");
    expect(observed.join()).not.toContain("PRIVATE_PROVIDER_FAILURE_6");
    for (const sse of [search, fetch]) { expect(sse).toContain("turn_completed"); expect(sse).not.toContain("approval_required"); expect(sse).not.toContain("PRIVATE_PROVIDER_FAILURE_6"); }
    expect(http).toHaveBeenCalledOnce();
  });

  it("取消 Chat Turn 会中止正在等待的搜索 HTTP，历史进入取消终态", async function cancelsSearch() {
    let signal: AbortSignal | undefined;
    const http = vi.fn(async function pending(_input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
      signal = init?.signal ?? undefined;
      return new Promise(function wait(_resolve, reject) { signal!.addEventListener("abort", function abort() { reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
    });
    const sample: Sample = async function search() { return { reasoningSummary: "fixture", content: "", toolCalls: [{ id: "search_cancel", name: "web_search", input: { query: "public" } }] }; };
    const f = await fixture(sample, http);
    const web = await f.session("web");
    const pending = f.send(web, "等待搜索");
    await vi.waitFor(function requested() { expect(http).toHaveBeenCalledOnce(); });
    const turnId = (await f.host.runtime.turns.getState({ sessionId: web })).turn!.id;
    expect((await f.route("POST", [web, "cancel"], { turnId })).status).toBe(200);
    const sse = await pending;
    expect(signal?.aborted).toBe(true);
    expect(sse).toContain("turn_interrupted");
    expect((await f.host.runtime.turns.getState({ sessionId: web })).turn?.status).toBe("interrupted");
  });
});
