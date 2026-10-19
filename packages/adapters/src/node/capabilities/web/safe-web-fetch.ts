/**
 * 安全 Web Fetch Adapter：只连接已钉住的公网 DNS 地址，并对重定向、正文与文本提取设硬门。
 *
 * 本模块不记录 URL、响应正文或底层网络错误；HTML 必须经 DOM 解析后才会进入模型可见结果。
 */

import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { type Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { WebFetchCapabilityError, type WebFetchCapability } from "@autopilot-agent/core";
import { parseHTML } from "linkedom";
import {
  resolveWebFetchDns,
  validatePublicWebUrl,
  type WebFetchDnsResolver,
  type WebFetchResolvedAddress,
} from "./url-policy";

const MAX_REDIRECTS = 10;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 100_000;
const REMOVED_HTML_SELECTORS = "script,style,noscript,template,svg,canvas,iframe,object,embed";
const BLOCK_HTML_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV",
  "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** 安全 HTTP 客户端返回的最小响应形状。 */
export interface WebFetchHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  abort(): void;
}

/** 安全 HTTP 客户端只接收已校验 URL 与必须钉住的单个公网地址。 */
export interface WebFetchHttpRequest {
  url: URL;
  address: WebFetchResolvedAddress;
  signal?: AbortSignal;
}

/** 可注入的 HTTP 边界；生产实现必须把连接钉到 address，测试使用本地受控服务器。 */
export type WebFetchHttpClient = (request: WebFetchHttpRequest) => Promise<WebFetchHttpResponse>;

/** 创建安全 Fetch Adapter 的受控依赖。 */
export interface SafeWebFetchOptions {
  resolveDns?: WebFetchDnsResolver;
  request?: WebFetchHttpClient;
}

/** 创建不携带 URL 或底层正文的标准取消异常。 */
function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** 使用已经过策略校验的单个地址建立 HTTP(S) 连接，禁止客户端再次解析 hostname。 */
export function requestPinnedWebUrl(input: WebFetchHttpRequest): Promise<WebFetchHttpResponse> {
  return new Promise<WebFetchHttpResponse>(
    /** 等待 Node HTTP 客户端返回响应，并把 signal 直接交给 socket 生命周期。 */
    function waitForHttpResponse(resolve, reject) {
      const transport = input.url.protocol === "https:" ? https : http;
      /** 把连接层 hostname 查询固定返回已校验地址，消除校验后再次 DNS 解析的 rebinding 窗口。 */
      function lookupPinnedAddress(
        _hostname: string,
        _options: object,
        callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ): void {
        // 保持 DNS lookup 的异步回调语义，让 HTTP/socket 先完成错误监听绑定。
        queueMicrotask(function resolvePinnedAddress() { callback(null, input.address.address, input.address.family); });
      }
      /** 将 Node IncomingMessage 收敛为 Adapter 的最小响应边界。 */
      function resolveIncomingResponse(response: http.IncomingMessage): void {
        /** 同时终止响应流与底层请求，供重定向、超限和拒绝场景及时释放资源。 */
        function abortResponse(): void {
          response.destroy();
          request.destroy();
        }
        resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response, abort: abortResponse });
      }
      const request = transport.request(input.url, {
        method: "GET",
        signal: input.signal,
        lookup: lookupPinnedAddress,
        // 固定 family 会让 Node 跳过默认地址族自动选择；lookup 仅需返回这一地址。
        family: input.address.family,
        agent: false,
        headers: {
          accept: "text/html,text/plain,text/markdown,application/json",
          "accept-encoding": "gzip, deflate, br",
          "user-agent": "Autopilot-Web-Fetch/1.0",
        },
      }, resolveIncomingResponse);
      /** 网络失败只交回异常类别，Core 会进一步收敛为固定安全文案。 */
      function rejectRequest(error: Error): void {
        reject(error);
      }
      request.once("error", rejectRequest);
      request.end();
    },
  );
}

/** 从大小写已由 Node 归一化的响应头中读取第一项文本。 */
function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 判断状态码是否要求按 Location 执行受控重定向。 */
function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

/** 将 Content-Type 收敛为小写 MIME 与可选 charset，未知类型由调用方拒绝。 */
function parseContentType(value: string | undefined): { mimeType: string; charset: string } | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  const parts = value.split(";");
  const mimeType = parts.shift()?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return undefined;
  let charset = "utf-8";
  for (const part of parts) {
    const matched = /^\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(part);
    if (matched?.[1]) charset = matched[1].toLowerCase();
  }
  return { mimeType, charset };
}

/** 判断 MIME 是否属于首期明确允许的 HTML、纯文本、Markdown 或 JSON。 */
function isSupportedContentType(mimeType: string): boolean {
  return mimeType === "text/html"
    || mimeType === "application/xhtml+xml"
    || mimeType === "text/plain"
    || mimeType === "text/markdown"
    || mimeType === "text/x-markdown"
    || mimeType === "application/json"
    || mimeType.endsWith("+json");
}

/** 有界读取原始响应；未压缩正文可保留前 10 MiB，压缩流超限则拒绝不完整压缩包。 */
async function readBoundedRawBody(response: WebFetchHttpResponse, compressed: boolean, signal?: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    if (signal?.aborted) {
      response.abort();
      throw createAbortError();
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const remaining = MAX_RESPONSE_BYTES - totalBytes;
    if (buffer.length > remaining) {
      response.abort();
      if (compressed) throw new WebFetchCapabilityError("WEB_RESPONSE_TOO_LARGE", "压缩网页响应超过读取上限");
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      return { body: Buffer.concat(chunks, MAX_RESPONSE_BYTES), truncated: true };
    }
    chunks.push(buffer);
    totalBytes += buffer.length;
  }
  return { body: Buffer.concat(chunks, totalBytes), truncated: false };
}

/** 在 10 MiB 输出硬门内解压响应，阻止小压缩包展开为无界正文。 */
function decodeContentEncoding(raw: Buffer, encoding: string): Buffer {
  if (!encoding || encoding === "identity") return raw;
  try {
    const options = { maxOutputLength: MAX_RESPONSE_BYTES + 1 };
    const decoded = encoding === "gzip" || encoding === "x-gzip"
      ? gunzipSync(raw, options)
      : encoding === "deflate"
        ? inflateSync(raw, options)
        : encoding === "br"
          ? brotliDecompressSync(raw, options)
          : undefined;
    if (!decoded) throw new WebFetchCapabilityError("WEB_CONTENT_TYPE_UNSUPPORTED", "网页压缩格式不受支持");
    if (decoded.length > MAX_RESPONSE_BYTES) throw new WebFetchCapabilityError("WEB_RESPONSE_TOO_LARGE", "网页解压正文超过读取上限");
    return decoded;
  } catch (error) {
    if (error instanceof WebFetchCapabilityError) throw error;
    throw new WebFetchCapabilityError("WEB_RESPONSE_TOO_LARGE", "网页压缩正文无法安全读取");
  }
}

/** 使用响应声明的字符集解码文本；非法字符集不会回退为可能误解码的正文。 */
function decodeText(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    throw new WebFetchCapabilityError("WEB_CONTENT_TYPE_UNSUPPORTED", "网页字符集不受支持");
  }
}

/** 深度遍历已解析 DOM，用块级换行保留可读结构，不读取属性或执行页面脚本。 */
function collectDomText(node: Node, output: string[]): void {
  if (node.nodeType === 3) {
    if (node.nodeValue) output.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
  const elementName = node.nodeType === 1 ? (node as Element).tagName.toUpperCase() : "";
  if (elementName === "BR") output.push("\n");
  for (const child of Array.from(node.childNodes)) collectDomText(child, output);
  if (BLOCK_HTML_ELEMENTS.has(elementName) && elementName !== "BR") output.push("\n");
}

/** 收敛 DOM 提取产生的空白，同时保留段落换行。 */
function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 使用 linkedom 解析 HTML 并只提取 title 与可见结构文本，禁止正则剥标签或返回 raw HTML。 */
function extractHtml(html: string): { title?: string; content: string } {
  const { document } = parseHTML(html);
  for (const element of Array.from(document.querySelectorAll(REMOVED_HTML_SELECTORS))) element.remove();
  const root = document.querySelector("main") ?? document.querySelector("article") ?? document.body ?? document.documentElement;
  const output: string[] = [];
  collectDomText(root, output);
  const title = normalizeExtractedText(document.title ?? "");
  return { ...(title ? { title } : {}), content: normalizeExtractedText(output.join("")) };
}

/** 对模型可见文本执行首期 100,000 字符上限，并返回明确裁剪事实。 */
function truncateExtractedText(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_EXTRACTED_CHARACTERS) return { value, truncated: false };
  return { value: value.slice(0, MAX_EXTRACTED_CHARACTERS), truncated: true };
}

/** 读取单个最终响应并按 MIME 解析为供应商无关 WebFetchResult 字段。 */
async function readFinalResponse(response: WebFetchHttpResponse, signal?: AbortSignal): Promise<{ title?: string; content: string; contentType: string; truncated: boolean }> {
  const contentType = parseContentType(readHeader(response.headers, "content-type"));
  const contentDisposition = readHeader(response.headers, "content-disposition")?.toLowerCase();
  if (!contentType || !isSupportedContentType(contentType.mimeType) || contentDisposition?.includes("attachment")) {
    response.abort();
    throw new WebFetchCapabilityError("WEB_CONTENT_TYPE_UNSUPPORTED", "网页内容类型不受支持");
  }
  const encoding = readHeader(response.headers, "content-encoding")?.trim().toLowerCase() ?? "identity";
  const raw = await readBoundedRawBody(response, encoding !== "identity", signal);
  const decoded = decodeContentEncoding(raw.body, encoding);
  const text = decodeText(decoded, contentType.charset);
  const extracted = contentType.mimeType === "text/html" || contentType.mimeType === "application/xhtml+xml"
    ? extractHtml(text)
    : { content: text.trim() };
  const content = truncateExtractedText(extracted.content);
  return {
    ...(extracted.title ? { title: extracted.title } : {}),
    content: content.value,
    contentType: contentType.mimeType,
    truncated: raw.truncated || content.truncated,
  };
}

/** 创建同时具备 DNS 钉住、逐跳校验、正文硬门和 DOM 提取的 Web Fetch capability。 */
export function createSafeWebFetchCapability(options: SafeWebFetchOptions = {}): WebFetchCapability {
  const resolveDns = options.resolveDns ?? resolveWebFetchDns;
  const request = options.request ?? requestPinnedWebUrl;
  return {
    /** 读取明确 URL；跨域目标和剩余跳数只交给 Core，在审批后续接。 */
    async fetch(input) {
      if (input.redirectsRemaining !== undefined && (!Number.isInteger(input.redirectsRemaining) || input.redirectsRemaining < 0 || input.redirectsRemaining > MAX_REDIRECTS)) {
        throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页重定向预算无效");
      }
      const original = await validatePublicWebUrl(input.url, { resolveDns, signal: input.signal });
      let current = original;
      let redirectCount = 0;
      const redirectLimit = Math.max(0, Math.min(MAX_REDIRECTS, input.redirectsRemaining ?? MAX_REDIRECTS));
      while (true) {
        if (input.signal?.aborted) throw createAbortError();
        const response = await request({ url: current.url, address: current.addresses[0], signal: input.signal });
        if (isRedirectStatus(response.statusCode)) {
          const location = readHeader(response.headers, "location");
          if (!location || redirectCount >= redirectLimit) {
            response.abort();
            throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页重定向无效或超过上限");
          }
          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, current.url);
          } catch {
            response.abort();
            throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页重定向地址无效");
          }
          if (redirectUrl.hostname.toLowerCase() !== current.url.hostname.toLowerCase()) {
            response.abort();
            if (!["http:", "https:"].includes(redirectUrl.protocol) || redirectUrl.username || redirectUrl.password) {
              throw new WebFetchCapabilityError("WEB_URL_BLOCKED", "网页重定向地址无效");
            }
            throw new WebFetchCapabilityError("WEB_REDIRECT_REQUIRES_APPROVAL", "网页重定向需要新的域名审批", {
              url: redirectUrl.toString(), remainingRedirects: redirectLimit - redirectCount - 1,
            });
          }
          const next = await validatePublicWebUrl(redirectUrl, { resolveDns, signal: input.signal });
          response.abort();
          current = next;
          redirectCount += 1;
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.abort();
          throw new Error("WEB_FETCH_HTTP_REJECTED");
        }
        const parsed = await readFinalResponse(response, input.signal);
        return {
          url: original.url.toString(),
          finalUrl: current.url.toString(),
          ...parsed,
        };
      }
    },
  };
}
