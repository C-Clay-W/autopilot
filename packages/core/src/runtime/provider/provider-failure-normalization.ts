/** Provider/历史入口的有限归一化：恢复分类与受限协议标识分离，不输出自由正文。 */
import { sanitizeAgentProviderFailureDetail, sanitizeAgentProviderFailureReason, type AgentProviderFailureReason } from "./provider-failure-guidance";

/** HTTP 错误保留既有恢复分类；不新增按厂商命名的 Core 错误码。 */
export interface NormalizedProviderFailure {
  code: "PROVIDER_REQUEST_REJECTED" | "PROVIDER_RATE_LIMIT" | "PROVIDER_SERVER_ERROR" | "PROVIDER_TIMEOUT";
  reason?: AgentProviderFailureReason;
  detail?: string;
}

/** 只从标准 JSON 错误对象提取有限业务标识，不扫描 message 或保留正文。 */
function getBusinessError(body: unknown): { code?: unknown; type?: unknown } {
  let value = body;
  if (typeof value === "string") {
    if (value.length > 65536) return {};
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : root;
  return { code: error.code, type: error.type };
}

/** 只确认固定 HTTPS 端点，既有少量可靠特例不扩展为厂商全集。 */
function getOfficialHost(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string") return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return undefined;
    return url.hostname;
  } catch { return undefined; }
}

/** 安全标识独立于恢复分类；未知 429 不猜测可重试限流。 */
export function normalizeProviderHttpFailure(baseUrl: unknown, status: unknown, body?: unknown): NormalizedProviderFailure {
  const business = getBusinessError(body);
  const detail = sanitizeAgentProviderFailureDetail(typeof business.code === "string" || typeof business.code === "number" ? `code:${business.code}` : undefined)
    ?? sanitizeAgentProviderFailureDetail(typeof business.type === "string" ? `type:${business.type}` : undefined);
  const classification = classifyProviderFailure(baseUrl, status, business);
  return { ...classification, ...(detail ? { detail } : {}) };
}

/** 保留既有已确认事实，除此之外仅以 HTTP 分类，不把标识用于通用重试。 */
function classifyProviderFailure(baseUrl: unknown, status: unknown, business: { code?: unknown; type?: unknown }): NormalizedProviderFailure {
  const host = getOfficialHost(baseUrl);
  if (host === "api.deepseek.com") {
    const reason = deepSeekReason(status);
    if (reason) return failureForReason(reason);
  }
  if (host === "api.z.ai" && status === 429) {
    if (business.code === "1113" || business.code === 1113) return failureForReason("billing_insufficient");
    if (business.code === "1302" || business.code === 1302) return failureForReason("rate_limited");
    if (business.code === "1305" || business.code === 1305) return failureForReason("service_unavailable");
  }
  if ((host === "api.moonshot.cn" || host === "api.moonshot.ai") && (status === 403 || status === 429)) {
    if (business.type === "exceeded_current_quota_error") return failureForReason("billing_insufficient");
    if (status === 429 && business.type === "rate_limit_reached_error") return failureForReason("rate_limited");
    if (status === 429 && business.type === "engine_overloaded_error") return failureForReason("service_unavailable");
  }
  if (["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(host ?? "")) {
    if (status === 400 && business.code === "Arrearage") return failureForReason("billing_insufficient");
    if (status === 429 && business.code === "BudgetLimitExceeded") return failureForReason("quota_exhausted");
    if (status === 429 && ["Throttling.RateQuota", "Throttling.Concurrency", "Throttling.AllocationQuota"].includes(String(business.code))) return failureForReason("rate_limited");
  }
  if (status === 408) return { code: "PROVIDER_TIMEOUT" };
  if (typeof status === "number" && status >= 500 && status <= 599) return { code: "PROVIDER_SERVER_ERROR" };
  return { code: "PROVIDER_REQUEST_REJECTED" };
}

/** 将中立原因归入既有恢复分类，余额/额度不会进入限流重试。 */
function failureForReason(reason: AgentProviderFailureReason): NormalizedProviderFailure {
  return { code: reason === "rate_limited" ? "PROVIDER_RATE_LIMIT" : reason === "service_unavailable" ? "PROVIDER_SERVER_ERROR" : "PROVIDER_REQUEST_REJECTED", reason };
}

/**
 * 解析标准 Retry-After 响应头（对齐 DSH 的 header 解析口径）：
 * 支持非负整数/小数秒或 HTTP-date；非法或非正值返回 undefined，由 Kernel 回退到指数退避，不做厂商猜测。
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
  }
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined;
}

/** 仅在入口或旧历史迁移时解释官方状态，厂商标记不进入新公开事件。 */
function deepSeekReason(status: unknown): AgentProviderFailureReason | undefined {
  switch (status) {
    case 400: case 422: return "invalid_request";
    case 401: return "authentication_failed";
    case 402: return "billing_insufficient";
    case 429: return "rate_limited";
    case 500: case 503: return "service_unavailable";
    default: return undefined;
  }
}

/** 兼容旧持久 profile；只迁移匹配旧分类的已知事实，不恢复任意旧文案。 */
export function normalizeLegacyProviderFailureReason(errorCode: unknown, profile: unknown, status: unknown): AgentProviderFailureReason | undefined {
  return profile === "deepseek_official" ? sanitizeAgentProviderFailureReason(errorCode, deepSeekReason(status)) : undefined;
}
