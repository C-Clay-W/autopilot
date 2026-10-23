/**
 * work-preview-target.ts — Work 内置预览的目标 URL 策略。
 *
 * 冻结契约见 Talk-Plan0908-work-browser-preview.md §7.3：仅 http/https、无 query、无 userinfo、
 * 回环归一、拒绝 Agent 自身端口与私网/保留段目标；保留段按 v0.12 枚举
 * （IPv4 全保留段；IPv6 fc00::/7、fe80::/10、fec0::/10、ff00::/8、2001:db8::/32、::/96）。
 * 由 WorkPreviewService 与手动 open-link 共用；自 Stage0 原型迁移，行为不变。
 */

/** 预览目标沙箱档：本地受信档与公网严格档，与冻结契约一一对应。 */
export type PreviewSandboxProfile = "trusted_local" | "strict_public";

/** 校验成功后交付给面板的目标信息；navigationUrl 与 copyUrl 必须严格一致。 */
export interface PreviewTarget {
  /** 实际交给 iframe 的页面地址 */
  navigationUrl: string;
  /** 用户复制的完整页面地址（冻结：与 navigationUrl 严格相同） */
  copyUrl: string;
  /** 面板展示用的安全主机标签（hostname[:port]） */
  hostLabel: string;
  /** 依据目标类别选择的沙箱档 */
  sandboxProfile: PreviewSandboxProfile;
}

/** 目标策略统一失败码：不区分具体原因、不回显原值，避免泄露校验细节。 */
export type PreviewTargetResult =
  | { ok: true; target: PreviewTarget }
  | { ok: false; code: "PREVIEW_INVALID_TARGET" };

/** 冻结常量：URL 长度上限。 */
const MAX_URL_LENGTH = 2048;

/** 回环主机名集合（IPv6 以带方括号的 hostname 形式表示，与 WHATWG URL 序列化一致）。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 统一失败构造：所有拒绝路径都返回同一码，不携带原因细节。 */
function invalid(): PreviewTargetResult {
  return { ok: false, code: "PREVIEW_INVALID_TARGET" };
}

/** 判断 IPv4 点分四段是否属于保留地址段（公网目标必须排除；枚举与 Plan v0.12 URL 策略契约一致）。 */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;              // 0/8 本网络、10/8 私网、127/8 回环
  if (a === 100 && b >= 64 && b <= 127) return true;              // 100.64/10 运营商级 NAT 共享地址
  if (a === 169 && b === 254) return true;                        // 169.254/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16/12 私网
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;  // 192.0.0/24 IETF 协议保留、192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;             // 192.88.99/24 已废弃 6to4 中继
  if (a === 192 && b === 168) return true;                        // 192.168/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true;           // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true;            // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;             // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true;                                      // 224/4 组播与 240/4 保留（含受限广播）
  return false;
}

/** 解析 IPv6 字面量首个 hextet（16 位段）；无法解析返回 -1。 */
function firstHextet(inner: string): number {
  const m = inner.match(/^([0-9a-f]{1,4})(?::|$)/);
  return m ? parseInt(m[1], 16) : -1;
}

/**
 * 判断 WHATWG 规范化后的 IPv6 字面量是否属于冻结枚举的保留段（公网目标必须排除）。
 * 枚举：::（未指定）、fc00::/7（唯一本地）、fe80::/10（链路本地）、
 * fec0::/10（已废弃站点本地）、ff00::/8（组播）、2001:db8::/32（文档段）、
 * ::/96（已废弃 IPv4 兼容形式，末 32 位按嵌入 IPv4 判定）；
 * IPv4-mapped（::ffff:0:0/96）由调用方先经 mappedIPv4Text 按嵌入 IPv4 判定。
 */
function isReservedIPv6(inner: string): boolean {
  if (inner === "::") return true;
  const first = firstHextet(inner);
  if (first >= 0) {
    if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 唯一本地地址
    if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 链路本地（fe80–febf）
    if ((first & 0xffc0) === 0xfec0) return true;   // fec0::/10 已废弃站点本地
    if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 组播
    if (first === 0x2001 && /^2001:0?db8(?::|$)/.test(inner)) return true; // 2001:db8::/32 文档段
  }
  // ::/96 IPv4 兼容形式（如 ::a00:1 即 ::10.0.0.1）：末 32 位还原为 IPv4 后按保留段判定。
  if (inner.startsWith("::")) {
    const tail = inner.slice(2).split(":");
    if (tail.length === 2 && tail.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = parseInt(tail[0], 16);
      const lo = parseInt(tail[1], 16);
      return isPrivateIPv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."));
    }
  }
  return false;
}

/** 判断主机名是否属于回环：localhost、*.localhost、127/8、[::1] 及 IPv4-mapped 回环。 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(h) || h.endsWith(".localhost")) return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.startsWith("[::ffff:") && h.endsWith("]")) {
    const mapped = mappedIPv4Text(h.slice(1, -1));
    if (mapped) return isLoopbackIPv4Text(mapped);
  }
  return false;
}

/** 将 IPv4-mapped 段还原为点分四段文本；同时接受点分与 WHATWG 规范化后的十六进制形式。 */
function mappedIPv4Text(inner: string): string | undefined {
  const lower = inner.toLowerCase();
  if (!lower.startsWith("::ffff:")) return undefined;
  const rest = lower.slice(7);
  // WHATWG URL 把 [::ffff:127.0.0.1] 序列化为 [::ffff:7f00:1]，点分与 hex 形式都要支持。
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
  }
  const parts = rest.split(".");
  if (parts.length === 4 && parts.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255)) return rest;
  return undefined;
}

/** 判断点分四段文本是否为 127/8 回环（供 IPv4-mapped 判定复用）。 */
function isLoopbackIPv4Text(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.slice(1).every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 展开 Agent 自身监听 authority 的回环端口集合；Agent 仅绑定回环，非回环 authority 不参与别名展开。 */
function agentLoopbackPorts(authorities: readonly string[]): Set<string> {
  const ports = new Set<string>();
  for (const authority of authorities) {
    const match = authority.match(/^(?:\[([^\[\]]+)\]|([^:]+)):(\d+)$/);
    const host = match ? (match[1] ? "[" + match[1] + "]" : match[2]) : authority;
    const port = match ? match[3] : "";
    if (port && isLoopbackHostname(host)) ports.add(port);
  }
  return ports;
}

/** 规范化并校验预览目标；任何不满足冻结规则的输入统一返回 PREVIEW_INVALID_TARGET。 */
export function normalizePreviewTarget(rawUrl: string, agentAuthorities: readonly string[] = []): PreviewTargetResult {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return invalid();
  // 控制字符与空白在 WHATWG 解析前拒绝，避免依赖解析器的静默裁剪行为。
  if (/[\u0000-\u001f\u007f\s]/.test(rawUrl)) return invalid();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return invalid();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid();
  if (url.username || url.password) return invalid();
  // 首期不支持 query；hash 允许但不得包含查询数据。
  if (url.search) return invalid();
  if (url.hash.includes("?")) return invalid();

  const hostname = url.hostname;
  if (isLoopbackHostname(hostname)) {
    // 本地目标不得落在 Agent 自身监听端口（含全部回环别名），防止把管理 API/Chat 页面嵌入预览。
    if (agentLoopbackPorts(agentAuthorities).has(url.port)) return invalid();
  } else {
    // 公网目标排除私网/保留地址字面量与 mDNS 名；DNS 层面的重绑定不在本策略范围（服务端从不访问目标）。
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIPv4(hostname)) return invalid();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const inner = hostname.slice(1, -1).toLowerCase();
      const mapped = mappedIPv4Text(inner);
      if (mapped ? isPrivateIPv4(mapped) : isReservedIPv6(inner)) return invalid();
    }
    if (hostname.toLowerCase().endsWith(".local")) return invalid();
  }

  const sandboxProfile: PreviewSandboxProfile = isLoopbackHostname(hostname) ? "trusted_local" : "strict_public";
  const hostLabel = url.port ? hostname + ":" + url.port : hostname;
  return { ok: true, target: { navigationUrl: url.href, copyUrl: url.href, hostLabel, sandboxProfile } };
}
