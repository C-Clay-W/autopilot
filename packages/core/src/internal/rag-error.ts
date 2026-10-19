/**
 * RAG 统一错误协议。
 *
 * 为 RAG 入库、资源、PDF/OCR 与检索操作提供独立于 Agent Runtime 的稳定错误码，
 * 并在公共边界收敛旧字符串错误与未知底层异常。
 */

/** RAG 公共边界允许暴露的稳定错误码。 */
export const RAG_ERROR_CODES = [
  "RAG_INVALID_INPUT",
  "RAG_UNSUPPORTED_DOCUMENT_TYPE",
  "RAG_OPERATION_CANCELLED",
  "RAG_INGEST_FAILED",
  "RAG_PARSE_FAILED",
  "RAG_SEARCH_FAILED",
  "RAG_VECTOR_SPACE_MISMATCH",
  "RAG_ANSWER_FAILED",
  "RAG_RESOURCE_NOT_FOUND",
  "RAG_RESOURCE_OPERATION_FAILED",
  "RAG_STORAGE_INVALID",
  "RAG_PDF_RUNTIME_UNAVAILABLE",
  "RAG_PDF_CORRUPTED",
  "RAG_PDF_ENCRYPTED",
  "RAG_PDF_ZERO_PAGES",
  "RAG_PDF_PAGE_RANGE_INVALID",
  "RAG_PDF_PAGE_EMPTY",
  "RAG_PDF_ALL_PAGES_FAILED",
  "RAG_OCR_UNAVAILABLE",
  "RAG_OCR_FAILED",
  "RAG_OCR_EMPTY",
] as const;

/** RAG 公共错误码类型。 */
export type RagErrorCode = (typeof RAG_ERROR_CODES)[number];

const RAG_ERROR_CODE_SET = new Set<string>(RAG_ERROR_CODES);

/** RAG 错误码对应的安全默认文案。 */
const RAG_ERROR_MESSAGES: Record<RagErrorCode, string> = {
  RAG_INVALID_INPUT: "RAG 输入不合法",
  RAG_UNSUPPORTED_DOCUMENT_TYPE: "RAG 文档类型不受支持",
  RAG_OPERATION_CANCELLED: "RAG 操作已取消",
  RAG_INGEST_FAILED: "RAG 入库失败",
  RAG_PARSE_FAILED: "RAG 文档解析失败",
  RAG_SEARCH_FAILED: "RAG 检索失败",
  RAG_VECTOR_SPACE_MISMATCH: "RAG 向量空间不匹配",
  RAG_ANSWER_FAILED: "RAG 问答失败",
  RAG_RESOURCE_NOT_FOUND: "RAG 资源不存在",
  RAG_RESOURCE_OPERATION_FAILED: "RAG 资源操作失败",
  RAG_STORAGE_INVALID: "RAG 存储状态不合法",
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

const LEGACY_RAG_ERROR_CODES: Readonly<Record<string, RagErrorCode>> = {
  INGEST_CANCELLED: "RAG_OPERATION_CANCELLED",
  PDF_PROCESSING_CANCELLED: "RAG_OPERATION_CANCELLED",
  RESOURCE_NOT_FOUND: "RAG_RESOURCE_NOT_FOUND",
  PYMUPDF_UNAVAILABLE: "RAG_PDF_RUNTIME_UNAVAILABLE",
  PDF_CORRUPTED: "RAG_PDF_CORRUPTED",
  PDF_ENCRYPTED: "RAG_PDF_ENCRYPTED",
  PDF_ZERO_PAGES: "RAG_PDF_ZERO_PAGES",
  PDF_PAGE_RANGE_INVALID: "RAG_PDF_PAGE_RANGE_INVALID",
  PDF_PAGE_EMPTY: "RAG_PDF_PAGE_EMPTY",
  PDF_ALL_PAGES_FAILED: "RAG_PDF_ALL_PAGES_FAILED",
  CLOUD_OCR_UNAVAILABLE: "RAG_OCR_UNAVAILABLE",
  CLOUD_OCR_FAILED: "RAG_OCR_FAILED",
  CLOUD_OCR_EMPTY: "RAG_OCR_EMPTY",
  PDF_STORAGE_NAME_INVALID: "RAG_STORAGE_INVALID",
  PDF_STORAGE_PATH_INVALID: "RAG_STORAGE_INVALID",
  SOURCE_STORAGE_NAME_INVALID: "RAG_STORAGE_INVALID",
};

/** 携带稳定 code 与可选底层 cause 的 RAG 统一错误。 */
export class RagError extends Error {
  constructor(
    public readonly code: RagErrorCode,
    message: string = RAG_ERROR_MESSAGES[code],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RagError";
  }
}

/** 跨 CJS/ESM 或开发态模块实例安全识别 RAG 错误码。 */
export function readRagErrorCode(error: unknown): RagErrorCode | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RAG_ERROR_CODE_SET.has(code) ? code as RagErrorCode : undefined;
}

/** 将旧字符串错误或未知底层异常收敛为 RAG 统一错误。 */
export function toRagError(error: unknown, fallbackCode: RagErrorCode): RagError {
  if (error instanceof RagError) return error;
  const structuredCode = readRagErrorCode(error);
  if (structuredCode) return new RagError(structuredCode, RAG_ERROR_MESSAGES[structuredCode], error);
  const legacyMessage = error instanceof Error ? error.message : "";
  const legacyCode = LEGACY_RAG_ERROR_CODES[legacyMessage];
  const code = error instanceof Error && error.name === "AbortError" ? "RAG_OPERATION_CANCELLED" : legacyCode ?? fallbackCode;
  return new RagError(code, RAG_ERROR_MESSAGES[code], error);
}
