/**
 * Anthropic Messages Web Search Adapter：通过 `/messages` 的 `web_search_20250305` server tool 执行搜索并保守归一化结果。
 *
 * 搜索由服务端执行，客户端只发送单个公开 query、解析 `web_search_tool_result` 块；
 * Adapter 不接收主 Agent 消息、工具、Memory、RAG 或 checkpoint；凭据按调用从
 * CredentialStore 解析，Provider 原始响应与错误正文不进入异常或日志。
 * 来源来自 `web_search_tool_result.content[].web_search_result`，摘要来自
 * text 块 `citations[]` 的 `cited_text`（每个 URL 只保留首次出现）。
 */

import {
  WebSearchCapabilityError,
  type CredentialRef,
  type CredentialStore,
  type WebSearchCapability,
  type WebSearchResult,
  type WebSearchSource,
} from "@autopilot-agent/core";

/** Search 是 Agent 内置能力：官方默认连接固定官方地址，不接受用户覆盖 baseUrl。 */
export const DEEPSEEK_ANTHROPIC_SEARCH_OFFICIAL_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_ANTHROPIC_SEARCH_ENDPOINT = `${DEEPSEEK_ANTHROPIC_SEARCH_OFFICIAL_BASE_URL}/v1/messages`;
export const DEEPSEEK_ANTHROPIC_SEARCH_MODEL = "deepseek-flash";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = 24 * 1024;
const MAX_SOURCE_COUNT = 10;
const MAX_SOURCE_TITLE_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2 * 1024;
/** 单次请求允许的服务端 web_search 执行次数上限；沿用 DS Harness 官方默认值。 */
const WEB_SEARCH_MAX_USES = 5;
/** Messages 请求的生成 token 上限；搜索只产出摘要与来源，沿用 DS Harness 官方默认值。 */
const SEARCH_MAX_TOKENS = 4096;

/** Anthropic Messages Search Adapter 的受信依赖。 */
export interface CreateAnthropicWebSearchOptions {
  credentialRef: CredentialRef;
  credentialStore: CredentialStore;
  /** 已由 Core 校验的 Provider 连接地址，不含 `/v1/messages`。 */
  baseUrl: string;
  /** 兼容宿主连接声明；固定 deepseek-flash，显式传入其他模型拒绝，不静默覆盖。 */
  model?: string;
  /** fake HTTP 测试 seam；生产默认使用平台原生 fetch。 */
  fetch?: typeof fetch;
}

/** 判断未知 JSON 值是否为可按字段读取的普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 创建不包含 query、响应正文或底层堆栈的固定本地错误。 */
function createSafeAdapterError(code: string): Error {
  const error = new Error(code);
  error.name = "AnthropicWebSearchError";
  return error;
}

/** 将独立 Search 模型固定为 deepseek-flash，拒绝宿主误配成其他模型。 */
function resolveSearchModel(value: string | undefined): string {
  if (value === undefined) return DEEPSEEK_ANTHROPIC_SEARCH_MODEL;
  const model = value.trim();
  if (model !== DEEPSEEK_ANTHROPIC_SEARCH_MODEL) {
    throw createSafeAdapterError("WEB_SEARCH_MODEL_INVALID");
  }
  return model;
}

/** 将已校验的 Provider baseUrl 转换为 Anthropic Messages 请求地址。 */
function createMessagesEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/v1/messages`;
}

/** 在 UTF-8 字节预算内裁剪文本，确保 Adapter 自身输出有界。 */
function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))) low--;
  return { value: `${value.slice(0, low)}${suffix}`, truncated: true };
}

/** 规范化无 userinfo 的 HTTP(S) 引用 URL，并拒绝超出本地字段预算的地址。 */
function normalizeCitationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    const normalized = url.toString();
    return Buffer.byteLength(normalized, "utf8") <= MAX_SOURCE_URL_BYTES ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** 从 text 块的 citations 里提取 url → cited_text 摘要映射；每个 URL 只保留首次出现。 */
function collectCitationSnippets(blocks: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (!isRecord(citation) || typeof citation.url !== "string" || !citation.url || typeof citation.cited_text !== "string" || !citation.cited_text || map.has(citation.url)) continue;
      map.set(citation.url, citation.cited_text);
    }
  }
  return map;
}

/** 在解析 JSON 前按解压后的响应字节数执行 1 MiB 硬门，并贯穿取消信号。 */
async function readBoundedResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("网络搜索已取消", "AbortError");
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw createSafeAdapterError("WEB_SEARCH_RESPONSE_TOO_LARGE");
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // 读取已经失败；取消流失败不替换原始安全错误。
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** 丢弃错误响应正文，避免无界读取或把 Provider 详情带入错误路径。 */
function discardResponseBody(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(
    /** 错误响应已经归一化，释放正文失败不改变安全终态。 */
    function ignoreBodyCancellationFailure() {},
  );
}

/** 把完成态 Messages JSON 保守投影为 answer 与去重 URL sources。 */
function parseSearchResponse(value: unknown): WebSearchResult {
  if (!isRecord(value) || !Array.isArray(value.content)) throw createSafeAdapterError("WEB_SEARCH_RESPONSE_INVALID");
  const blocks = value.content;
  const snippets = collectCitationSnippets(blocks);
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const answerParts: string[] = [];
  let truncated = false;
  let foundResults = false;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      answerParts.push(block.text);
      continue;
    }
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    foundResults = true;
    for (const item of block.content) {
      if (!isRecord(item) || item.type !== "web_search_result") continue;
      const url = normalizeCitationUrl(item.url);
      if (!url) {
        truncated = true;
        continue;
      }
      if (seen.has(url)) continue;
      if (sources.length >= MAX_SOURCE_COUNT) {
        truncated = true;
        continue;
      }
      seen.add(url);
      const candidateTitle = typeof item.title === "string" && item.title.trim() ? item.title.trim() : new URL(url).hostname;
      const title = truncateUtf8(candidateTitle, MAX_SOURCE_TITLE_BYTES);
      if (!title.value) {
        truncated = true;
        continue;
      }
      const snippet = snippets.get(url);
      sources.push({ title: title.value, url, ...(snippet ? { snippet } : {}) });
    }
  }
  // 没有任何服务端搜索结果块即视为未执行搜索，不把纯模型回答伪造为搜索成功。
  if (!foundResults) throw createSafeAdapterError("WEB_SEARCH_NOT_PERFORMED");
  const answer = truncateUtf8(answerParts.join("\n"), MAX_ANSWER_BYTES);
  return { answer: answer.value, sources, truncated: truncated || answer.truncated };
}

/** 创建指定 endpoint/model 且不自动重试的 Anthropic Messages Search capability。 */
export function createAnthropicWebSearchCapability(options: CreateAnthropicWebSearchOptions): WebSearchCapability {
  if (options.credentialRef.provider !== "deepseek") throw createSafeAdapterError("WEB_SEARCH_CREDENTIAL_REF_INVALID");
  const endpoint = createMessagesEndpoint(options.baseUrl);
  const model = resolveSearchModel(options.model);
  const credentialSnapshot = options.credentialStore.resolve(options.credentialRef).catch(function unavailable() { return undefined; });
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    /** 只发送 query 与唯一 web_search server tool，并将所有失败收敛为安全错误。 */
    async search(input): Promise<WebSearchResult> {
      if (input.signal?.aborted) throw new DOMException("网络搜索已取消", "AbortError");
      let apiKey: string;
      try {
        const credential = await credentialSnapshot;
        apiKey = credential?.apiKey?.trim() ?? "";
      } catch {
        throw new WebSearchCapabilityError("CAPABILITY_UNAVAILABLE", "网络搜索凭据不可用");
      }
      if (!apiKey) throw new WebSearchCapabilityError("CAPABILITY_UNAVAILABLE", "网络搜索凭据不可用");
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            // 官方端点期望 x-api-key；Anthropic 兼容代理可能期望 Bearer——两者都发送以兼容两者。
            "x-api-key": apiKey,
            "authorization": `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: SEARCH_MAX_TOKENS,
            messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${input.query}` }] }],
            // 搜索由服务端执行；客户端只声明 server tool 并解析结果块，不发任何自有网络搜索。
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
          }),
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
        throw createSafeAdapterError("WEB_SEARCH_REQUEST_FAILED");
      }
      if (response.status === 429) {
        discardResponseBody(response);
        throw new WebSearchCapabilityError("WEB_SEARCH_RATE_LIMITED", "网络搜索服务当前限流");
      }
      if (!response.ok) {
        discardResponseBody(response);
        throw new WebSearchCapabilityError(
          "WEB_SEARCH_PROVIDER_REJECTED",
          response.status >= 500 ? "网络搜索服务暂时不可用" : "网络搜索请求被服务拒绝",
        );
      }
      const body = await readBoundedResponseText(response, input.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw createSafeAdapterError("WEB_SEARCH_RESPONSE_INVALID");
      }
      return parseSearchResponse(parsed);
    },
  };
}

/** 对用户配置的 Anthropic Messages endpoint 发送无凭据 HEAD 探测。 */
export async function probeAnthropicWebSearchConnectivity(baseUrl: string, fetchImplementation: typeof fetch, signal?: AbortSignal): Promise<"reachable" | "server_error"> {
  const response = await fetchImplementation(createMessagesEndpoint(baseUrl), { method: "HEAD", redirect: "manual", signal });
  discardResponseBody(response);
  return response.status >= 500 ? "server_error" : "reachable";
}
