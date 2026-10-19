/** Web 任务失败的安全 DTO：固定文案可在实时流与历史中重用，不回显底层异常或凭据。 */
export interface WebTurnFailure {
  code: "MISSING_CREDENTIAL" | "PROVIDER_CONFIGURATION_INVALID" | "TURN_EXECUTION_FAILED";
  message: string;
}

/** 将可信错误码或旧版精确文案映射为用户能采取行动的提示。 */
export function toWebTurnFailure(error: unknown): WebTurnFailure {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const message = typeof error === "string" ? error : record?.message;
  if (record?.code === "MISSING_CREDENTIAL" || message === "指定的 Provider credentialRef 无法解析") {
    return { code: "MISSING_CREDENTIAL", message: "主模型 API Key 未配置或无法读取。请前往配置页保存主模型 Key，再重新发送消息。" };
  }
  if (["CREDENTIAL_REF_INVALID", "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL"].includes(String(record?.code))) {
    return { code: "PROVIDER_CONFIGURATION_INVALID", message: "主模型配置不可用，请检查模型配置后重新发送。" };
  }
  return { code: "TURN_EXECUTION_FAILED", message: "任务执行失败，请稍后重新发送；如果持续失败，请检查模型配置。" };
}

/** 兼容早期只有错误正文的持久消息；只识别精确旧文案，不推测任意回答内容。 */
export function getLegacyTurnFailure(content: string): WebTurnFailure | undefined {
  return content === "指定的 Provider credentialRef 无法解析" ? toWebTurnFailure(content) : undefined;
}
