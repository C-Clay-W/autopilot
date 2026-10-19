/** Stage5 使用真实 Core CJS、Node 状态、LanceDB 与解析器；仅模型、Embedding/OCR HTTP 为受控夹具。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig, ChatCapabilityBinding } from "@autopilot-agent/core";
import { createWebChatHost, type WebChatHost } from "@/lib/runtime-host/web-chat-host";
import { runChatSessionRoute } from "@/lib/runtime-host/chat-session-route";
import { runChatKnowledgeRoute } from "@/lib/runtime-host/chat-knowledge-route";
import { validateKnowledgeUpload } from "@/lib/knowledge-service";
import { toSafeKnowledgeError } from "@/lib/knowledge-error";
import { createCredentialSettingsService } from "@/lib/settings/credential-settings";

const roots: string[] = [], hosts: WebChatHost[] = [];
const outbound: string[] = [];
const canary = "ORCHID_PRIVATE launch date is Friday.";
/** 所有网络均限定在合成供应商，意外请求立即失败；不读取真实配置。 */
beforeEach(function isolateProviders() {
  outbound.length = 0;
  for (const [key, value] of Object.entries({ TEXT_EMBEDDING_BASE_URL: "https://text.fixture", TEXT_EMBEDDING_MODEL: "fixture", TEXT_EMBEDDING_API_KEY: "fake", TONGYI_API_KEY: "fake", TONGYI_EMBEDDING_MODEL: "fixture-embedding", DASHSCOPE_EMBEDDING_URL: "https://vision.fixture", PYMUPDF_PYTHON: "/missing/fixture-python", TESSERACT_PATH: "/missing/fixture-tesseract", RAG_CLOUD_OCR_URL: "https://ocr.fixture", RAG_CLOUD_OCR_API_KEY: "fake" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async function provider(url: string | URL | Request, options?: RequestInit) {
    options?.signal?.throwIfAborted();
    const target = String(url); outbound.push(target);
    if (target === "https://vision.fixture/v1/chat/completions") { expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer fake-chat-vision"); return Response.json({ choices: [{ message: { content: canary } }] }); }
    if (target === "https://vision.fixture/anthropic/v1/messages") { expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer fake-chat-vision"); return Response.json({ content: [{ type: "text", text: canary }] }); }
    if (target === "https://text.fixture/embeddings") return Response.json({ data: [{ embedding: Array(1024).fill(0.01) }] });
    if (target === "https://vision.fixture") return Response.json({ output: { embeddings: [{ embedding: Array(1152).fill(0.01) }] } });
    if (target === "https://ocr.fixture") return Response.json({ text: canary });
    throw new Error("Unexpected outbound request");
  }));
});
/** 只清理独占夹具，停止 Host 句柄后恢复环境。 */
afterEach(function cleanup() { for (const host of hosts.splice(0)) host.stop(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** 创建不读取 Workspace 或真实用户目录的 Host。 */
async function fixture(modelSampler?: RunConfig["modelSampler"], env: NodeJS.ProcessEnv = { NODE_ENV: "test" }, configureVision = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-knowledge-stage5-")); roots.push(root);
  const homeDirectory = path.join(root, "home"); fs.mkdirSync(homeDirectory);
  if (configureVision) await createCredentialSettingsService({ homeDirectory, env }).save({ category: "main", main: { provider: "custom", model: "fixture-vision", baseUrl: "https://vision.fixture/anthropic", apiKey: "fake-chat-vision" }, search: { enabled: false, useMainKey: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" } });
  const options = { globalStateRoot: root, homeDirectory, env: { NODE_ENV: "test" as const, ...Object.fromEntries(["TEXT_EMBEDDING_BASE_URL", "TEXT_EMBEDDING_MODEL", "TEXT_EMBEDDING_API_KEY", "TONGYI_API_KEY", "TONGYI_EMBEDDING_MODEL", "DASHSCOPE_EMBEDDING_URL"].map(function entry(key) { return [key, process.env[key]]; })), ...env }, modelSampler: modelSampler ?? { sample: async function answer() { return { content: "unsupported fact", toolCalls: [], reasoningSummary: "", finishReason: "stop" as const }; } } };
  const host = await createWebChatHost(options); hosts.push(host);
  /** 使用 canonical 路由，不绕过身份及传输校验。 */
  async function sessionRoute(method: string, segments: string[], body?: unknown) { return runChatSessionRoute(new Request("http://localhost/api/chat/sessions", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }), segments, async function load() { return host; }); }
  /** 上传按 Session 或独立管理入口分流。 */
  async function upload(file: File, sessionId?: string, extra?: string, signal?: AbortSignal) {
    const form = new FormData(); form.set("file", file); if (extra) form.set(extra, "forged");
    const request = new Request("http://localhost/api/chat/knowledge", { method: "POST", body: form, signal });
    return sessionId ? runChatSessionRoute(request, [sessionId, "knowledge"], async function load() { return host; }) : runChatKnowledgeRoute(request, [], async function load() { return host; });
  }
  /** 创建持久化来源身份。 */
  async function session(mode = "rag") { return (await (await sessionRoute("POST", [], { chatRetrievalMode: mode })).json()).id as string; }
  return { root, host, options, upload, session, sessionRoute };
}

/** 将合成 JPEG 放入单页 PDF，模拟无文本层扫描件。 */
function scannedPdf(jpeg: Buffer): Buffer {
  const content = "q 100 0 0 100 0 0 cm /Im0 Do Q";
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"), Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"), Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]), Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)];
  const parts = [Buffer.from("%PDF-1.4\n")], offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.concat(parts).length); parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")); }
  const xref = Buffer.concat(parts).length;
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(function offset(value) { return `${String(value).padStart(10, "0")} 00000 n \n`; }).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe("Chat knowledge Stage5", function suite() {
  /** 实际 Host 视觉调用消费所声明的端点与凭据，不额外寻找不存在的 ALI_ 前缀。 */
  it.each([false, true])("Chat 视觉使用受信配置，页面配置优先于 env：%s", async function configuredVision(configureVision) {
    let evidenceId = "";
    const sample: NonNullable<RunConfig["modelSampler"]>["sample"] = async function sample(messages) {
      const result = messages.flatMap(function blocks(message) { return message.content; }).filter(function tool(block) { return block.type === "tool-result"; }).at(-1);
      const value = result?.type === "tool-result" ? JSON.parse(result.content[0].text) : undefined;
      if (!value) return { content: "", toolCalls: [{ id: "search", name: "rag_search", input: { query: "ORCHID_PRIVATE" } }], reasoningSummary: "", finishReason: "tool_calls" };
      if (value.output?.evidence) {
        const evidence = value.output.evidence[0]; evidenceId = evidence.id;
        return { content: "", toolCalls: [{ id: "vision", name: "chat_vision_analyze", input: { visualEvidenceRef: evidence.visualEvidenceRef, prompt: "只读图中文字" } }], reasoningSummary: "", finishReason: "tool_calls" };
      }
      // 现行答案协议：只经 chat_submit_answer 提交；视觉观察用 visualAnswers 直接呈现，不抄写图注。
      return { content: "", toolCalls: [{ id: "submit-answer", name: "chat_submit_answer", input: { visualAnswers: [{ evidenceId }] } }], reasoningSummary: "", finishReason: "tool_calls" };
    };
    const f = await fixture({ sample }, { NODE_ENV: "test", LLM_MODEL: "fixture-vision", LLM_BASE_URL: configureVision ? "https://unused.fixture/v1" : "https://vision.fixture/v1", TONGYI_API_KEY: configureVision ? "wrong-key" : "fake-chat-vision" }, configureVision);
    const id = await f.session();
    await (await f.upload(new File([new Uint8Array(createCanvas(20, 20).toBuffer("image/png"))], "orchid.png", { type: "image/png" }), id)).text();
    const response = await f.sessionRoute("POST", [id, "messages"], { content: "ORCHID_PRIVATE", clientMessageId: "vision_stage8" });
    expect(await response.text()).toContain("turn_completed");
    expect(outbound).toContain(configureVision ? "https://vision.fixture/anthropic/v1/messages" : "https://vision.fixture/v1/chat/completions");
    const history = await (await f.sessionRoute("GET", [id])).json();
    expect(history.messages.at(-1).content).toContain("![orchid.png](/api/chat/knowledge/");
  });

  it("无工作区文本、Excel、扫描 PDF、图片入库检索预览；重启与删除来源会话后资源仍保留", async function realPipeline() {
    const f = await fixture(); const id = await f.session();
    const workspace = vi.spyOn(f.host.storage.ports.workspaceAdapter, "resolveWorkspaceRoot");
    const canvas = createCanvas(100, 100); canvas.getContext("2d").fillText("ORCHID", 10, 40);
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["fixture heading"], ["title"], [canary]]), "Sheet1");
    const files = [new File([canary], "orchid.txt"), new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "orchid.xlsx"), new File([new Uint8Array(scannedPdf(canvas.toBuffer("image/jpeg")))], "orchid.pdf", { type: "application/pdf" }), new File([new Uint8Array(canvas.toBuffer("image/png"))], "orchid.png", { type: "image/png" })];
    for (const file of files) {
      const response = await f.upload(file, id); expect(response.status).toBe(200);
      const stream = await response.text(); expect(stream).toContain("event: completed"); expect(stream).not.toContain('"tableName"'); expect(stream).not.toContain(canary);
    }
    const resources = await f.host.knowledge.list(); expect(resources.map(function type(item) { return item.type; }).sort()).toEqual(["excel", "image", "pdf", "text"]);
    const pdf = resources.find(function pdf(item) { return item.type === "pdf"; })!;
    const page = await runChatKnowledgeRoute(new Request("http://localhost/api/chat/knowledge"), [pdf.resourceId, "preview", "pages", "1"], async function load() { return f.host; });
    expect(page.status).toBe(200); expect(page.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await page.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]));
    for (const invalid of ["0", "-1", "../1", "1000000"]) expect((await runChatKnowledgeRoute(new Request("http://localhost/api/chat/knowledge"), [pdf.resourceId, "preview", "pages", invalid], async function load() { return f.host; })).status).toBe(404);
    expect((await runChatKnowledgeRoute(new Request("http://localhost/api/chat/knowledge"), [pdf.resourceId, "preview", "pages", "2"], async function load() { return f.host; })).status).toBe(404);
    for (const resource of resources) expect((await f.host.knowledge.preview(resource.resourceId, new AbortController().signal)).buffer.length).toBeGreaterThan(0);
    const binding: ChatCapabilityBinding = { sessionId: id, turnId: "test_turn", retrievalMode: "rag" };
    const capability = await f.host.knowledge.loadKnowledge(binding);
    const batch = await capability.knowledge!.prepareSearch({ ...binding, query: "ORCHID_PRIVATE", topK: 8 });
    expect(batch.evidence.length).toBeGreaterThanOrEqual(3); expect(batch.evidence.some(function text(item) { return item.text.includes(canary); })).toBe(true);
    expect(await capability.knowledge!.validateEvidence({ ...binding, batch })).toBe(true);
    expect(batch.evidence.filter(function media(item) { return item.sourceImageUrl; }).length).toBeGreaterThanOrEqual(2);
    expect(batch.evidence.some(function pdfPage(item) { return item.sourceImageUrl === `/api/chat/knowledge/${pdf.resourceId}/preview/pages/1`; })).toBe(true);
    expect((await f.sessionRoute("DELETE", [id])).status).toBe(200);
    expect(await capability.knowledge!.validateEvidence({ ...binding, batch })).toBe(false);
    expect(await f.host.knowledge.list()).toHaveLength(4);
    f.host.stop(); const resumed = await createWebChatHost(f.options); hosts.push(resumed);
    const newSession = await resumed.runtime.sessions.create({ productMode: "chat", chatRetrievalMode: "rag" });
    const next = { ...binding, sessionId: newSession.id };
    expect((await (await resumed.knowledge.loadKnowledge(next)).knowledge!.prepareSearch({ ...next, query: "ORCHID_PRIVATE", topK: 8 })).evidence.length).toBeGreaterThan(0);
    for (const resource of resources) await resumed.knowledge.remove(resource.resourceId);
    expect(await resumed.knowledge.list()).toEqual([]);
    expect(workspace).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.host.storage.paths.stateRoot, "memory"))).toBe(false);
    expect(fs.readdirSync(path.join(f.host.storage.paths.knowledgeRoot, "sources"))).toEqual([]);
    expect(outbound.every(function localProvider(url) { return url.includes(".fixture"); })).toBe(true);
  }, 30_000);

  it("图片引用绑定批次/会话，伪造正文、跨会话、重放和删除后的引用不能读取", async function evidenceAuthorization() {
    const f = await fixture(); const id = await f.session(), other = await f.session();
    const image = createCanvas(20, 20).toBuffer("image/png");
    await (await f.upload(new File([new Uint8Array(image)], "orchid.png", { type: "image/png" }))).text();
    const binding: ChatCapabilityBinding = { sessionId: id, turnId: "bound_turn", retrievalMode: "rag" };
    const cap = await f.host.knowledge.loadKnowledge(binding);
    const batch = await cap.knowledge!.prepareSearch({ ...binding, query: "ORCHID_PRIVATE", topK: 5 });
    const ref = batch.evidence[0].visualEvidenceRef!;
    const input = { ...binding, ref, kind: "image" as const, batchId: batch.batchId };
    expect(await cap.authorizeRef!(input)).toBe(true);
    expect((await cap.readImage!(input)).mimeType).toBe("image/png");
    expect(await cap.authorizeRef!({ ...input, sessionId: other })).toBe(false);
    expect(await cap.authorizeRef!({ ...input, ref: "forged_reference_1234" })).toBe(false);
    expect(await cap.knowledge!.validateEvidence({ ...binding, batch: { ...batch, evidence: [{ ...batch.evidence[0], text: "forged" }] } })).toBe(false);
    await cap.knowledge!.prepareSearch({ ...binding, query: "ORCHID_PRIVATE", topK: 5 });
    expect(await cap.authorizeRef!(input)).toBe(false);
    const fresh = await cap.knowledge!.prepareSearch({ ...binding, query: "ORCHID_PRIVATE", topK: 5 });
    await f.host.knowledge.remove((await f.host.knowledge.list())[0].resourceId);
    expect(await cap.knowledge!.validateEvidence({ ...binding, batch: fresh })).toBe(false);
    await expect(cap.readImage!({ ...binding, ref: fresh.evidence[0].visualEvidenceRef!, batchId: fresh.batchId })).rejects.toMatchObject({ code: "CHAT_KNOWLEDGE_UNAVAILABLE" });
  });

  it("rag SSE 经过真实证据门输出摘录，空库不能输出模型常识；none/web 不加载知识", async function runtimeEvidenceGate() {
    const sample: NonNullable<RunConfig["modelSampler"]>["sample"] = vi.fn(async function sample(messages, tools) {
      expect(tools.map(function name(tool) { return tool.function.name; })).not.toEqual(expect.arrayContaining(["web_search"]));
      const result = messages.flatMap(function blocks(message) { return message.content; }).filter(function tool(block) { return block.type === "tool-result"; }).at(-1);
      if (!result) return { content: "", toolCalls: [{ id: "search_call", name: "rag_search", input: { query: "ORCHID_PRIVATE" } }], reasoningSummary: "", finishReason: "tool_calls" };
      const content = result.type === "tool-result" ? result.content.map(function text(block) { return block.text; }).join("") : "";
      const match = /"id":"([a-zA-Z0-9_-]{16,128})"/.exec(content);
      // 现行答案协议：有证据经 chat_submit_answer 提交逐字摘录；空召回提交 insufficient，由宿主回复"知识库未覆盖"。
      return match
        ? { content: "", toolCalls: [{ id: "submit-answer", name: "chat_submit_answer", input: { quotes: [{ evidenceId: match[1], quote: canary }] } }], reasoningSummary: "", finishReason: "tool_calls" }
        : { content: "", toolCalls: [{ id: "submit-insufficient", name: "chat_submit_answer", input: { insufficient: true } }], reasoningSummary: "", finishReason: "tool_calls" };
    });
    const f = await fixture({ sample }); const id = await f.session();
    await (await f.upload(new File([canary], "orchid.txt"), id)).text();
    const response = await f.sessionRoute("POST", [id, "messages"], { content: "ORCHID_PRIVATE", clientMessageId: "message_stage5" });
    expect(await response.text()).toContain("turn_completed");
    const history = await (await f.sessionRoute("GET", [id])).json();
    expect(history.messages.at(-1).content).toContain(canary);
    expect(history.messages.at(-1).content).toContain("[1] orchid.txt");
    expect(history.messages.at(-1).content).not.toMatch(/\[[a-zA-Z0-9_-]{16,128}\]/);
    for (const resource of await f.host.knowledge.list()) await f.host.knowledge.remove(resource.resourceId);
    const emptyId = await f.session();
    const empty = await f.sessionRoute("POST", [emptyId, "messages"], { content: "ORCHID_PRIVATE", clientMessageId: "empty_stage5" });
    const stream = await empty.text(); expect(stream).toContain("知识库未覆盖"); expect(stream).not.toContain("unsupported fact");
    const ordinaryHost = await fixture();
    const outboundBefore = outbound.length;
    for (const mode of ["none", "web"]) {
      const ordinary = await ordinaryHost.session(mode);
      const response = await ordinaryHost.sessionRoute("POST", [ordinary, "messages"], { content: "ordinary question", clientMessageId: `ordinary_${mode}` });
      expect(await response.text()).not.toContain(canary);
      await expect(ordinaryHost.host.knowledge.loadKnowledge({ sessionId: ordinary, turnId: "forged", retrievalMode: "rag" })).rejects.toMatchObject({ code: "CHAT_KNOWLEDGE_UNAVAILABLE" });
    }
    expect(fs.existsSync(ordinaryHost.host.storage.paths.knowledgeRoot)).toBe(false);
    expect(outbound).toHaveLength(outboundBefore);
  });

  /** 用例尾部用文件 symlink 验证路径逃逸拒绝；Windows 创建 symlink 报 EPERM，仅在非 Windows 运行。 */
  it.skipIf(process.platform === "win32")("空文档入库失败而非假成功；预览拒绝被替换为链接的正式来源", async function emptyAndLinkedSource() {
    const f = await fixture();
    const empty = await f.upload(new File(["   \n"], "empty.txt"));
    expect(await empty.text()).toContain("event: failed");
    expect((await f.host.knowledge.list())[0].status).toBe("failed");
    const image = new Uint8Array(createCanvas(10, 10).toBuffer("image/png"));
    await (await f.upload(new File([image], "orchid.png", { type: "image/png" }))).text();
    const resource = (await f.host.knowledge.list()).find(function image(item) { return item.type === "image"; })!;
    const sources = path.join(f.host.storage.paths.knowledgeRoot, "sources");
    const original = path.join(sources, fs.readdirSync(sources)[0]);
    const outside = path.join(f.root, "outside.png"); fs.writeFileSync(outside, image); fs.unlinkSync(original); fs.symlinkSync(outside, original);
    await expect(f.host.knowledge.preview(resource.resourceId, new AbortController().signal)).rejects.toMatchObject({ code: "RAG_STORAGE_INVALID" });
  });

  it("用户入口拒绝模式/路径/method 篡改，取消不假成功，安全错误不接受继承键", async function routeBoundaries() {
    const f = await fixture(); const none = await f.session("none"), rag = await f.session();
    const file = new File([canary], "orchid.txt");
    expect((await f.upload(file, none)).status).toBe(409);
    expect((await f.upload(file, rag, "workspaceId")).status).toBe(400);
    expect((await f.upload(file, undefined, "storage")).status).toBe(400);
    const loadHost = vi.fn(async function load() { return f.host; });
    expect((await runChatKnowledgeRoute(new Request("http://localhost?workspaceId=foreign"), [], loadHost)).status).toBe(400);
    expect((await runChatKnowledgeRoute(new Request("http://localhost", { method: "PATCH" }), [], loadHost)).status).toBe(405);
    expect(loadHost).not.toHaveBeenCalled();
    const cancelled = await f.upload(file, rag, undefined, AbortSignal.abort());
    expect(await cancelled.text()).toContain("event: cancelled");
    expect(await f.host.knowledge.list()).toEqual([]);
    expect(toSafeKnowledgeError({ code: "constructor", message: canary })).toEqual({ code: "KNOWLEDGE_OPERATION_FAILED", message: "知识资源操作失败" });
    await expect(validateKnowledgeUpload(new File(["fake"], "fake.png", { type: "image/png" }))).rejects.toMatchObject({ code: "UPLOAD_MIME_INVALID" });
  });
});
