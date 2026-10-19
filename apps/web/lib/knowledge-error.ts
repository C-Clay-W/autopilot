/**
 * Web 知识库错误边界。
 *
 * 单独维护 Web 上传校验错误，并把 Core RagError 白名单映射为安全 HTTP/SSE DTO；
 * 未识别异常继续交给 Workspace 边界处理，避免误报或泄漏底层信息。
 */
import type { RagErrorCode } from "@autopilot-agent/core";

/** Web 上传阶段的稳定错误码。 */
export type KnowledgeUploadErrorCode =
  | "UPLOAD_NAME_INVALID"
  | "UPLOAD_SIZE_INVALID"
  | "UPLOAD_TYPE_UNSUPPORTED"
  | "UPLOAD_MIME_INVALID"
  | "UPLOAD_SESSION_INVALID";

/** Web 上传校验错误；不承载文件路径或原始正文。 */
export class KnowledgeUploadError extends Error {
  constructor(public readonly code: KnowledgeUploadErrorCode) {
    super(code);
    this.name = "KnowledgeUploadError";
  }
}

const UPLOAD_ERROR_MESSAGES: Record<KnowledgeUploadErrorCode, string> = {
  UPLOAD_NAME_INVALID: "文件名不合法",
  UPLOAD_SIZE_INVALID: "文件大小不符合限制",
  UPLOAD_TYPE_UNSUPPORTED: "文件类型不受支持",
  UPLOAD_MIME_INVALID: "文件内容与类型不匹配",
  UPLOAD_SESSION_INVALID: "入库会话记录标识无效",
};

const RAG_ERROR_MESSAGES: Record<RagErrorCode, string> = {
  RAG_INVALID_INPUT: "知识库输入不合法",
  RAG_UNSUPPORTED_DOCUMENT_TYPE: "文件类型不受支持",
  RAG_OPERATION_CANCELLED: "知识库操作已取消",
  RAG_INGEST_FAILED: "知识库入库失败",
  RAG_PARSE_FAILED: "文件解析失败",
  RAG_SEARCH_FAILED: "知识库检索失败",
  RAG_VECTOR_SPACE_MISMATCH: "知识索引与当前向量配置不匹配",
  RAG_ANSWER_FAILED: "知识库问答失败",
  RAG_RESOURCE_NOT_FOUND: "资源不存在",
  RAG_RESOURCE_OPERATION_FAILED: "知识资源操作失败",
  RAG_STORAGE_INVALID: "知识库存储状态异常",
  RAG_PDF_RUNTIME_UNAVAILABLE: "PDF 解析运行时不可用",
  RAG_PDF_CORRUPTED: "PDF 文件已损坏",
  RAG_PDF_ENCRYPTED: "PDF 文件已加密",
  RAG_PDF_ZERO_PAGES: "PDF 不包含可处理页面",
  RAG_PDF_PAGE_RANGE_INVALID: "PDF 页码范围不合法",
  RAG_PDF_PAGE_EMPTY: "PDF 页面没有可处理内容",
  RAG_PDF_ALL_PAGES_FAILED: "PDF 所有页面均处理失败",
  RAG_OCR_UNAVAILABLE: "OCR 运行时不可用",
  RAG_OCR_FAILED: "OCR 处理失败",
  RAG_OCR_EMPTY: "OCR 未返回有效文本",
};

/** 跨开发态模块实例读取 Web 上传错误码。 */
export function readKnowledgeUploadErrorCode(error: unknown): KnowledgeUploadErrorCode | undefined {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(UPLOAD_ERROR_MESSAGES, code) ? code as KnowledgeUploadErrorCode : undefined;
}

/** 跨 Core CJS/ESM 实例读取 Web 允许公开的 RAG 错误码。 */
function readCoreRagErrorCode(error: unknown): RagErrorCode | undefined {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(RAG_ERROR_MESSAGES, code) ? code as RagErrorCode : undefined;
}

/** 将已识别的上传或 Core RAG 错误转换为安全 DTO。 */
export function toSafeKnowledgeError(error: unknown): { code: string; message: string } {
  const uploadCode = readKnowledgeUploadErrorCode(error);
  if (uploadCode) return { code: uploadCode, message: UPLOAD_ERROR_MESSAGES[uploadCode] };
  const ragCode = readCoreRagErrorCode(error);
  if (ragCode) return { code: ragCode, message: RAG_ERROR_MESSAGES[ragCode] };
  return { code: "KNOWLEDGE_OPERATION_FAILED", message: "知识资源操作失败" };
}

/** 仅处理已识别的知识库错误；未知异常返回 undefined 交给 Workspace 边界。 */
export function toKnowledgeErrorResponse(error: unknown): Response | undefined {
  const uploadCode = readKnowledgeUploadErrorCode(error);
  const ragCode = readCoreRagErrorCode(error);
  if (!uploadCode && !ragCode) return undefined;
  const safe = toSafeKnowledgeError(error);
  const status = uploadCode === "UPLOAD_SIZE_INVALID" ? 413
    : uploadCode || ragCode === "RAG_INVALID_INPUT" || ragCode === "RAG_UNSUPPORTED_DOCUMENT_TYPE" || ragCode === "RAG_PDF_PAGE_RANGE_INVALID" ? 400
      : ragCode === "RAG_RESOURCE_NOT_FOUND" ? 404
        : 500;
  return Response.json({ error: safe.message, code: safe.code }, { status });
}
