/**
 * 浏览器端 Workspace 知识入库客户端。
 *
 * 只调用 canonical Workspace Route，并消费其稳定 SSE 进度与唯一终态；
 * 不再依赖旧全局上传入口、内部表名或历史 complete/error 事件。
 */

/** canonical 入库 Route 允许公开的进度字段。 */
export interface KnowledgeIngestProgress {
  step?: string;
  message?: string;
  current?: number;
  total?: number;
  rowIndex?: number;
  chunkIndex?: number;
  totalChunks?: number;
}

/** canonical 入库 Route 返回的安全资源结果。 */
export interface KnowledgeIngestResult {
  resourceId: string;
  type: string;
  status: "completed" | "partial";
  totalRows?: number;
  totalChunks?: number;
  failedPages: number[];
}

/** 浏览器消费到的唯一入库终态。 */
export type KnowledgeIngestTerminal =
  | { status: "completed" | "partial"; result: KnowledgeIngestResult }
  | { status: "cancelled" | "failed"; code?: string; message: string };

/** 可选的 Session 展示记录身份；服务端据此持久化上传项与终态卡片。 */
export interface KnowledgeIngestHistoryTarget {
  sessionId: string;
  clientRecordId: string;
}

interface ServerSentEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 生成绑定 opaque Workspace 身份的 canonical 入库地址。 */
export function getWorkspaceKnowledgeIngestUrl(workspaceId: string): string {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) throw new Error("请先选择工作区");
  return `/api/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/knowledge/ingest`;
}

/** 把一个完整 SSE frame 解析为事件；空 frame 和注释返回 undefined。 */
function parseServerSentEvent(frame: string): ServerSentEvent | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return undefined;
  const parsed = JSON.parse(dataLines.join("\n")) as unknown;
  return { event, data: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {} };
}

/** 从 JSON 错误响应中提取允许展示的稳定文案。 */
async function readHttpError(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const payload = await response.json() as { code?: unknown; error?: unknown; message?: unknown };
    const code = typeof payload.code === "string" ? payload.code : undefined;
    const message = typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string" ? payload.message : "知识库入库失败";
    return { code, message };
  } catch {
    return { message: "知识库入库失败" };
  }
}

/** 校验成功/部分成功终态中的安全资源字段。 */
function parseSuccessTerminal(event: "completed" | "partial", data: Record<string, unknown>): KnowledgeIngestTerminal {
  if (typeof data.resourceId !== "string" || !data.resourceId || typeof data.type !== "string") {
    return { status: "failed", message: "入库响应缺少资源身份" };
  }
  return {
    status: event,
    result: {
      resourceId: data.resourceId,
      type: data.type,
      status: event,
      totalRows: typeof data.totalRows === "number" ? data.totalRows : undefined,
      totalChunks: typeof data.totalChunks === "number" ? data.totalChunks : undefined,
      failedPages: Array.isArray(data.failedPages)
        ? data.failedPages.filter(function isPageNumber(value): value is number { return Number.isInteger(value) && value > 0; })
        : [],
    },
  };
}

/** 把 canonical SSE 事件收敛为进度或唯一终态。 */
function reduceKnowledgeEvent(
  event: ServerSentEvent,
  onProgress: (progress: KnowledgeIngestProgress) => void,
): KnowledgeIngestTerminal | undefined {
  if (event.event === "progress") {
    onProgress(event.data as KnowledgeIngestProgress);
    return undefined;
  }
  if (event.event === "completed" || event.event === "partial") return parseSuccessTerminal(event.event, event.data);
  if (event.event === "failed" || event.event === "cancelled") {
    return {
      status: event.event,
      code: typeof event.data.code === "string" ? event.data.code : undefined,
      message: typeof event.data.message === "string" ? event.data.message : event.event === "cancelled" ? "知识库操作已取消" : "知识库入库失败",
    };
  }
  return undefined;
}

/** 上传一个文档并完整消费 canonical SSE，直到取得服务端唯一终态。 */
export async function uploadWorkspaceKnowledge(
  workspaceId: string,
  file: File,
  onProgress: (progress: KnowledgeIngestProgress) => void,
  historyTarget?: KnowledgeIngestHistoryTarget,
): Promise<KnowledgeIngestTerminal> {
  const formData = new FormData();
  formData.append("file", file);
  if (historyTarget) {
    formData.append("sessionId", historyTarget.sessionId);
    formData.append("clientRecordId", historyTarget.clientRecordId);
  }
  const response = await fetch(getWorkspaceKnowledgeIngestUrl(workspaceId), { method: "POST", body: formData });
  return consumeKnowledgeResponse(response, onProgress);
}

/** Chat 独立管理与持久 rag Session 共用上传消费器，不提交 Workspace 或历史引用。 */
export async function uploadChatKnowledge(file: File, onProgress: (progress: KnowledgeIngestProgress) => void, sessionId?: string, signal?: AbortSignal): Promise<KnowledgeIngestTerminal> {
  const form = new FormData();
  form.set("file", file);
  const url = sessionId ? `/api/chat/sessions/${encodeURIComponent(sessionId)}/knowledge` : "/api/chat/knowledge";
  return consumeKnowledgeResponse(await fetch(url, { method: "POST", body: form, signal }), onProgress);
}

/** 两个入口共用原有 SSE 解析与唯一终态校验。 */
async function consumeKnowledgeResponse(response: Response, onProgress: (progress: KnowledgeIngestProgress) => void): Promise<KnowledgeIngestTerminal> {
  if (!response.ok) {
    const error = await readHttpError(response);
    return { status: "failed", ...error };
  }
  if (!response.body) return { status: "failed", message: "入库响应体为空" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: KnowledgeIngestTerminal | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseServerSentEvent(frame);
      if (!event) continue;
      terminal = reduceKnowledgeEvent(event, onProgress) ?? terminal;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseServerSentEvent(buffer);
    if (event) terminal = reduceKnowledgeEvent(event, onProgress) ?? terminal;
  }
  return terminal ?? { status: "failed", message: "入库响应未返回终态" };
}
