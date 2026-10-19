/** Chat HTTP 适配：校验封闭 DTO 与持久身份，复用 Core Session/Turn、Web SSE 和历史投影。 */
import { createChatKnowledgeUploadResponse, toChatKnowledgeError } from "./chat-knowledge-route";
import { WebRouteError, findHttpFailure, httpErrorResponse, readHttpErrorCode, readRequestObject, readRequestForm } from "./web-http-error";
import { createHash } from "node:crypto";
import type { ChatRetrievalMode, Session } from "@autopilot-agent/core";
import { NodeChatError } from "@autopilot-agent/adapters";
import { getWebChatHost, type WebChatHost } from "./web-chat-host";
import { loadCore } from "../core-loader";
import { toWebSessionDto } from "./web-ui-dto";
import { getSessionMessages } from "../session-store";
import { persistUserMessage } from "./web-message-projection";
import { replayWebPresentation } from "./web-presentation-adapter";
import { createRuntimeAgentStream } from "./web-agent-stream";
import { cancelActiveTurn, tryAcquireQueueStartLock } from "../agent-turn-store";

const CHAT_HTTP_FAILURES = {
  INVALID_CHAT_REQUEST: { status: 400, message: "Chat 请求无效" },
  SESSION_NOT_FOUND: { status: 404, message: "Chat 会话不存在" },
  TURN_NOT_FOUND: { status: 404, message: "任务不存在或不属于当前会话" },
  SESSION_MODE_MISMATCH: { status: 409, message: "会话产品或检索身份不匹配" },
  CHAT_RETRIEVAL_MODE_LOCKED: { status: 409, message: "检索模式已固定，请新建对话" },
  TURN_ALREADY_RUNNING: { status: 409, message: "会话已有活动任务，请等待任务结束" },
  CHAT_SESSION_BUSY: { status: 409, message: "会话操作正在进行，请稍后重试" },
  CHAT_MESSAGE_ALREADY_SUBMITTED: { status: 409, message: "该消息已提交，请查看会话历史，不要重复发送" },
  CHAT_UPLOAD_MODE_MISMATCH: { status: 409, message: "附件入口与会话检索模式不匹配" },
  CHAT_ATTACHMENT_UNAVAILABLE: { status: 400, message: "附件不可用，请检查类型、大小和有效期" },
  CHAT_ATTACHMENT_CANCELLED: { status: 409, message: "附件操作已取消" },
  CHAT_SESSION_DELETING: { status: 409, message: "会话正在删除，请稍后重试" },
  CHAT_KNOWLEDGE_UNAVAILABLE: { status: 503, message: "Chat 私有知识能力尚未接入" },
  CHAT_ATTACHMENT_PARSER_UNAVAILABLE: { status: 503, message: "文档解析暂时不可用" },
  CHAT_ATTACHMENT_CLEANUP_FAILED: { status: 503, message: "附件清理未完成，请重试删除" },
  CHAT_SERVICE_UNAVAILABLE: { status: 503, message: "Chat 服务暂时不可用" },
  CHAT_INTERNAL_ERROR: { status: 500, message: "Chat 服务发生内部错误" },
};

/** 只输出固定 HTTP 错误；未知异常为 500，明确停用或能力不可用才为 503。 */
export function toChatErrorResponse(error: unknown): Response {
  const code = readHttpErrorCode(error);
  const failure = findHttpFailure(CHAT_HTTP_FAILURES, code);
  return failure ? httpErrorResponse(code!, failure) : httpErrorResponse("CHAT_INTERNAL_ERROR", CHAT_HTTP_FAILURES.CHAT_INTERNAL_ERROR);
}

/** DTO 必须是普通对象且只能包含当前操作明确允许的字段。 */
async function readBody(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readRequestObject(request, "INVALID_CHAT_REQUEST");
  if (Object.keys(body).some(function unknownField(key) { return !fields.includes(key); })) throw new WebRouteError("INVALID_CHAT_REQUEST");
  return body;
}

/** 所有子路由先读取持久身份，缺失或跨产品会话不能触发操作。 */
async function requireChatSession(host: WebChatHost, sessionId: string): Promise<Session> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new WebRouteError("INVALID_CHAT_REQUEST");
  const session = await host.runtime.sessions.get(sessionId);
  if (session.productMode !== "chat") throw new (loadCore().AgentRuntimeError)("SESSION_MODE_MISMATCH", "Chat 身份不匹配");
  return session;
}

/** 用现有安全会话 DTO 加上只读产品身份，绝不返回模型配置或存储路径。 */
function chatDto(session: Session) {
  return { ...toWebSessionDto(session), productMode: "chat" as const, chatRetrievalMode: session.chatRetrievalMode };
}

/** 只负责路由分发；不实现或复制 Runtime 的任务状态机。 */
export async function runChatSessionRoute(request: Request, segments: string[] = [], loadHost = getWebChatHost): Promise<Response> {
  const [sessionId, operation, attachmentRef] = segments;
  const shape = !segments.length ? "collection"
    : segments.length === 1 ? "session"
      : segments.length === 2 && ["messages", "cancel", "attachments", "knowledge"].includes(operation) ? operation
        : segments.length === 3 && operation === "attachments" && /^[A-Za-z0-9_-]{16,128}$/.test(attachmentRef) ? "attachment" : undefined;
  const methods: Record<string, string[]> = { collection: ["GET", "POST"], session: ["GET", "DELETE"], messages: ["POST"], cancel: ["POST"], attachments: ["GET", "POST"], attachment: ["GET"], knowledge: ["POST"] };
  if (!shape) return Response.json({ code: "CHAT_ROUTE_NOT_FOUND", error: "Chat 接口不存在" }, { status: 404 });
  if (!methods[shape].includes(request.method)) return Response.json({ code: "METHOD_NOT_ALLOWED", error: "请求方法不允许" }, { status: 405, headers: { Allow: methods[shape].join(", ") } });
  if (new URL(request.url).search) return toChatErrorResponse(new WebRouteError("INVALID_CHAT_REQUEST"));
  try {
    // 创建请求先验字段校验，再启动宿主；客户端不能指定 Workspace 或能力对象。
    let retrievalMode: ChatRetrievalMode | undefined;
    if (shape === "collection" && request.method === "POST") {
      const body = await readBody(request, ["chatRetrievalMode"]);
      if (typeof body.chatRetrievalMode !== "string" || !["none", "web", "rag"].includes(body.chatRetrievalMode)) throw new WebRouteError("INVALID_CHAT_REQUEST");
      retrievalMode = body.chatRetrievalMode as ChatRetrievalMode;
    }
    const host = await loadHost();
    if (host.signal.aborted) throw new WebRouteError("CHAT_SERVICE_UNAVAILABLE");
    if (shape === "collection") {
      if (request.method === "POST") return Response.json(chatDto(await host.runtime.sessions.create({ productMode: "chat", chatRetrievalMode: retrievalMode })), { status: 201 });
      const sessions = (await host.runtime.sessions.list()).filter(function onlyChat(session) { return session.productMode === "chat"; });
      return Response.json({ sessions: sessions.map(chatDto).sort(function recent(left, right) { return right.updatedAt - left.updatedAt; }) });
    }
    const session = await requireChatSession(host, sessionId);
    if (shape === "session" && request.method === "DELETE") {
      const release = tryAcquireQueueStartLock(sessionId);
      if (!release) throw new WebRouteError("CHAT_SESSION_BUSY");
      try { await host.runtime.sessions.delete(sessionId); return Response.json({ ok: true }); }
      finally { release(); }
    }
    if (host.storage.attachments.isSessionDeleting(sessionId)) throw new NodeChatError("CHAT_SESSION_DELETING");
    if (shape === "session") {
      const state = await host.runtime.turns.getState({ sessionId });
      return Response.json({ meta: chatDto(session), messages: await getSessionMessages(host.runtime, sessionId), presentation: replayWebPresentation(state.events), attachments: session.chatRetrievalMode === "rag" ? [] : await host.storage.attachments.list(sessionId) });
    }
    if (shape === "knowledge") {
      if (session.chatRetrievalMode !== "rag") throw new NodeChatError("CHAT_UPLOAD_MODE_MISMATCH");
      const release = tryAcquireQueueStartLock(sessionId);
      if (!release) throw new WebRouteError("CHAT_SESSION_BUSY");
      try { return await createChatKnowledgeUploadResponse(request, host, release); }
      catch (error) { release(); return toChatKnowledgeError(error); }
    }
    if (shape === "attachments" || shape === "attachment") {
      if (session.chatRetrievalMode === "rag") throw new NodeChatError("CHAT_UPLOAD_MODE_MISMATCH");
      if (shape === "attachment") {
        const file = await host.storage.attachments.readBytes(sessionId, attachmentRef, request.signal);
        return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.mimeType, "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
      }
      if (request.method === "GET") return Response.json({ attachments: await host.storage.attachments.list(sessionId) });
      const form = await readRequestForm(request, "INVALID_CHAT_REQUEST");
      const file = form.get("file");
      if (Array.from(form.keys()).some(function unknownField(key) { return key !== "file"; }) || form.getAll("file").length !== 1 || !(file instanceof File) || file.size > 20 * 1024 * 1024) throw new WebRouteError("INVALID_CHAT_REQUEST");
      const attachment = await host.storage.attachments.put({ sessionId, displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), signal: AbortSignal.any([request.signal, host.signal]) });
      return Response.json({ attachment }, { status: 201 });
    }
    if (shape === "cancel") {
      const body = await readBody(request, ["turnId"]);
      if (typeof body.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.turnId)) throw new WebRouteError("INVALID_CHAT_REQUEST");
      const state = await host.runtime.turns.getState({ sessionId, turnId: body.turnId });
      if (!state.turn) throw new (loadCore().AgentRuntimeError)("TURN_NOT_FOUND", "任务不存在或不属于当前会话");
      cancelActiveTurn(sessionId, body.turnId);
      await host.runtime.turns.cancel({ sessionId, turnId: body.turnId });
      return Response.json({ ok: true });
    }
    const body = await readBody(request, ["content", "clientMessageId"]);
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100_000 || typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.clientMessageId)) throw new WebRouteError("INVALID_CHAT_REQUEST");
    const turnId = createHash("sha256").update(`${sessionId}:${body.clientMessageId}`).digest("hex");
    const release = tryAcquireQueueStartLock(sessionId);
    if (!release) throw new WebRouteError("CHAT_SESSION_BUSY");
    try {
      const state = await host.runtime.turns.getState({ sessionId });
      if ((await host.runtime.turns.getState({ sessionId, turnId })).turn) throw new WebRouteError("CHAT_MESSAGE_ALREADY_SUBMITTED");
      if (["running", "waiting_approval", "waiting_user_input"].includes(state.turn?.status ?? "")) throw new (loadCore().AgentRuntimeError)("TURN_ALREADY_RUNNING", "会话已有活动任务");
      await persistUserMessage(host.runtime, sessionId, body.content.trim());
      const stream = createRuntimeAgentStream({ sessionId, turnId, runtime: host.runtime, mode: "start", content: body.content.trim(), requestSignal: AbortSignal.any([request.signal, host.signal]), onSettled: release });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
    } catch (error) { release(); throw error; }
  } catch (error) { return toChatErrorResponse(error); }
}
