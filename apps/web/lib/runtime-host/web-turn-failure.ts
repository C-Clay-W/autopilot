/**
 * Web 任务失败的安全 DTO：固定文案可在实时流与历史中重用，不回显底层异常或凭据。
 * 失败类别只由 Core 终态带出的结构化错误码映射，不解析任意错误正文。
 */

/** Web 任务失败的安全 DTO。 */
export interface WebTurnFailure {
  code: "MISSING_CREDENTIAL" | "PROVIDER_CONFIGURATION_INVALID" | "SANDBOX_UNAVAILABLE" | "TURN_EXECUTION_FAILED";
  message: string;
}

/** Core 允许公开的沙箱可用性失败类别；其他错误码不参与分类。 */
const SANDBOX_FAILURE_CODES: ReadonlySet<string> = new Set(["SANDBOX_UNAVAILABLE", "SANDBOX_NOT_PROVISIONED", "SANDBOX_RUNNER_FAILED"]);

/** 本模块已构建的失败类别；SSE 与持久消息会把它再次传回映射函数。 */
const WEB_TURN_FAILURE_CODES: ReadonlySet<string> = new Set(["MISSING_CREDENTIAL", "PROVIDER_CONFIGURATION_INVALID", "SANDBOX_UNAVAILABLE", "TURN_EXECUTION_FAILED"]);

/**
 * 判断 SSE/持久消息带回来的值是否已是本模块输出的失败 DTO；Error 实例即使带同名 code
 * 也不能当作 DTO，否则会把底层异常正文原样透出。
 */
export function isWebTurnFailure(value: unknown): value is WebTurnFailure {
  if (!value || typeof value !== "object" || value instanceof Error) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && WEB_TURN_FAILURE_CODES.has(candidate.code) && typeof candidate.message === "string";
}

/**
 * 将可信错误码或旧版精确文案映射为用户能采取行动的提示。
 * errorCode 来自 Core 终态事件的白名单类别；沙箱失败是环境阻塞，不引导到模型配置。
 */
export function toWebTurnFailure(error: unknown, errorCode?: unknown): WebTurnFailure {
  if (typeof errorCode === "string" && SANDBOX_FAILURE_CODES.has(errorCode)) {
    return { code: "SANDBOX_UNAVAILABLE", message: "本机沙箱不可用，命令未执行，本次任务已停止（不会无沙箱直接执行）。请先修复宿主沙箱环境后重试；这不是模型配置问题。" };
  }
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const message = typeof error === "string" ? error : record?.message;
  if (record?.code === "MISSING_CREDENTIAL" || message === "指定的 Provider credentialRef 无法解析") {
    return { code: "MISSING_CREDENTIAL", message: "主模型 API Key 未配置或无法读取。请前往配置页保存主模型 Key，再重新发送消息。" };
  }
  if (["CREDENTIAL_REF_INVALID", "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL"].includes(String(record?.code))) {
    return { code: "PROVIDER_CONFIGURATION_INVALID", message: "主模型配置不可用，请检查模型配置后重新发送。" };
  }
  return { code: "TURN_EXECUTION_FAILED", message: "任务执行失败，请稍后重新发送；如果持续失败，请检查模型输出或运行环境。" };
}

/** 兼容早期只有错误正文的持久消息；只识别精确旧文案，不推测任意回答内容。 */
export function getLegacyTurnFailure(content: string): WebTurnFailure | undefined {
  return content === "指定的 Provider credentialRef 无法解析" ? toWebTurnFailure(content) : undefined;
}
