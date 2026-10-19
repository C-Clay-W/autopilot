/** Chat 知识 HTTP：用户管理与模型只读端口分开，复用上传校验、SSE 终态及安全错误协议。 */
import { getWebChatHost, type WebChatHost } from "./web-chat-host";
import { WebRouteError, readRequestForm, httpErrorResponse } from "./web-http-error";
import { validateKnowledgeUpload } from "../knowledge-service";
import { toKnowledgeErrorResponse, toSafeKnowledgeError } from "../knowledge-error";

/** 未知知识错误固定脱敏；只识别已有知识错误和本层请求/宿主状态。 */
export function toChatKnowledgeError(error: unknown): Response {
  return toKnowledgeErrorResponse(error) ?? (error instanceof WebRouteError && error.code === "INVALID_CHAT_REQUEST"
    ? httpErrorResponse(error.code, { status: 400, message: "Chat 请求无效" })
    : error instanceof WebRouteError && error.code === "CHAT_SERVICE_UNAVAILABLE"
      ? httpErrorResponse(error.code, { status: 503, message: "Chat 服务暂时不可用" })
      : httpErrorResponse("KNOWLEDGE_OPERATION_FAILED", { status: 500, message: "知识资源操作失败" }));
}

/** 只接受一个 file；校验完成后创建流，取消与 Host 停止传给原 Core 入库。 */
export async function createChatKnowledgeUploadResponse(request: Request, host: WebChatHost, onSettled: () => void = function settled() {}): Promise<Response> {
  const form = await readRequestForm(request, "INVALID_CHAT_REQUEST");
  const file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1 || Array.from(form.keys()).some(function extra(key) { return key !== "file"; })) throw new WebRouteError("INVALID_CHAT_REQUEST");
  const upload = await validateKnowledgeUpload(file);
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, host.signal, controller.signal]);
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    /** 不输出 Core 原始 message/chunkText，只投影有限阶段、计数及唯一终态。 */
    async start(output) {
      /** 断开连接后不再写流，但仍等待 Core 收口后释放 Session 锁。 */
      function emit(event: string, data: unknown): void { if (!closed) output.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
      try {
        const result = await host.knowledge.ingest(upload, signal, function progress(value) {
          const event = value as { step?: string; current?: number; total?: number };
          const step = ["parse", "parse_start", "parse_page", "text_parse_page", "image_render_page", "page_merge", "page_embed_item", "write_pages", "chunk_row", "chunk_complete", "chunk_item", "embed", "write"].includes(event.step ?? "") ? event.step : "parse";
          emit("progress", { step, current: Number.isFinite(event.current) ? event.current : undefined, total: Number.isFinite(event.total) ? event.total : undefined });
        });
        emit(result.status === "partial" ? "partial" : "completed", { resourceId: result.resourceId, type: result.type, totalRows: result.totalRows, totalChunks: result.totalChunks, failedPages: result.failedPages ?? [] });
      } catch (error) { emit(signal.aborted ? "cancelled" : "failed", signal.aborted ? { code: "RAG_OPERATION_CANCELLED", message: "知识库操作已取消" } : toSafeKnowledgeError(error)); }
      finally { if (!closed) { closed = true; output.close(); } onSettled(); }
    },
    /** 浏览器主动取消会中止排队/解析/Provider，写锁由真正终态释放。 */
    cancel() { closed = true; controller.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

/** canonical 管理 API 不接受 Session、Workspace、表名、路径或 Knowledge Space 选择。 */
export async function runChatKnowledgeRoute(request: Request, segments: string[] = [], loadHost = getWebChatHost): Promise<Response> {
  const [id, operation] = segments;
  const pageNumber = segments.length === 4 && segments[2] === "pages" && /^[1-9]\d{0,5}$/.test(segments[3]) ? Number(segments[3]) : undefined;
  const shape = !segments.length ? "collection" : /^resource_[a-f0-9]{32}$/.test(id) && segments.length === 1 ? "resource" : /^resource_[a-f0-9]{32}$/.test(id) && (segments.length === 2 || pageNumber !== undefined) && operation === "preview" ? "preview" : undefined;
  if (!shape) return httpErrorResponse("CHAT_ROUTE_NOT_FOUND", { status: 404, message: "Chat 接口不存在" });
  const methods = shape === "collection" ? ["GET", "POST"] : shape === "resource" ? ["DELETE"] : ["GET"];
  if (!methods.includes(request.method)) return Response.json({ code: "METHOD_NOT_ALLOWED", error: "请求方法不允许" }, { status: 405, headers: { Allow: methods.join(", ") } });
  try {
    if (new URL(request.url).search || (request.method !== "POST" && request.body)) throw new WebRouteError("INVALID_CHAT_REQUEST");
    const host = await loadHost();
    if (host.signal.aborted) throw new WebRouteError("CHAT_SERVICE_UNAVAILABLE");
    if (request.method === "POST") return await createChatKnowledgeUploadResponse(request, host);
    if (shape === "collection") return Response.json({ resources: await host.knowledge.list() }, { headers: { "Cache-Control": "no-store" } });
    if (shape === "resource") { await host.knowledge.remove(id); return Response.json({ ok: true }); }
    const preview = await host.knowledge.preview(id, request.signal, pageNumber);
    return new Response(new Uint8Array(preview.buffer), { headers: { "Content-Type": preview.mimeType, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch (error) { return toChatKnowledgeError(error); }
}
