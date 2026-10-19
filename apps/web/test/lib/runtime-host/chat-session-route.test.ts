/** Chat Host/API 集成：用真实公开 Core/Node 存储和 fake sampler 验证无工作区聊天、附件及生命周期。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { createCanvas } from "@napi-rs/canvas";
import type { RunConfig } from "@autopilot-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ATTACHMENT_TTL_MS, NodeChatError, createNodeWorkspaceRegistry } from "@autopilot-agent/adapters";
import { createWebChatHost, type WebChatHost, type WebChatHostOptions } from "@/lib/runtime-host/web-chat-host";
import { runChatSessionRoute, toChatErrorResponse } from "@/lib/runtime-host/chat-session-route";
import { createSessionTaskController } from "@/app/chat/session-task-controller";

const roots: string[] = [];
const hosts: WebChatHost[] = [];

/** 每个夹具使用独占 state/home，不访问真实用户配置、知识库或 Provider。 */
async function fixture(extra: Partial<WebChatHostOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-host-stage3-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "home"));
  let now = 2_000_000_000_000;
  const sample = vi.fn(async function answer() { return { content: "讨论完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; });
  const options = { globalStateRoot: root, homeDirectory: path.join(root, "home"), env: { NODE_ENV: "test" as const }, modelSampler: { sample }, now: function clock() { return now; }, ...extra };
  const host = await createWebChatHost(options);
  hosts.push(host);
  const workspace = vi.spyOn(host.storage.ports.workspaceAdapter, "resolveWorkspaceRoot");
  /** 直接调用正式 HTTP 适配，唯一 seam 是宿主实例。 */
  function route(method: string, segments: string[], body?: unknown) {
    return runChatSessionRoute(new Request(`http://localhost/api/chat/sessions/${segments.join("/")}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }), segments, async function load() { return host; });
  }
  /** 通过 canonical POST 创建会话，保证测试未绕过产品身份校验。 */
  async function session(mode = "none") { const response = await route("POST", [], { chatRetrievalMode: mode }); expect(response.status).toBe(201); return (await response.json()).id as string; }
  /** 使用真实 multipart 与 Store MIME 识别路径。 */
  async function upload(id: string, file: File, extraField?: string) {
    const form = new FormData(); form.set("file", file); if (extraField) form.set(extraField, "forged");
    return runChatSessionRoute(new Request("http://localhost/api/chat/sessions", { method: "POST", body: form }), [id, "attachments"], async function load() { return host; });
  }
  return { root, host, options, route, session, upload, sample, workspace, advance: function advance(ms: number) { now += ms; } };
}

/** 先停止维护与请求，再清理本测试创建的目录。 */
afterEach(function cleanup() { for (const host of hosts.splice(0)) host.stop(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("Chat Host Stage3", function suite() {
  /** 从真实上传到实际采样目录和工具读取，验证临时文件不初始化或写入知识根。 */
  it.each(["none", "web"])("%s 图片和文档只作为临时附件，模型从目录取得引用", async function temporaryAttachments(mode) {
    const loadKnowledge = vi.fn();
    const visionAnalyzer = { analyze: vi.fn(async function seeImage() { return "TEMP_IMAGE_CANARY"; }) };
    const sample: NonNullable<RunConfig["modelSampler"]>["sample"] = async function sample(messages) {
      const catalogText = messages.flatMap(function blocks(message) { return message.role === "system" ? message.content : []; }).find(function catalog(block) { return block.type === "text" && block.text.startsWith("【当前会话临时附件】"); });
      expect(catalogText?.type).toBe("text");
      const catalog = JSON.parse(catalogText!.type === "text" ? catalogText!.text.split("\n").at(-1)! : "[]") as Array<{ attachmentRef: string; displayName: string; kind: string }>;
      expect(catalog.map(function name(item) { return item.displayName; }).sort()).toEqual(["picture.png", "roster.txt"]);
      const results = messages.flatMap(function blocks(message) { return message.content; }).filter(function result(block) { return block.type === "tool-result"; });
      if (!results.length) return { content: "", toolCalls: catalog.map(function call(item) { return { id: item.kind, name: item.kind === "document" ? "chat_attachment_read" : "chat_vision_analyze", input: { attachmentRef: item.attachmentRef, ...(item.kind === "image" ? { prompt: "只看当前图片" } : {}) } }; }), reasoningSummary: "", finishReason: "tool_calls" };
      expect(JSON.stringify(results)).toContain("值班人数：8 人");
      expect(JSON.stringify(results)).toContain("TEMP_IMAGE_CANARY");
      return { content: "8 人", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    };
    const f = await fixture({ modelSampler: { sample }, capability: { loadKnowledge, visionAnalyzer } });
    const id = await f.session(mode);
    expect((await f.upload(id, new File(["值班人数：8 人。"], "roster.txt"))).status).toBe(201);
    expect((await f.upload(id, new File([new Uint8Array(createCanvas(20, 20).toBuffer("image/png"))], "picture.png", { type: "image/png" }))).status).toBe(201);
    const response = await f.route("POST", [id, "messages"], { content: "看文件和图片", clientMessageId: "temporary_catalog_001" });
    expect(await response.text()).toContain("turn_completed");
    expect(visionAnalyzer.analyze).toHaveBeenCalledOnce();
    expect(loadKnowledge).not.toHaveBeenCalled();
    expect(fs.existsSync(f.host.storage.paths.knowledgeRoot)).toBe(false);
    const history = await (await f.route("GET", [id])).json();
    expect(history.messages.at(-1).content).toBe("8 人");
  });

  it("空 Registry 下三态 Session 可创建，none/web 复用 Runtime 完成 SSE 与历史，无 Workspace/Memory", async function chatsWithoutWorkspace() {
    const f = await fixture();
    expect(createNodeWorkspaceRegistry({ globalStateRoot: f.root }).list()).toEqual([]);
    for (const mode of ["none", "web", "rag"]) {
      const id = await f.session(mode);
      const response = await f.route("POST", [id, "messages"], { content: "讨论", clientMessageId: "message_001" });

      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(await response.text()).toContain("turn_completed");
      const history = await (await f.route("GET", [id])).json();
      expect(history.meta).toMatchObject({ productMode: "chat", chatRetrievalMode: mode });
      expect(history.messages.map(function content(message: { content: string }) { return message.content; })).toEqual(["讨论", mode === "rag" ? "知识库未覆盖此问题或当前证据不足，请补充相关资料后重试。" : "讨论完成"]);
      const duplicate = await f.route("POST", [id, "messages"], { content: "重复", clientMessageId: "message_001" });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "CHAT_MESSAGE_ALREADY_SUBMITTED" });
    }
    expect(f.sample).toHaveBeenCalledTimes(3);
    expect(f.workspace).not.toHaveBeenCalled();
    expect(fs.existsSync(f.host.storage.paths.knowledgeRoot)).toBe(true);
    expect(fs.existsSync(path.join(f.host.storage.paths.stateRoot, "memory"))).toBe(false);
  });

  it.each([
    "我在 Neon 官网控制台创建了一个数据库……这次不改代码。",
    "我已经在 Neon 官网控制台创建好数据库，请解释后续连接方式；这次不改代码。",
  ])("历史控制台动作叙述经真实 Web Runtime/SSE 完成并进入会话状态：%s", async function completesHistoricalConsoleNarrative(content) {
    const answer = "数据库已在控制台创建；下面是连接方式说明。";
    const f = await fixture({ modelSampler: { sample: async function answerHistoricalAction() { return { content: answer, toolCalls: [], reasoningSummary: "只读说明", finishReason: "stop" }; } } });
    const id = await f.session();
    const response = await f.route("POST", [id, "messages"], { content, clientMessageId: "history_readonly_001" });
    const received: Array<Record<string, unknown>> = [];
    const controller = createSessionTaskController(id, function applyWebSseEvent(_messageId, event) { received.push(event); });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    await controller.consume(response, "message_history_readonly");

    const eventTypes = received.map(function eventType(event) { return event.type; });
    expect(eventTypes).not.toContain("answer_discard");
    expect(eventTypes).not.toContain("turn_failed");
    expect(eventTypes).toContain("answer_delta");
    expect(eventTypes).toContain("turn_completed");
    expect(received.filter(function answerDelta(event) { return event.type === "answer_delta"; }).map(function readDelta(event) { return event.delta; }).join("")).toBe(answer);

    const history = await (await f.route("GET", [id])).json();
    expect(history.meta.runtimeStatus).toBe("completed");
    expect(history.messages.map(function message(item: { role: string; content: string }) { return { role: item.role, content: item.content }; }))
      .toEqual([{ role: "user", content }, { role: "assistant", content: answer }]);
  });

  it("拒绝模式、工具、工作区、跨会话引用和 HTTP method 篡改，不执行 sampler 或解析", async function rejectsForgedRequests() {
    const parseDocument = vi.fn();
    const f = await fixture({ parseDocument });
    for (const body of [{ chatRetrievalMode: ["none"] }, { chatRetrievalMode: "none", workspaceId: "work" }, { chatRetrievalMode: "rag", web: true }]) expect((await f.route("POST", [], body)).status).toBe(400);
    const id = await f.session();
    const other = await f.session();
    // Store 已拒绝错域记录；模拟宿主错误返回 Work，再验证 Route 的独立身份检查。
    const foreign = { ...await f.host.runtime.sessions.get(id), id: "foreign_work", productMode: "work" as const, projectId: "foreign_project", chatRetrievalMode: undefined };
    await expect(f.host.storage.ports.sessionStore.save(foreign)).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    const getSession = vi.spyOn(f.host.runtime.sessions, "get").mockResolvedValueOnce(foreign);
    expect((await f.route("GET", ["foreign_work"])).status).toBe(409);
    getSession.mockRestore();
    expect((await f.route("POST", [id, "messages"], { content: "x", clientMessageId: "message_002", runConfig: { toolAllowlist: ["write_file"] } })).status).toBe(400);
    expect((await f.route("PATCH", [id], { chatRetrievalMode: "rag" })).status).toBe(405);
    const loader = vi.fn();
    expect((await runChatSessionRoute(new Request("http://localhost/api/chat/sessions", { method: "DELETE" }), [], loader)).status).toBe(405);
    expect(loader).not.toHaveBeenCalled();
    expect((await f.upload(id, new File(["%PDF-invalid"], "test.pdf"), "workspaceId")).status).toBe(400);
    const attachment = await (await f.upload(id, new File(["private text"], "note.txt"))).json();
    expect((await f.route("GET", [other, "attachments", attachment.attachment.ref])).status).toBe(400);
    expect((await f.route("POST", [id, "knowledge"])).status).toBe(409);
    const rag = await f.session("rag");
    expect((await f.upload(rag, new File(["private text"], "note.txt"))).status).toBe(409);
    expect((await f.route("POST", [rag, "knowledge"])).status).toBe(400);
    expect(parseDocument).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
  });

  it("复用 Core Excel 解析、固定 TTL 和删除屏障；重启恢复中断删除且保留知识文件", async function parsesAndRecoversDeletion() {
    const f = await fixture();
    const id = await f.session();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目"], ["共享解析"]]), "Sheet1");
    const response = await f.upload(id, new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "fixture.xlsx"));
    expect(response.status).toBe(201);
    const attachment = (await response.json()).attachment;
    expect(attachment.expiresAt - attachment.createdAt).toBe(CHAT_ATTACHMENT_TTL_MS);
    expect((await f.host.storage.attachments.readAttachment(id, attachment.ref)).text).toContain("共享解析");
    f.advance(CHAT_ATTACHMENT_TTL_MS);
    expect((await f.route("GET", [id, "attachments", attachment.ref])).status).toBe(400);
    fs.mkdirSync(f.host.storage.paths.knowledgeRoot, { recursive: true });
    const knowledge = path.join(f.host.storage.paths.knowledgeRoot, "preserve.txt");
    fs.writeFileSync(knowledge, "knowledge-canary");
    await f.host.storage.attachments.deleteBySession(id);
    expect((await f.route("POST", [id, "messages"], { content: "x", clientMessageId: "message_003" })).status).toBe(409);
    f.host.stop();
    const resumed = await createWebChatHost(f.options); hosts.push(resumed);
    expect(await resumed.storage.ports.sessionStore.get(id)).toBeNull();
    expect(fs.readFileSync(knowledge, "utf8")).toBe("knowledge-canary");
  });

  it("上传解析期间删除会话，迟到结果不能提交；失败删除可安全重试", async function deletionRaces() {
    let release!: (value: { text: string }) => void;
    const parseDocument = vi.fn(function pendingParse() { return new Promise<{ text: string }>(function gate(resolve) { release = resolve; }); });
    const f = await fixture({ parseDocument });
    const id = await f.session();
    const upload = f.upload(id, new File(["%PDF-1.7 fixture"], "file.pdf"));
    await vi.waitFor(function parsing() { expect(parseDocument).toHaveBeenCalledOnce(); });
    expect((await f.route("DELETE", [id])).status).toBe(200);
    release({ text: "late" });
    expect((await upload).status).toBe(400);
    const second = await f.session();
    await f.upload(second, new File(["note"], "note.txt"));
    const cleanup = vi.spyOn(f.host.storage.ports.sessionResourceStore, "deleteBySession").mockRejectedValueOnce(new NodeChatError("CHAT_ATTACHMENT_CLEANUP_FAILED"));
    expect((await f.route("DELETE", [second])).status).toBe(503);
    expect(await f.host.runtime.sessions.get(second)).toBeDefined();
    expect((await f.route("DELETE", [second])).status).toBe(200);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("cancel 只取消当前会话的 Turn，结束后才能删除会话", async function cancelsBoundTurn() {
    const sample = vi.fn(async function pending(_messages, _tools, options) {
      await new Promise<void>(function aborted(resolve) { options.signal.addEventListener("abort", function done() { resolve(); }, { once: true }); });
      return { content: "", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    });
    const f = await fixture({ modelSampler: { sample } });
    const id = await f.session();
    const other = await f.session();
    const response = await f.route("POST", [id, "messages"], { content: "等待", clientMessageId: "message_cancel" });
    await vi.waitFor(function sampling() { expect(sample).toHaveBeenCalledOnce(); });
    const turnId = (await f.host.runtime.turns.getState({ sessionId: id })).turn!.id;
    const foreignCancel = await f.route("POST", [other, "cancel"], { turnId });
    expect(foreignCancel.status).toBe(404);
    expect(await foreignCancel.json()).toMatchObject({ code: "TURN_NOT_FOUND" });
    expect((await f.host.runtime.turns.getState({ sessionId: id })).turn?.status).toBe("running");
    expect((await f.route("POST", [id, "cancel"], { turnId })).status).toBe(200);
    await response.text();
    expect((await f.host.runtime.turns.getState({ sessionId: id })).turn?.status).not.toBe("running");
    expect((await f.route("DELETE", [id])).status).toBe(200);
  });

  it("错误边界严格白名单，区分损坏请求、内部故障与宿主停用", async function validatesErrors() {
    for (const code of ["constructor", "__proto__", "toString", { toString: function forged() { throw new Error("不能调用"); } }]) {
      const response = toChatErrorResponse({ code, message: "/private/secret" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "CHAT_INTERNAL_ERROR", error: "Chat 服务发生内部错误" });
    }
    const loader = vi.fn(async function brokenHost(): Promise<WebChatHost> { throw new Error("/private/secret"); });
    const malformed = await runChatSessionRoute(new Request("http://localhost", { method: "POST", body: "{" }), [], loader);
    expect(malformed.status).toBe(400);
    expect(loader).not.toHaveBeenCalled();
    expect((await runChatSessionRoute(new Request("http://localhost"), [], loader)).status).toBe(500);
    const f = await fixture();
    const id = await f.session();
    const upload = await runChatSessionRoute(new Request("http://localhost", { method: "POST", body: "broken multipart", headers: { "Content-Type": "multipart/form-data" } }), [id, "attachments"], async function load() { return f.host; });
    expect(upload.status).toBe(400);
    expect(await upload.json()).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
    f.host.stop();
    const stopped = await f.route("GET", [id]);
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toMatchObject({ code: "CHAT_SERVICE_UNAVAILABLE" });
  });

  it("宿主停止取消正在采样的 Core Turn，并释放维护句柄", async function stopsActiveChat() {
    const sample = vi.fn(async function pending(_messages, _tools, options) {
      await new Promise<void>(function aborted(resolve) { options.signal.addEventListener("abort", function done() { resolve(); }, { once: true }); });
      return { content: "", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    });
    const f = await fixture({ modelSampler: { sample } });
    const id = await f.session();
    const response = await f.route("POST", [id, "messages"], { content: "等待", clientMessageId: "message_004" });
    await vi.waitFor(function sampling() { expect(sample).toHaveBeenCalledOnce(); });
    expect((await f.route("DELETE", [id])).status).toBe(409);
    f.host.stop();
    await response.text();
    expect(f.host.signal.aborted).toBe(true);
    expect((await f.host.runtime.turns.getState({ sessionId: id })).turn?.status).not.toBe("running");
  });
});
