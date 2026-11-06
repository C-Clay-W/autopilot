/** Core Provider 失败的中立原因、固定提示与有界协议标识校验，不读取上游自由文本。 */

/** 可公开的有限原因；上游细节只可归一成这些语义，不能直接作为提示。 */
export type AgentProviderFailureReason = "invalid_request" | "authentication_failed" | "billing_insufficient" | "quota_exhausted" | "rate_limited" | "service_unavailable";

/** 按既有恢复分类验证中立原因，防止互相矛盾的诊断进入公开事件。 */
export function sanitizeAgentProviderFailureReason(errorCode: unknown, reason: unknown): AgentProviderFailureReason | undefined {
  if (typeof reason !== "string") return undefined;
  if (errorCode === "PROVIDER_REQUEST_REJECTED" && ["invalid_request", "authentication_failed", "billing_insufficient", "quota_exhausted"].includes(reason)) return reason as AgentProviderFailureReason;
  if (errorCode === "PROVIDER_RATE_LIMIT" && reason === "rate_limited") return reason;
  if (errorCode === "PROVIDER_SERVER_ERROR" && reason === "service_unavailable") return reason;
  return undefined;
}

/** 将少量稳定 Provider 分类映射为固定安全原因和处理建议。 */
export function getAgentProviderFailureMessage(errorCode: unknown, reason?: unknown): string | undefined {
  switch (sanitizeAgentProviderFailureReason(errorCode, reason)) {
    case "invalid_request": return "模型服务请求格式或参数无效。请检查请求内容和参数后重试。";
    case "authentication_failed": return "模型服务凭据认证失败。请检查当前 Key 是否正确且仍有效。";
    case "billing_insufficient": return "模型服务账户余额不足或计费不可用。请检查账户余额和计费状态后重试。";
    case "quota_exhausted": return "模型服务可用额度或预算已耗尽。请检查套餐、预算或额度重置时间后重试。";
    case "rate_limited": return "模型服务请求速率或并发达到上限。请降低频率或并发，稍后重试。";
    case "service_unavailable": return "模型服务暂时不可用。请稍后重试；如果持续失败，请提供反馈 ID。";
  }
  switch (errorCode) {
    case "PROVIDER_CONNECTION": return "暂时无法连接模型服务，请检查网络后重试；如果持续失败，请提供反馈 ID。";
    case "PROVIDER_TIMEOUT": return "等待模型服务响应超时，请稍后重试；如果持续失败，请提供反馈 ID。";
    case "PROVIDER_RATE_LIMIT": return "模型服务暂时无法完成本次请求，请稍后重试；如果持续失败，请提供反馈 ID。";
    case "PROVIDER_SERVER_ERROR": return "模型服务暂时不可用，请稍后重试；如果持续失败，请提供反馈 ID。";
    case "PROVIDER_REQUEST_REJECTED": return "模型服务未接受本次请求。请检查请求设置或稍后重试；如果持续失败，请提供反馈 ID。";
    case "PROVIDER_UNAUTHORIZED": return "模型服务认证失败，请检查当前凭据设置。";
    default: return undefined;
  }
}

/** 校验有界协议标识；格式过滤不能保证未知上游不会把敏感信息放入标识。 */
export function sanitizeAgentProviderFailureDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(code|type):[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value)) return undefined;
  const identifier = value.slice(value.indexOf(":") + 1);
  if (/(?:^|[_.-])(?:sk|key|token|secret|password|bearer|credential)(?:[_.-]|$)/i.test(identifier) || /^(?:sk|pk|api|token|secret|password|bearer|credential|key)(?:[-_.]|\d|$)/i.test(identifier)) return undefined;
  return value;
}
