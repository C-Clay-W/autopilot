/**
 * Web capability 公共协议：定义供应商无关的搜索与网页读取边界。
 *
 * Core 只接收宿主在 Trust 后注入的能力；本协议不包含 Provider、凭据、
 * endpoint 或持久化配置，也不允许网页内容成为系统指令。
 */

/** 单条公开网络搜索来源；标题、URL 与摘要始终按不可信外部数据处理。 */
export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
}

/** 一次网络搜索的供应商无关结果。 */
export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
  truncated: boolean;
}

/** Search Adapter 可向 Core 提交的稳定安全错误码。 */
export type WebSearchCapabilityErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "WEB_SEARCH_PROVIDER_REJECTED"
  | "WEB_SEARCH_RATE_LIMITED";

/** 承载稳定错误码且不包含 Provider 原始正文的 Search capability 异常。 */
export class WebSearchCapabilityError extends Error {
  /** 创建只含安全消息的 Search capability 异常。 */
  constructor(
    public readonly code: WebSearchCapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebSearchCapabilityError";
  }
}

/** 按稳定错误形状识别不同 CJS/ESM 副本，只接受已声明的码，不信任外部消息。 */
export function isWebSearchCapabilityError(value: unknown): value is WebSearchCapabilityError {
  if (!(value instanceof Error) || value.name !== "WebSearchCapabilityError" || !("code" in value)) return false;
  return value.code === "CAPABILITY_UNAVAILABLE" || value.code === "WEB_SEARCH_PROVIDER_REJECTED" || value.code === "WEB_SEARCH_RATE_LIMITED";
}

/** 只接收最小 query 的网络搜索能力。 */
export interface WebSearchCapability {
  /** 将单个公开查询交给宿主 Search Adapter，并返回供应商无关的有界结果。 */
  search(input: { query: string; signal?: AbortSignal }): Promise<WebSearchResult>;
}

/** 一次受控网页读取的供应商无关结果。 */
export interface WebFetchResult {
  url: string;
  finalUrl: string;
  title?: string;
  content: string;
  contentType: string;
  truncated: boolean;
}

/** Fetch Adapter 可向 Core 提交的稳定安全错误码。 */
export type WebFetchCapabilityErrorCode =
  | "WEB_URL_BLOCKED"
  | "WEB_REDIRECT_REQUIRES_APPROVAL"
  | "WEB_RESPONSE_TOO_LARGE"
  | "WEB_CONTENT_TYPE_UNSUPPORTED";

/** 承载稳定错误码且不包含 URL 参数、响应正文或底层堆栈的 Fetch capability 异常。 */
export class WebFetchCapabilityError extends Error {
  /** 创建只含安全消息的 Fetch capability 异常。 */
  constructor(
    public readonly code: WebFetchCapabilityErrorCode,
    message: string,
    /** 仅在进程内交给 Core 重新审批；不得序列化到错误、事件或 checkpoint。 */
    public readonly redirect?: { url: string; remainingRedirects: number },
  ) {
    super(message);
    this.name = "WebFetchCapabilityError";
  }
}

/** 跨模块校验 Fetch 错误与重定向载荷；目标仍须重新经过工具 Schema、审批和 DNS 安全门。 */
export function isWebFetchCapabilityError(value: unknown): value is WebFetchCapabilityError {
  if (!(value instanceof Error) || value.name !== "WebFetchCapabilityError" || !("code" in value)) return false;
  if (value.code === "WEB_URL_BLOCKED" || value.code === "WEB_RESPONSE_TOO_LARGE" || value.code === "WEB_CONTENT_TYPE_UNSUPPORTED") return true;
  if (value.code !== "WEB_REDIRECT_REQUIRES_APPROVAL") return false;
  if (!("redirect" in value) || value.redirect === undefined) return true;
  const redirect = value.redirect;
  if (!redirect || typeof redirect !== "object" || !("url" in redirect) || typeof redirect.url !== "string") return false;
  return "remainingRedirects" in redirect && typeof redirect.remainingRedirects === "number" && Number.isInteger(redirect.remainingRedirects);
}

/** 只读取调用方明确 URL 的受控网页能力。 */
export interface WebFetchCapability {
  /** 读取已明确选择的 URL；具体网络安全硬门由宿主 Fetch Adapter 实现。 */
  fetch(input: { url: string; prompt?: string; signal?: AbortSignal; redirectsRemaining?: number }): Promise<WebFetchResult>;
}

/** Search 与 Fetch 可独立装配；缺少子能力时对应工具必须完全不可见。 */
export interface WebCapability {
  search?: WebSearchCapability;
  fetch?: WebFetchCapability;
}
