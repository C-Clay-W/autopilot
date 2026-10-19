/**
 * Web Fetch URL 策略：在建立连接前规范化 URL、解析 DNS，并拒绝所有非公网地址。
 *
 * 每次重定向都必须重新调用本模块；调用方只能把这里返回的已校验地址钉入连接。
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { WebFetchCapabilityError } from "@autopilot-agent/core";

/** 一条已由 DNS 返回、可供 HTTP 客户端钉住的地址。 */
export interface WebFetchResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** 可注入的 DNS 解析边界；测试使用完全受控的本地解析结果。 */
export type WebFetchDnsResolver = (hostname: string, signal?: AbortSignal) => Promise<readonly WebFetchResolvedAddress[]>;

/** 已完成协议、userinfo、hostname 与全部 DNS 地址检查的 URL。 */
export interface ValidatedWebUrl {
  url: URL;
  addresses: WebFetchResolvedAddress[];
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data",
]);

/** 建立覆盖私网、回环、链路本地、保留、文档和特殊用途 IPv4 网段的阻止表。 */
function createBlockedIpv4List(): BlockList {
  const blocked = new BlockList();
  const ipv4Subnets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of ipv4Subnets) blocked.addSubnet(network, prefix, "ipv4");
  return blocked;
}

/** 建立默认拒绝非公网单播并排除特殊用途范围的 IPv6 阻止表。 */
function createBlockedIpv6List(): BlockList {
  const blocked = new BlockList();
  // IPv6 只允许 2000::/3 的公网单播，并额外排除文档、ORCHID 与 6to4 网段。
  blocked.addSubnet("::", 3, "ipv6");
  blocked.addSubnet("4000::", 2, "ipv6");
  blocked.addSubnet("8000::", 1, "ipv6");
  blocked.addSubnet("2001::", 23, "ipv6");
  blocked.addSubnet("2001:db8::", 32, "ipv6");
  blocked.addSubnet("2002::", 16, "ipv6");
  blocked.addSubnet("3fff::", 20, "ipv6");
  return blocked;
}

// Node BlockList 在同一实例混合 IPv4/IPv6 规则时可能跨族匹配，因此必须分表检查。
const BLOCKED_IPV4_ADDRESSES = createBlockedIpv4List();
const BLOCKED_IPV6_ADDRESSES = createBlockedIpv6List();

/** 创建不携带底层 DNS 或 URL 正文的标准取消异常。 */
function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** 让不原生支持 AbortSignal 的 DNS Promise 在取消后立即停止等待。 */
function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>(
    /** 竞争 DNS 完成与宿主取消，并在任一终态移除 listener。 */
    function settleWithAbort(resolve, reject) {
      /** 取消等待并返回标准 AbortError。 */
      function rejectOnAbort(): void {
        reject(createAbortError());
      }
      signal.addEventListener("abort", rejectOnAbort, { once: true });
      operation.then(
        /** DNS 成功时清理取消监听并返回结果。 */
        function resolveOperation(value) {
          signal.removeEventListener("abort", rejectOnAbort);
          resolve(value);
        },
        /** DNS 失败时清理取消监听并保留原始失败供本模块统一收敛。 */
        function rejectOperation(error) {
          signal.removeEventListener("abort", rejectOnAbort);
          reject(error);
        },
      );
    },
  );
}

/** 使用 Node DNS 返回全部 A/AAAA 结果，避免只校验一个地址后由连接层重新解析。 */
export async function resolveWebFetchDns(hostname: string, signal?: AbortSignal): Promise<WebFetchResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) return [{ address: hostname, family: literalFamily }];
  const records = await waitWithAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  const resolved: WebFetchResolvedAddress[] = [];
  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) continue;
    resolved.push({ address: record.address, family: record.family });
  }
  return resolved;
}

/** 去除 URL.hostname 为 IPv6 literal 保留的方括号，以便交给 net.isIP 与 BlockList。 */
function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** 判断 hostname 是否属于无需 DNS 就能确定的本地或 metadata 名称。 */
function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTNAMES.has(normalized)
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal");
}

/** 判断一个 IP 是否是允许建立外部 HTTP(S) 连接的公网地址。 */
export function isPublicWebAddress(address: string, family?: 4 | 6): boolean {
  const detectedFamily = isIP(address);
  if (family !== undefined && detectedFamily !== family) return false;
  const normalizedFamily = family ?? detectedFamily;
  if (normalizedFamily !== 4 && normalizedFamily !== 6) return false;
  return normalizedFamily === 4
    ? !BLOCKED_IPV4_ADDRESSES.check(address, "ipv4")
    : !BLOCKED_IPV6_ADDRESSES.check(address, "ipv6");
}

/** 规范化并验证单跳 URL；任一 DNS 结果非公网时整体 fail closed。 */
export async function validatePublicWebUrl(
  rawUrl: string | URL,
  options: { resolveDns?: WebFetchDnsResolver; signal?: AbortSignal } = {},
): Promise<ValidatedWebUrl> {
  let url: URL;
  try {
    const value = rawUrl.toString();
    if (value.length > 2_000) throw new Error("URL_TOO_LONG");
    url = new URL(value);
  } catch {
    throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) {
    throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址不允许访问");
  }
  const hostname = normalizeHostname(url.hostname).toLowerCase();
  if (isBlockedHostname(hostname)) throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址不允许访问");

  let addresses: readonly WebFetchResolvedAddress[];
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await (options.resolveDns ?? resolveWebFetchDns)(hostname, options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw createAbortError();
      throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址解析失败");
    }
  }
  if (addresses.length === 0) throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址解析失败");

  const unique = new Map<string, WebFetchResolvedAddress>();
  for (const record of addresses) {
    if (!isPublicWebAddress(record.address, record.family)) {
      throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页地址不允许访问");
    }
    unique.set(`${record.family}:${record.address}`, { address: record.address, family: record.family });
  }
  return { url, addresses: [...unique.values()] };
}
