/** Node 存储与 Chat 边界错误：封闭错误码、固定安全消息，复用 Core 身份错误协议。 */
import { AgentRuntimeError, type AgentErrorCode } from "@autopilot-agent/core";

const stateCodes = [
  "STATE_SESSION_CORRUPTED", "STATE_STORAGE_UNAVAILABLE", "STATE_STORAGE_UNSAFE_PATH",
  "STATE_SCHEMA_UNSAFE_PATH", "STATE_SCHEMA_BUSY", "STATE_SCHEMA_RECOVERY_REQUIRED",
  "STATE_SCHEMA_MANIFEST_CORRUPTED", "STATE_SCHEMA_VERSION_INVALID", "STATE_SCHEMA_VERSION_UNSUPPORTED",
  "STATE_SCHEMA_MIGRATION_MISSING", "STATE_SCHEMA_MIGRATION_FAILED",
] as const;
const chatCodes = [
  "CHAT_STATE_ROOT_INVALID", "CHAT_ATTACHMENT_UNAVAILABLE", "CHAT_ATTACHMENT_CANCELLED",
  "CHAT_ATTACHMENT_PARSER_UNAVAILABLE", "CHAT_ATTACHMENT_CLEANUP_FAILED", "CHAT_SESSION_DELETING",
  "CHAT_UPLOAD_MODE_MISMATCH", "CHAT_ATTACHMENT_STORE_REQUIRED", "CHAT_KNOWLEDGE_UNAVAILABLE",
] as const;
const runtimeMessages = {
  SESSION_MODE_MISMATCH: "Session 产品模式与归属不匹配",
  CHAT_RETRIEVAL_MODE_LOCKED: "Chat 检索模式已冻结",
  WORKSPACE_REQUIRED: "Work 需要有效工作区归属",
} as const;

export type NodeStateErrorCode = typeof stateCodes[number];
export type NodeChatErrorCode = typeof chatCodes[number];
type NodeIdentityErrorCode = keyof typeof runtimeMessages;

/** 仅供受信宿主恢复使用；路径不进入错误消息、cause 或 JSON 序列化。 */
export interface NodeStateRecoveryDiagnostic {
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
  reasonCode: NodeStateErrorCode | NodeChatErrorCode | AgentErrorCode;
}

/** 存储错误的安全字段与恢复诊断分离，适用于 Work 和 Chat。 */
export class NodeStateError extends Error {
  #recovery?: NodeStateRecoveryDiagnostic;
  /** 只使用固定错误码作为消息，恢复信息保存为不可枚举的私有字段。 */
  constructor(public readonly code: NodeStateErrorCode, recovery?: NodeStateRecoveryDiagnostic) {
    super(code);
    this.name = "NodeStateError";
    this.#recovery = recovery ? { ...recovery } : undefined;
  }
  /** 受信宿主显式取得恢复信息副本，不得将它投影到 HTTP 或模型事件。 */
  getRecoveryDiagnostic(): NodeStateRecoveryDiagnostic | undefined { return this.#recovery ? { ...this.#recovery } : undefined; }
}

/** Chat 附件与装配错误只包含稳定码，不携带输入、路径或 Provider 正文。 */
export class NodeChatError extends Error {
  /** 使用封闭错误码创建安全异常。 */
  constructor(public readonly code: NodeChatErrorCode) { super(code); this.name = "NodeChatError"; }
}

/** 复用 Core 错误类型并统一身份拒绝文案，避免各 Store 对同一码给出不同形状。 */
export function createNodeIdentityError(code: NodeIdentityErrorCode): AgentRuntimeError { return new AgentRuntimeError(code, runtimeMessages[code]); }

/** 按精确类型名称与错误码识别跨 CJS/ESM 异常；始终重建安全消息，不透传 message/cause。 */
export function toNodeBoundaryError(error: unknown, fallback: NodeStateErrorCode | NodeChatErrorCode): NodeStateError | NodeChatError | AgentRuntimeError {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    if (error.name === "AgentRuntimeError" && Object.prototype.hasOwnProperty.call(runtimeMessages, error.code)) return createNodeIdentityError(error.code as NodeIdentityErrorCode);
    if (error.name === "NodeStateError" && (stateCodes as readonly string[]).includes(error.code)) {
      return new NodeStateError(error.code as NodeStateErrorCode, error instanceof NodeStateError ? error.getRecoveryDiagnostic() : undefined);
    }
    if (error.name === "NodeChatError" && (chatCodes as readonly string[]).includes(error.code)) return new NodeChatError(error.code as NodeChatErrorCode);
  }
  return (stateCodes as readonly string[]).includes(fallback) ? new NodeStateError(fallback as NodeStateErrorCode) : new NodeChatError(fallback as NodeChatErrorCode);
}
