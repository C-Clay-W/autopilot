/** CLI 内部错误的安全分类：只返回封闭类别与稳定错误码，不读取异常正文。 */

import { NodeChatError, NodeStateError } from "@autopilot-agent/adapters";
import { AgentRuntimeError, WorkspaceTrustError } from "@autopilot-agent/core";

export type CliErrorCategory = "config_directory" | "workspace_trust" | "agent_runtime" | "node_state" | "node_chat" | "unknown";

export interface CliErrorClassification {
  category: CliErrorCategory;
  code: string;
}

const agentErrorCodes = new Set<string>([
  "SESSION_MODE_MISMATCH", "CHAT_RETRIEVAL_MODE_LOCKED", "CHAT_TOOL_FORBIDDEN", "CHAT_RAG_EVIDENCE_INSUFFICIENT",
  "WORKSPACE_REQUIRED", "WORK_HISTORY_READ_ONLY", "SESSION_NOT_FOUND", "SESSION_TITLE_INVALID", "TURN_NOT_FOUND",
  "TURN_NOT_RESUMABLE", "TURN_ALREADY_RUNNING", "CHECKPOINT_NOT_FOUND", "PROJECT_NOT_FOUND", "NOT_IMPLEMENTED",
  "RUNTIME_ERROR", "INVALID_RUN_CONFIG", "PROVIDER_UNAUTHORIZED", "MODEL_NOT_FOUND", "MODEL_NOT_SUPPORTED",
  "REASONING_EFFORT_NOT_SUPPORTED", "TURN_FROZEN_MISMATCH", "CREDENTIAL_REF_INVALID", "MISSING_CREDENTIAL",
  "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL", "INVALID_PROTOCOL_PROFILE", "DUPLICATE_API_PROTOCOL_ADAPTER",
  "CANONICAL_MESSAGE_INVALID", "APPROVAL_NOT_FOUND", "APPROVAL_MISMATCH", "APPROVAL_ALREADY_SUBMITTED",
  "QUESTION_NOT_FOUND", "QUESTION_ALREADY_ANSWERED", "QUESTION_ANSWER_INVALID", "QUESTION_TURN_STATE_INVALID",
  "JOB_NOT_FOUND", "JOB_INPUT_INVALID", "JOB_CURSOR_INVALID", "JOB_OWNER_UNAVAILABLE", "JOB_OWNER_UNKNOWN",
  "JOB_STATE_CONFLICT", "JOB_STOP_TIMEOUT", "JOB_STOP_FAILED", "JOB_STORAGE_FAILED", "JOB_SPAWN_FAILED",
  "JOB_STORE_CAPABILITY_UNSUPPORTED", "SESSION_HAS_ACTIVE_JOBS", "INTERACTIVE_TOOL_CONFLICT", "INBOX_INPUT_NOT_FOUND",
  "INVALID_INPUT",
]);

const nodeStateErrorCodes = new Set<string>([
  "STATE_SESSION_CORRUPTED", "STATE_STORAGE_UNAVAILABLE", "STATE_STORAGE_UNSAFE_PATH", "STATE_SCHEMA_UNSAFE_PATH",
  "STATE_SCHEMA_BUSY", "STATE_SCHEMA_RECOVERY_REQUIRED", "STATE_SCHEMA_MANIFEST_CORRUPTED", "STATE_SCHEMA_VERSION_INVALID",
  "STATE_SCHEMA_VERSION_UNSUPPORTED", "STATE_SCHEMA_MIGRATION_MISSING", "STATE_SCHEMA_MIGRATION_FAILED",
]);

const nodeChatErrorCodes = new Set<string>([
  "CHAT_STATE_ROOT_INVALID", "CHAT_ATTACHMENT_UNAVAILABLE", "CHAT_ATTACHMENT_CANCELLED", "CHAT_ATTACHMENT_PARSER_UNAVAILABLE",
  "CHAT_ATTACHMENT_CLEANUP_FAILED", "CHAT_SESSION_DELETING", "CHAT_UPLOAD_MODE_MISMATCH", "CHAT_ATTACHMENT_STORE_REQUIRED",
  "CHAT_KNOWLEDGE_UNAVAILABLE",
]);

const configDirectoryErrorCodes = new Set<string>([
  "AUTOPILOT_HOME_UNRESOLVED", "AUTOPILOT_CONFIG_ROOT_NOT_DIRECTORY", "AUTOPILOT_CONFIG_ROOT_UNSAFE_LINK",
  "AUTOPILOT_CONFIG_ROOT_UNAVAILABLE",
]);

/** 只从稳定异常类型与显式码白名单分类；未知或被篡改的码会回退到通用标记。 */
export function classifyCliError(error: unknown): CliErrorClassification {
  try {
    if (hasStableConfigDirectoryErrorCode(error)) return { category: "config_directory", code: error.code };
    if (error instanceof WorkspaceTrustError) return { category: "workspace_trust", code: "WORKSPACE_TRUST_REQUIRED" };
    if (error instanceof AgentRuntimeError) {
      const code = agentErrorCodes.has(error.code) ? error.code : "AGENT_RUNTIME_ERROR";
      return { category: "agent_runtime", code };
    }
    if (error instanceof NodeStateError) {
      const code = nodeStateErrorCodes.has(error.code) ? error.code : "NODE_STATE_ERROR";
      return { category: "node_state", code };
    }
    if (error instanceof NodeChatError) {
      const code = nodeChatErrorCodes.has(error.code) ? error.code : "NODE_CHAT_ERROR";
      return { category: "node_chat", code };
    }
  } catch {
    return { category: "unknown", code: "CLI_RUNTIME_ERROR" };
  }
  return { category: "unknown", code: "CLI_RUNTIME_ERROR" };
}

/** 只接受 CLI 已公开的配置目录错误码，不回显任意对象上的 code 字符串。 */
function hasStableConfigDirectoryErrorCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    && configDirectoryErrorCodes.has(error.code);
}
