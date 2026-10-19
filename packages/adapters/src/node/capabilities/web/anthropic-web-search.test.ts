/**
 * Anthropic Messages Search Adapter 契约测试：验证固定请求、保守归一化、错误、取消与路由边界。
 */

import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "@autopilot-agent/core";
import { createWebSearchProviderCapability, probeWebSearchProviderConnectivity } from "./web-search-provider";
import {
  createAnthropicWebSearchCapability,
  DEEPSEEK_ANTHROPIC_SEARCH_ENDPOINT,
  DEEPSEEK_ANTHROPIC_SEARCH_MODEL,
  probeAnthropicWebSearchConnectivity,
} from "./anthropic-web-search";

const PRIVATE_QUERY = "PRIVATE_HTTP_QUERY";
const PRIVATE_PROVIDER_BODY = "PRIVATE_PROVIDER_ERROR_BODY";
const FIXTURE_BASE_URL = "https://api.deepseek.com/anthropic";
const FIXTURE_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";

/** 创建按调用返回固定 API Key 的 CredentialStore 测试替身。 */
function createCredentialStore(apiKey = "fixture-deepseek-key"): CredentialStore {
  return {
    /** 返回只在 Adapter 局部使用的固定凭据。 */
    async resolve() {
      return { apiKey };
    },
  };
}

/** 创建 JSON Response，避免测试依赖真实 DeepSeek 网络。 */
function createJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** 创建单一状态码响应的 fetch 替身。 */
function createStatusFetch(status: number): typeof fetch {
  /** 返回不应被 Adapter 读取的私有错误正文。 */
  async function fetchStatus(): Promise<Response> {
    return new Response(PRIVATE_PROVIDER_BODY, { status });
  }
  return fetchStatus as typeof fetch;
}

/** 从 fetch spy 的首次调用中解析外发 JSON body。 */
function getFirstRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("fake HTTP request body missing");
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** 创建绑定固定 fetch、官方 baseUrl 与可选模型的 Search capability 测试实例。 */
function createSearchCapability(fetchImplementation: typeof fetch, model?: string) {
  return createAnthropicWebSearchCapability({
    credentialRef: { provider: "deepseek", key: "SEARCH" },
    credentialStore: createCredentialStore(),
    baseUrl: FIXTURE_BASE_URL,
    model,
    fetch: fetchImplementation,
  });
}

/** 创建含服务端搜索结果块与可选引用摘要的完成态 Messages fixture。 */
function createMessagesFixture(blocks: unknown[]): Record<string, unknown> {
  return { id: "fixture-message", type: "message", role: "assistant", model: DEEPSEEK_ANTHROPIC_SEARCH_MODEL, content: blocks, usage: { input_tokens: 10, output_tokens: 5 } };
}

/** 验证最小请求不会携带主 Agent tools、消息或内部状态。 */
describe("Anthropic Messages Search Adapter", function anthropicWebSearchSuite() {
  /** 固定 endpoint、deepseek-flash 模型和唯一 web_search server tool，并解析结果块与引用摘要。 */
  it("发送固定最小请求并归一化 answer、sources 与引用摘要", async function sendsFixedRequestAndNormalizesResult() {
    const fetchMock = vi.fn(
      /** 返回含一个结果块与引用摘要的完成态 Messages fixture。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse(createMessagesFixture([
          { type: "server_tool_use", id: "tool-use", name: "web_search", input: { query: PRIVATE_PROVIDER_BODY } },
          { type: "web_search_tool_result", tool_use_id: "tool-use", content: [{ type: "web_search_result", title: "Fixture source", url: "https://example.com/source" }] },
          { type: "text", text: "PUBLIC_ANSWER", citations: [{ type: "web_search_result_location", cited_text: "PUBLIC_SNIPPET", url: "https://example.com/source" }] },
        ]));
      },
    );
    const result = await createSearchCapability(fetchMock as typeof fetch).search({ query: PRIVATE_QUERY });
    const requestBody = getFirstRequestBody(fetchMock);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(FIXTURE_ENDPOINT);
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({ authorization: "Bearer fixture-deepseek-key", "x-api-key": "fixture-deepseek-key", "anthropic-version": "2023-06-01" });
    expect(requestBody).toEqual({
      model: DEEPSEEK_ANTHROPIC_SEARCH_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${PRIVATE_QUERY}` }] }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    expect(requestBody).not.toHaveProperty("checkpoint");
    expect(requestBody).not.toHaveProperty("memory");
    expect(requestBody).not.toHaveProperty("rag");
    expect(result).toEqual({
      answer: "PUBLIC_ANSWER",
      sources: [{ title: "Fixture source", url: "https://example.com/source", snippet: "PUBLIC_SNIPPET" }],
      truncated: false,
    });
  });

  /** 宿主只能声明 deepseek-flash，不允许切换 Search 模型。 */
  it("只接受固定模型声明并拒绝其他 Search 模型", async function acceptsOnlyFixedSearchModel() {
    const fetchMock = vi.fn(
      /** 返回无引用的完成态响应。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse(createMessagesFixture([{ type: "text", text: "ANSWER" }, { type: "web_search_tool_result", tool_use_id: "t", content: [] }]));
      },
    );

    await createSearchCapability(fetchMock as typeof fetch, DEEPSEEK_ANTHROPIC_SEARCH_MODEL).search({ query: "public" });

    expect(getFirstRequestBody(fetchMock)).toMatchObject({ model: DEEPSEEK_ANTHROPIC_SEARCH_MODEL });
    expect(() => createSearchCapability(fetchMock as typeof fetch, "deepseek-v4-flash")).toThrow("WEB_SEARCH_MODEL_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** 非小米供应商引用在创建期即被拒绝，不发任何网络请求。 */
  it("拒绝非 deepseek 的凭据引用", function rejectsForeignCredentialRef() {
    const fetchMock = vi.fn();
    expect(() => createAnthropicWebSearchCapability({
      credentialRef: { provider: "xiaomi-mimo", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      fetch: fetchMock as typeof fetch,
    })).toThrow("WEB_SEARCH_CREDENTIAL_REF_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** 无引用摘要仍返回来源；未知块与未知字段必须安全忽略。 */
  it("接受无摘要来源并忽略未知响应块", async function acceptsSourcesWithoutSnippets() {
    /** 返回未知结构与有效结果块混合的响应。 */
    async function fetchUnknownBlocks(): Promise<Response> {
      return createJsonResponse(createMessagesFixture([
        { type: "future_server_block", private: PRIVATE_PROVIDER_BODY },
        { type: "web_search_tool_result", tool_use_id: "t", content: [{ type: "web_search_result", url: "https://example.com/source" }] },
        { type: "text", text: "ANSWER", citations: [{ type: "future_citation", value: PRIVATE_PROVIDER_BODY }] },
      ]));
    }

    await expect(createSearchCapability(fetchUnknownBlocks as typeof fetch).search({ query: "public" })).resolves.toEqual({
      answer: "ANSWER",
      sources: [{ title: "example.com", url: "https://example.com/source" }],
      truncated: false,
    });
  });

  /** 没有任何服务端搜索结果块即保守失败，不把纯模型回答伪造为搜索结果。 */
  it("拒绝未执行搜索的响应", async function rejectsMissingSearchEvidence() {
    /** 返回仅有文本块的响应。 */
    async function fetchTextOnly(): Promise<Response> {
      return createJsonResponse(createMessagesFixture([{ type: "text", text: "仅有模型记忆" }]));
    }
    /** 返回服务端搜索错误块的响应（content 非数组）。 */
    async function fetchErrorResultBlock(): Promise<Response> {
      return createJsonResponse(createMessagesFixture([{ type: "web_search_tool_result", tool_use_id: "t", content: { error_code: "too_many_requests" } }]));
    }

    await expect(createSearchCapability(fetchTextOnly as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_NOT_PERFORMED");
    await expect(createSearchCapability(fetchErrorResultBlock as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_NOT_PERFORMED");
  });

  /** 重复 URL 去重，非法 URL 丢弃，超过十条来源时明确标记截断。 */
  it("去重来源并拒绝非法或超量 URL", async function filtersAndBoundsSources() {
    const results: Array<Record<string, unknown>> = [
      { type: "web_search_result", title: "valid", url: "https://example.com/source" },
      { type: "web_search_result", title: "duplicate", url: "https://example.com/source" },
      { type: "web_search_result", title: "invalid", url: "file:///private/source" },
    ];
    for (let index = 0; index < 12; index++) results.push({ type: "web_search_result", title: `source-${index}`, url: `https://source-${index}.example/item` });
    /** 返回包含重复、非法与超量引用的响应。 */
    async function fetchManySources(): Promise<Response> {
      return createJsonResponse(createMessagesFixture([{ type: "web_search_tool_result", tool_use_id: "t", content: results }, { type: "text", text: "ANSWER" }]));
    }

    const result = await createSearchCapability(fetchManySources as typeof fetch).search({ query: "public" });

    expect(result.sources).toHaveLength(10);
    expect(result.sources[0]?.url).toBe("https://example.com/source");
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("file:///private/source");
  });

  /** 401、403 与 5xx 均映射固定拒绝错误且不读取 Provider 正文。 */
  it("脱敏 Provider 拒绝与服务端错误", async function sanitizesRejectedResponses() {
    for (const status of [401, 403, 500]) {
      const promise = createSearchCapability(createStatusFetch(status)).search({ query: PRIVATE_QUERY });
      await expect(promise).rejects.toMatchObject({ code: "WEB_SEARCH_PROVIDER_REJECTED" });
      await expect(promise).rejects.not.toThrow(PRIVATE_PROVIDER_BODY);
      await expect(promise).rejects.not.toThrow(PRIVATE_QUERY);
    }
  });

  /** 429 使用独立稳定错误码，调用方不会把它误判为普通畸形响应。 */
  it("区分 Provider 限流", async function mapsRateLimit() {
    await expect(createSearchCapability(createStatusFetch(429)).search({ query: PRIVATE_QUERY })).rejects.toMatchObject({
      code: "WEB_SEARCH_RATE_LIMITED",
      message: "网络搜索服务当前限流",
    });
  });

  /** 非 JSON 与缺失 content 的响应都以固定本地错误失败，不透传原始正文。 */
  it("拒绝畸形 JSON 与非完成态响应", async function rejectsMalformedResponses() {
    /** 返回无法解析的 JSON 正文。 */
    async function fetchMalformedJson(): Promise<Response> {
      return new Response(`{${PRIVATE_PROVIDER_BODY}`, { status: 200 });
    }
    /** 返回缺失 content 数组的响应。 */
    async function fetchMissingContent(): Promise<Response> {
      return createJsonResponse({ id: "fixture", type: "message", error: { message: PRIVATE_PROVIDER_BODY } });
    }

    await expect(createSearchCapability(fetchMalformedJson as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchMissingContent as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
  });

  /** 原始 JSON 超过 1 MiB 时在解析前停止，避免把无界正文交给 Core。 */
  it("拒绝超限响应正文", async function rejectsOversizedResponse() {
    /** 返回超过 Adapter 原始响应预算的正文。 */
    async function fetchOversizedResponse(): Promise<Response> {
      return new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
    }

    await expect(createSearchCapability(fetchOversizedResponse as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_TOO_LARGE");
  });

  /** AbortSignal 在请求等待期立即终止 fake HTTP，覆盖取消与 Tool timeout 的共同底层语义。 */
  it("贯穿取消与超时使用的 AbortSignal", async function propagatesAbortSignal() {
    /** 等待信号终止后以 AbortError 拒绝请求。 */
    function fetchUntilAborted(_input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
      return new Promise<Response>(
        /** 绑定唯一 abort listener，模拟仍在等待的 HTTP 请求。 */
        function waitForAbort(_resolve, reject) {
          const signal = init?.signal;
          if (!signal) return reject(new Error("missing abort signal"));
          /** 将宿主取消转换为标准 AbortError。 */
          function rejectOnAbort(): void {
            reject(new DOMException("aborted", "AbortError"));
          }
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        },
      );
    }
    const controller = new AbortController();
    const pending = createSearchCapability(fetchUntilAborted as typeof fetch).search({ query: PRIVATE_QUERY, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  /** 连通探测只使用用户 endpoint 的无凭据 HEAD，不发送请求正文。 */
  it("以无凭据 HEAD 探测用户 endpoint", async function probesEndpointWithoutCredentials() {
    const fetchMock = vi.fn(
      /** 返回可达但不支持 HEAD 的服务响应。 */
      async function fakeReachableEndpoint(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return new Response(null, { status: 404 });
      },
    );

    await expect(probeAnthropicWebSearchConnectivity(FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(FIXTURE_ENDPOINT, expect.objectContaining({ method: "HEAD", redirect: "manual" }));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("body");
    await expect(probeAnthropicWebSearchConnectivity(FIXTURE_BASE_URL, createStatusFetch(500))).resolves.toBe("server_error");
  });
});

/** 验证 provider 注册表把 deepseek 路由到 Anthropic 适配器，未登记 provider 仍 fail closed。 */
describe("Web search provider routing", function webSearchProviderRoutingSuite() {
  /** deepseek 引用装配出可调用能力并请求 /v1/messages，未知引用仍返回 undefined 且不发请求。 */
  it("按 provider 注册表路由创建与探测", async function routesProviderSelection() {
    const fetchMock = vi.fn(
      /** 返回完成态 Messages fixture。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse(createMessagesFixture([{ type: "web_search_tool_result", tool_use_id: "t", content: [] }, { type: "text", text: "ANSWER" }]));
      },
    );
    const capability = createWebSearchProviderCapability({
      credentialRef: { provider: "deepseek", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      model: DEEPSEEK_ANTHROPIC_SEARCH_MODEL,
      fetch: fetchMock as typeof fetch,
    });
    const unknownCapability = createWebSearchProviderCapability({
      credentialRef: { provider: "unknown-provider", key: "SEARCH" } as never,
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      model: DEEPSEEK_ANTHROPIC_SEARCH_MODEL,
      fetch: fetchMock as typeof fetch,
    });

    expect(typeof capability?.search).toBe("function");
    expect(unknownCapability).toBeUndefined();
    await capability?.search({ query: "public" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(FIXTURE_ENDPOINT);
    await expect(probeWebSearchProviderConnectivity("deepseek", FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(FIXTURE_ENDPOINT, expect.objectContaining({ method: "HEAD" }));
    await expect(probeWebSearchProviderConnectivity("unknown-provider", FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("unsupported");
  });
});
