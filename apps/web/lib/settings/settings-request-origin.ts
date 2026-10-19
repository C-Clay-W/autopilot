/** 本机设置接口的同源校验：兼容 Next 规范化回环地址，但不信任转发头。 */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** 同时校验服务 URL、实际 Host、端口和浏览器 Origin，拒绝外站与伪造主机。 */
export function isLocalSettingsRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    const external = new URL(url.protocol + "//" + host);
    if (!loopbackHosts.has(url.hostname) || !loopbackHosts.has(external.hostname)
      || external.host !== host || external.port !== url.port) return false;
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = request.headers.get("origin");
    return request.method === "GET" ? !origin || origin === external.origin : origin === external.origin;
  } catch { return false; }
}
