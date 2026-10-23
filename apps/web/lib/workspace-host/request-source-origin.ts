/**
 * request-source-origin.ts — Work 受信请求来源共享的回环 Origin 规范化。
 *
 * web-workspace-jobs 与预览路由 guard 共用，避免平行复制"同端口回环 Host 恢复浏览器真实
 * origin"的逻辑；兼容 Next 开发宿主把 request.url 规范成 localhost 的行为，不信任转发头。
 */

/** 判断主机名是否为本机回环（含 URL.hostname 的带方括号 IPv6 序列化形式）。 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** 计算浏览器真实请求 origin：Host 与 URL host 不一致时仅接受同端口回环规范化；不可信时返回 undefined。 */
export function expectedRequestOrigin(requestUrl: URL, hostHeader: string | null): string | undefined {
  if (!hostHeader || hostHeader === requestUrl.host) return requestUrl.origin;
  try {
    const actual = new URL(`${requestUrl.protocol}//${hostHeader}`);
    if (!isLoopbackHost(requestUrl.hostname) || !isLoopbackHost(actual.hostname)
      || actual.port !== requestUrl.port || actual.host !== hostHeader) return undefined;
    return actual.origin;
  } catch {
    return undefined;
  }
}
