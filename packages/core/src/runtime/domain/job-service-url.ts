/**
 * job-service-url.ts — 后台 Job 声明的本机服务地址规范化（Talk-Plan0908 R1/R2 修复）。
 *
 * 只接受 loopback 的 http/https origin（可带默认端口），拒绝 userinfo、query、fragment 与非根路径；
 * 规范化结果用于 Job 记录、JobView 与预览归属比对，不含任何凭据或内部映射。
 */

/** 判定主机名是否为 loopback；只认本机回环，不接受私网其他地址。 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 取 URL 的有效端口；WHATWG 会省略默认端口。 */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/** 已规范化服务地址的结构化视图。 */
interface ParsedServiceOrigin {
  protocol: string;
  host: string;
  port: string;
  loopback: boolean;
}

/** 解析并校验声明地址；非法或不安全时返回 undefined。 */
function parseServiceOrigin(value: string): ParsedServiceOrigin | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (!isLoopbackHostname(url.hostname)) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return { protocol: url.protocol, host, port: effectivePort(url), loopback: true };
}

/**
 * 规范化 Job 声明的服务地址：返回固定 origin（含实际端口），非法或不安全时返回 undefined。
 * 只允许根路径，避免通过路径影响归属比对；IPv6 回环统一写成 [::1]。
 */
export function normalizeJobServiceUrl(value: string): string | undefined {
  const parsed = parseServiceOrigin(value);
  if (!parsed) return undefined;
  const authority = parsed.host === "::1" ? `[::1]:${parsed.port}` : `${parsed.host}:${parsed.port}`;
  return `${parsed.protocol}//${authority}`;
}

/** 取声明地址的端口；规范化输入缺失或非法时返回 undefined。 */
export function jobServicePort(serviceUrl: string): number | undefined {
  const parsed = parseServiceOrigin(serviceUrl);
  if (!parsed) return undefined;
  const port = Number(parsed.port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * 两个地址是否为同一 loopback origin：协议与端口严格相等，
 * 回环别名（localhost/127.0.0.1/[::1]）互相等价，其余主机严格相等。
 */
export function sameServiceOrigin(left: string, right: string): boolean {
  const a = parseServiceOrigin(left);
  const b = parseServiceOrigin(right);
  if (!a || !b) return false;
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  if (a.loopback && b.loopback) return true;
  return a.host === b.host;
}
