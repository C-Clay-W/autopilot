/**
 * Web Turn 失败的安全投影：用户只看到固定说明和不透明反馈 ID，诊断保留白名单类别、阶段、HTTP 状态与受限上游标识。
 * 原始异常、Provider 正文、凭据和路径不会进入该 DTO。
 */

import { getAgentProviderFailureMessage, sanitizeAgentProviderFailureReason, sanitizeAgentProviderFailureDetail, normalizeLegacyProviderFailureReason, type AgentProviderFailureReason } from "@autopilot-agent/core/failure";

export type WebTurnFailureCode = "MISSING_CREDENTIAL" | "PROVIDER_CONFIGURATION_INVALID" | "SANDBOX_UNAVAILABLE" | "TURN_EXECUTION_FAILED";

export type WebTurnDiagnosticCode =
  | "MISSING_CREDENTIAL" | "PROVIDER_CONFIGURATION_INVALID" | "CREDENTIAL_REF_INVALID" | "PROVIDER_PROTOCOL_REQUIRED" | "UNSUPPORTED_API_PROTOCOL"
  | "SANDBOX_UNAVAILABLE" | "SANDBOX_NOT_PROVISIONED" | "SANDBOX_RUNNER_FAILED"
  | "TURN_EXECUTION_FAILED" | "TOOL_CALL_REJECTED" | "TOKEN_BUDGET_EXCEEDED" | "TOOL_DENIED" | "CONTEXT_COMPACTION_FAILED" | "TURN_COMPLETION_REJECTED"
  | "IMAGE_VISION_UNAVAILABLE" | "IMAGE_VISION_FAILED" | "IMAGE_INPUT_UNAVAILABLE"
  | "CONTEXT_OVERFLOW" | "MODEL_OUTPUT_LIMIT" | "TOOL_CALL_TRUNCATED" | "TOOL_CALL_INVALID_JSON" | "STREAM_INCOMPLETE" | "EMPTY_RESPONSE"
  | "PROVIDER_CONNECTION" | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMIT" | "PROVIDER_SERVER_ERROR" | "PROVIDER_REQUEST_REJECTED" | "PROVIDER_UNAUTHORIZED" | "MODEL_NOT_FOUND"
  | "WEB_STREAM_FAILED";

export type WebTurnFailureStage =
  | "tool_preflight" | "runtime_budget" | "tool_execution" | "context_compaction" | "provider_sampling" | "provider_recovery" | "completion_policy" | "agent_loop"
  | "provider_setup" | "web_stream" | "legacy_history";

/** 失败卡片/历史共用的安全 DTO。 */
export interface WebTurnFailure {
  code: WebTurnFailureCode;
  message: string;
  feedbackId: string;
  diagnostic: {
    code: WebTurnDiagnosticCode;
    stage: WebTurnFailureStage;
    providerHttpStatus?: number;
    providerFailureReason?: AgentProviderFailureReason;
    providerFailureDetail?: string;
  };
}

/** 反馈 ID 为独立 UUID，不从 Session、Turn、异常或用户内容派生。 */
const FEEDBACK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Core 允许公开的沙箱可用性失败类别；其他错误码不参与沙箱分类。 */
const SANDBOX_FAILURE_CODES: ReadonlySet<string> = new Set(["SANDBOX_UNAVAILABLE", "SANDBOX_NOT_PROVISIONED", "SANDBOX_RUNNER_FAILED"]);

/** Web DTO 接受的诊断类别；不在列表中的错误码一律归为通用失败。 */
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "MISSING_CREDENTIAL", "PROVIDER_CONFIGURATION_INVALID", "CREDENTIAL_REF_INVALID", "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL",
  "SANDBOX_UNAVAILABLE", "SANDBOX_NOT_PROVISIONED", "SANDBOX_RUNNER_FAILED",
  "TURN_EXECUTION_FAILED", "TOOL_CALL_REJECTED", "TOKEN_BUDGET_EXCEEDED", "TOOL_DENIED", "CONTEXT_COMPACTION_FAILED", "TURN_COMPLETION_REJECTED",
  "IMAGE_VISION_UNAVAILABLE", "IMAGE_VISION_FAILED", "IMAGE_INPUT_UNAVAILABLE",
  "CONTEXT_OVERFLOW", "MODEL_OUTPUT_LIMIT", "TOOL_CALL_TRUNCATED", "TOOL_CALL_INVALID_JSON", "STREAM_INCOMPLETE", "EMPTY_RESPONSE",
  "PROVIDER_CONNECTION", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_REQUEST_REJECTED", "PROVIDER_UNAUTHORIZED", "MODEL_NOT_FOUND",
  "WEB_STREAM_FAILED",
]);

/** Web DTO 接受的失败阶段；任意字符串或异常名称不会进入诊断投影。 */
const FAILURE_STAGES: ReadonlySet<string> = new Set([
  "tool_preflight", "runtime_budget", "tool_execution", "context_compaction", "provider_sampling", "provider_recovery", "completion_policy", "agent_loop",
  "provider_setup", "web_stream", "legacy_history",
]);

/** 生成新的随机反馈 ID，供没有可信 Core 失败 ID 的 Host 出口使用。 */
function createFeedbackId(): string {
  return globalThis.crypto.randomUUID();
}

/** 只接受标准 UUID 形状的反馈 ID，避免持久 DTO 夹带错误原文或内部引用。 */
function isFeedbackId(value: unknown): value is string {
  return typeof value === "string" && FEEDBACK_ID_PATTERN.test(value);
}

/** 将失败类别和诊断阶段分别映射为固定用户提示与可控诊断摘要。 */
function getFailureMessage(code: WebTurnFailureCode, diagnosticCode: WebTurnDiagnosticCode, providerFailureReason?: unknown): string {
  const providerMessage = getAgentProviderFailureMessage(diagnosticCode, providerFailureReason);
  if (providerMessage) return providerMessage;
  if (code === "MISSING_CREDENTIAL") return "主模型 API Key 未配置或无法读取。请前往配置页保存主模型 Key，再重新发送消息。";
  if (code === "PROVIDER_CONFIGURATION_INVALID") return "主模型配置不可用，请检查模型配置后重新发送。";
  if (code === "SANDBOX_UNAVAILABLE") return "本机沙箱不可用，命令未执行，本次任务已停止（不会无沙箱直接执行）。请先修复宿主沙箱环境后重试；这不是模型配置问题。";
  if (diagnosticCode === "STREAM_INCOMPLETE") return "模型服务响应中断，请稍后重试；如果持续失败，请提供反馈 ID。";
  if (diagnosticCode === "EMPTY_RESPONSE") return "模型没有返回可用内容，请重试；如果持续失败，请提供反馈 ID。";
  if (diagnosticCode === "IMAGE_VISION_UNAVAILABLE") return "视觉分析工具不可用，无法处理图片。请检查视觉模型配置后重试。";
  if (diagnosticCode === "IMAGE_VISION_FAILED") return "图片视觉分析失败，无法继续处理。请检查视觉模型后重试。";
  if (diagnosticCode === "IMAGE_INPUT_UNAVAILABLE") return "会话图片不可用或已损坏，请重新选择图片后重试。";
  return "任务执行失败，请稍后重试；如果持续失败，请提供反馈 ID。";
}

/** 判断 SSE/持久消息是否为本模块生成的完整安全 DTO；不信任 Error 或任意 message。 */
export function isWebTurnFailure(value: unknown): value is WebTurnFailure {
  if (!value || typeof value !== "object" || value instanceof Error) return false;
  const candidate = value as { code?: unknown; message?: unknown; feedbackId?: unknown; diagnostic?: unknown };
  if (typeof candidate.code !== "string" || !["MISSING_CREDENTIAL", "PROVIDER_CONFIGURATION_INVALID", "SANDBOX_UNAVAILABLE", "TURN_EXECUTION_FAILED"].includes(candidate.code)) return false;
  if (!isFeedbackId(candidate.feedbackId) || typeof candidate.message !== "string" || !candidate.diagnostic || typeof candidate.diagnostic !== "object") return false;
  const diagnostic = candidate.diagnostic as { code?: unknown; stage?: unknown; providerHttpStatus?: unknown; providerFailureReason?: unknown; providerFailureDetail?: unknown; providerFailureProfile?: unknown };
  if (typeof diagnostic.code !== "string" || !DIAGNOSTIC_CODES.has(diagnostic.code) || typeof diagnostic.stage !== "string" || !FAILURE_STAGES.has(diagnostic.stage)) return false;
  if (diagnostic.providerHttpStatus !== undefined && (!Number.isInteger(diagnostic.providerHttpStatus) || Number(diagnostic.providerHttpStatus) < 400 || Number(diagnostic.providerHttpStatus) > 599)) return false;
  if ("providerFailureProfile" in diagnostic) return false;
  if (diagnostic.providerFailureDetail !== undefined && (!String(diagnostic.code).startsWith("PROVIDER_") || sanitizeAgentProviderFailureDetail(diagnostic.providerFailureDetail) !== diagnostic.providerFailureDetail)) return false;
  if (diagnostic.providerFailureReason !== undefined && sanitizeAgentProviderFailureReason(diagnostic.code, diagnostic.providerFailureReason) === undefined) return false;
  return candidate.message === getFailureMessage(candidate.code as WebTurnFailureCode, diagnostic.code as WebTurnDiagnosticCode, diagnostic.providerFailureReason);
}

/** 将 Core 或 Host 的可信结构化失败映射为用户提示和白名单诊断；不解析任意异常正文。 */
export function toWebTurnFailure(
  error: unknown,
  errorCode?: unknown,
  metadata: { feedbackId?: unknown; failureStage?: unknown; providerHttpStatus?: unknown; providerFailureReason?: unknown; providerFailureDetail?: unknown; diagnosticCode?: unknown } = {},
): WebTurnFailure {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; feedbackId?: unknown; failureStage?: unknown; providerHttpStatus?: unknown; providerFailureReason?: unknown; providerFailureDetail?: unknown } : undefined;
  const errorMessage = typeof error === "string" ? error : record?.message;
  const sourceCode = typeof errorCode === "string" ? errorCode : record?.code;
  const diagnosticCodeValue = typeof metadata.diagnosticCode === "string" ? metadata.diagnosticCode : sourceCode;
  const diagnosticCode = typeof diagnosticCodeValue === "string" && DIAGNOSTIC_CODES.has(diagnosticCodeValue)
    ? diagnosticCodeValue as WebTurnDiagnosticCode
    : "TURN_EXECUTION_FAILED";
  const code: WebTurnFailureCode = SANDBOX_FAILURE_CODES.has(String(sourceCode))
    ? "SANDBOX_UNAVAILABLE"
    : sourceCode === "MISSING_CREDENTIAL" || errorMessage === "指定的 Provider credentialRef 无法解析"
      ? "MISSING_CREDENTIAL"
      : ["PROVIDER_CONFIGURATION_INVALID", "CREDENTIAL_REF_INVALID", "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL"].includes(String(sourceCode))
        ? "PROVIDER_CONFIGURATION_INVALID"
        : "TURN_EXECUTION_FAILED";
  const stageValue = typeof metadata.failureStage === "string" ? metadata.failureStage : record?.failureStage;
  const stage = typeof stageValue === "string" && FAILURE_STAGES.has(stageValue)
    ? stageValue as WebTurnFailureStage
    : "web_stream";
  const idValue = metadata.feedbackId ?? record?.feedbackId;
  const feedbackId = isFeedbackId(idValue) ? idValue : createFeedbackId();
  const providerHttpStatusValue = metadata.providerHttpStatus ?? record?.providerHttpStatus;
  const providerHttpStatus = diagnosticCode.startsWith("PROVIDER_")
    && Number.isInteger(providerHttpStatusValue)
    && Number(providerHttpStatusValue) >= 400
    && Number(providerHttpStatusValue) <= 599
    ? Number(providerHttpStatusValue)
    : undefined;
  const providerFailureReason = sanitizeAgentProviderFailureReason(diagnosticCode, metadata.providerFailureReason ?? record?.providerFailureReason);
  const providerFailureDetail = diagnosticCode.startsWith("PROVIDER_") ? sanitizeAgentProviderFailureDetail(metadata.providerFailureDetail ?? record?.providerFailureDetail) : undefined;
  return {
    code,
    message: getFailureMessage(code, diagnosticCode, providerFailureReason),
    feedbackId,
    diagnostic: {
      code: diagnosticCode,
      stage,
      ...(providerHttpStatus !== undefined ? { providerHttpStatus } : {}),
      ...(providerFailureReason ? { providerFailureReason } : {}),
      ...(providerFailureDetail ? { providerFailureDetail } : {}),
    },
  };
}

/** 将旧版持久失败 DTO 规范为固定文案和稳定反馈 ID，不保留其历史 message 原文。 */
export function normalizePersistedWebTurnFailure(value: unknown, fallbackFeedbackId: string): WebTurnFailure | undefined {
  if (!value || typeof value !== "object" || value instanceof Error) return undefined;
  if (isWebTurnFailure(value)) return value;
  const candidate = value as { code?: unknown; feedbackId?: unknown; diagnostic?: unknown };
  const priorDiagnostic = candidate.diagnostic && typeof candidate.diagnostic === "object"
    ? candidate.diagnostic as { code?: unknown; stage?: unknown; providerHttpStatus?: unknown; providerFailureReason?: unknown; providerFailureDetail?: unknown; providerFailureProfile?: unknown }
    : undefined;
  const failureStage = typeof priorDiagnostic?.stage === "string" && FAILURE_STAGES.has(priorDiagnostic.stage)
    ? priorDiagnostic.stage
    : "legacy_history";
  return toWebTurnFailure(undefined, candidate.code, {
    feedbackId: isFeedbackId(candidate.feedbackId) ? candidate.feedbackId : fallbackFeedbackId,
    failureStage,
    diagnosticCode: priorDiagnostic?.code,
    providerHttpStatus: priorDiagnostic?.providerHttpStatus,
    providerFailureDetail: priorDiagnostic?.providerFailureDetail,
    providerFailureReason: priorDiagnostic?.providerFailureReason ?? normalizeLegacyProviderFailureReason(priorDiagnostic?.code, priorDiagnostic?.providerFailureProfile, priorDiagnostic?.providerHttpStatus),
  });
}

/** 兼容旧 History 中精确的凭据错误正文；用户正文不参与错误推断。 */
export function getLegacyTurnFailure(content: string, feedbackId?: string): WebTurnFailure | undefined {
  return content === "指定的 Provider credentialRef 无法解析"
    ? toWebTurnFailure(content, "MISSING_CREDENTIAL", { feedbackId, failureStage: "legacy_history" })
    : undefined;
}
