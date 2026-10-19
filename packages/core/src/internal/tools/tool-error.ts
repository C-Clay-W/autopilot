/**
 * P4 稳定错误码：将底层异常转换为可给 Agent 与宿主稳定消费的安全错误。
 */
import type { ToolError } from "./types";
import { DATABASE_ERROR_CODES } from "../database-error";

export const TOOL_ERROR_CODES = {
  CHAT_TOOL_FORBIDDEN: "CHAT_TOOL_FORBIDDEN",
  CHAT_ATTACHMENT_UNAVAILABLE: "CHAT_ATTACHMENT_UNAVAILABLE",
  CHAT_RAG_EVIDENCE_INSUFFICIENT: "CHAT_RAG_EVIDENCE_INSUFFICIENT",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  INVALID_INPUT: "INVALID_INPUT",
  WORKSPACE_NOT_CONFIGURED: "WORKSPACE_NOT_CONFIGURED",
  PATH_OUTSIDE_WORKSPACE: "PATH_OUTSIDE_WORKSPACE",
  PATH_TRAVERSAL: "PATH_TRAVERSAL",
  PATH_UNSAFE_LINK: "PATH_UNSAFE_LINK",
  BINARY_FILE: "BINARY_FILE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  FILE_NOT_READ: "FILE_NOT_READ",
  FILE_STALE: "FILE_STALE",
  FS_SANDBOX_DENIED: "FS_SANDBOX_DENIED",
  COMMAND_FORBIDDEN: "COMMAND_FORBIDDEN",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_MISMATCH: "APPROVAL_MISMATCH",
  EXECUTION_TIMEOUT: "EXECUTION_TIMEOUT",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  OUTPUT_TRUNCATED: "OUTPUT_TRUNCATED",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  WEB_URL_BLOCKED: "WEB_URL_BLOCKED",
  WEB_REDIRECT_REQUIRES_APPROVAL: "WEB_REDIRECT_REQUIRES_APPROVAL",
  WEB_RESPONSE_TOO_LARGE: "WEB_RESPONSE_TOO_LARGE",
  WEB_CONTENT_TYPE_UNSUPPORTED: "WEB_CONTENT_TYPE_UNSUPPORTED",
  ...DATABASE_ERROR_CODES,
} as const;

/** 构造带稳定错误码的异常，避免向模型泄露宿主错误堆栈。 */
export function createToolError(code: string, message: string): Error & { toolError: ToolError } {
  const error = new Error(message) as Error & { toolError: ToolError };
  error.toolError = { code, message };
  return error;
}

/** 将任意异常收敛为安全错误对象，优先保留已知工具错误。 */
export function toToolError(error: unknown): ToolError {
  if (error && typeof error === "object" && "toolError" in error) {
    return (error as { toolError: ToolError }).toolError;
  }
  return {
    code: TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED,
    message: error instanceof Error ? error.message : "工具执行失败",
  };
}
