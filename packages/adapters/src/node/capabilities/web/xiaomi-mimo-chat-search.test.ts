/**
 * Xiaomi MiMo Chat Search Adapter 契约测试：验证固定请求、保守归一化、错误、取消与路由边界。
 */

import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "@autopilot-agent/core";
import { createWebSearchProviderCapability, probeWebSearchProviderConnectivity } from "./web-search-provider";
import {
  createXiaomiMiMoChatWebSearchCapability,
  createXiaomiMiMoOfficialChatSearchCapability,
  probeXiaomiMiMoChatSearchConnectivity,
  probeXiaomiMiMoOfficialChatSearchConnectivity,
  XIAOMI_MIMO_CHAT_SEARCH_ENDPOINT,
  XIAOMI_MIMO_CHAT_SEARCH_MODEL,
} from "./xiaomi-mimo-chat-search";

const PRIVATE_QUERY = "PRIVATE_HTTP_QUERY";
const PRIVATE_PROVIDER_BODY = "PRIVATE_PROVIDER_ERROR_BODY";
const FIXTURE_BASE_URL = "https://api.xiaomimimo.com/v1";
const FIXTURE_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";

/** 创建按调用返回固定 API Key 的 CredentialStore 测试替身。 */
function createCredentialStore(apiKey = "fixture-mimo-key"): CredentialStore {
  return {
    /** 返回只在 Adapter 局部使用的固定凭据。 */
    async resolve() {
      return { apiKey };
    },
  };
}

/** 创建 JSON Response，避免测试依赖真实 MiMo 网络。 */
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
  return createXiaomiMiMoChatWebSearchCapability({
    credentialRef: { provider: "xiaomi-mimo", key: "SEARCH" },
    credentialStore: createCredentialStore(),
    baseUrl: FIXTURE_BASE_URL,
    model,
    fetch: fetchImplementation,
  });
}

/** 创建包含官方 web_search 用量与可选引用的完成态 Chat Completions fixture。 */
function createCompletionFixture(message: Record<string, unknown>, toolUsage = 3): Record<string, unknown> {
  return {
    id: "fixture-completion",
    object: "chat.completion",
    model: XIAOMI_MIMO_CHAT_SEARCH_MODEL,
    choices: [{ finish_reason: "stop", index: 0, message }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, web_search_usage: { tool_usage: toolUsage, page_usage: toolUsage } },
  };
}

/** 验证最小请求不会携带主 Agent tools、消息或内部状态。 */
describe("Xiaomi MiMo Chat Search Adapter", function xiaomiMiMoChatSearchSuite() {
  /** 固定 endpoint、mimo-v2.5 模型和唯一 web_search server tool，并解析候选 URL citation。 */
  it("发送固定最小请求并归一化 answer 与 sources", async function sendsFixedRequestAndNormalizesResult() {
    const fetchMock = vi.fn(
      /** 返回含一个候选引用的完成态 Chat Completions fixture。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse(createCompletionFixture({
          role: "assistant",
          content: "PUBLIC_ANSWER",
          annotations: [{ type: "url_citation", title: "Fixture source", url: "https://example.com/source" }],
        }));
      },
    );
    const result = await createSearchCapability(fetchMock as typeof fetch).search({ query: PRIVATE_QUERY });
    const requestBody = getFirstRequestBody(fetchMock);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(FIXTURE_ENDPOINT);
    expect(requestInit.method).toBe("POST");
    expect(requestBody).toEqual({
      model: XIAOMI_MIMO_CHAT_SEARCH_MODEL,
      messages: [
        { role: "system", content: expect.stringContaining("当前日期（UTC）") },
        { role: "user", content: PRIVATE_QUERY },
      ],
      stream: false,
      thinking: { type: "disabled" },
      tools: [{ type: "web_search", max_keyword: 3, force_search: true }],
    });
    expect(requestBody).not.toHaveProperty("input");
    expect(requestBody).not.toHaveProperty("checkpoint");
    expect(requestBody).not.toHaveProperty("memory");
    expect(requestBody).not.toHaveProperty("rag");
    expect(result).toEqual({
      answer: "PUBLIC_ANSWER",
      sources: [{ title: "Fixture source", url: "https://example.com/source" }],
      truncated: false,
    });
  });

  /** 宿主只能声明 mimo-v2.5，不允许切换 Search 模型。 */
  it("只接受固定模型声明并拒绝其他 Search 模型", async function acceptsOnlyFixedSearchModel() {
    const fetchMock = vi.fn(
      /** 返回无引用的完成态响应。 */
      async function fakeCompletedResponse(): Promise<Response> {
        return createJsonResponse(createCompletionFixture({ role: "assistant", content: "ANSWER", annotations: [] }));
      },
    );

    await createSearchCapability(fetchMock as typeof fetch, XIAOMI_MIMO_CHAT_SEARCH_MODEL).search({ query: "public" });

    expect(getFirstRequestBody(fetchMock)).toMatchObject({ model: XIAOMI_MIMO_CHAT_SEARCH_MODEL });
    expect(() => createSearchCapability(fetchMock as typeof fetch, "mimo-v2.5-pro")).toThrow("WEB_SEARCH_MODEL_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** 非小米供应商引用在创建期即被拒绝，不发任何网络请求。 */
  it("拒绝非 xiaomi-mimo 的凭据引用", function rejectsForeignCredentialRef() {
    const fetchMock = vi.fn();
    expect(() => createXiaomiMiMoChatWebSearchCapability({
      credentialRef: { provider: "deepseek", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      fetch: fetchMock as typeof fetch,
    })).toThrow("WEB_SEARCH_CREDENTIAL_REF_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** 无引用仍返回答案；未知 item 与 annotation 必须安全忽略。 */
  it("接受无引用答案并忽略未知响应项", async function acceptsAnswerWithoutCitations() {
    /** 返回未知结构与有效 content 混合的响应。 */
    async function fetchUnknownItems(): Promise<Response> {
      return createJsonResponse({
        ...createCompletionFixture({
          role: "assistant",
          content: "NO_SOURCE_ANSWER",
          annotations: [{ type: "future_annotation", value: PRIVATE_PROVIDER_BODY }],
          future_field: PRIVATE_PROVIDER_BODY,
        }),
        future_top_level: PRIVATE_PROVIDER_BODY,
      });
    }

    await expect(createSearchCapability(fetchUnknownItems as typeof fetch).search({ query: "public" })).resolves.toEqual({
      answer: "NO_SOURCE_ANSWER",
      sources: [],
      truncated: false,
    });
  });

  /** 没有官方 web_search_usage 搜索证据时保守失败，不把模型记忆当作搜索结果。 */
  it("拒绝未执行搜索的响应", async function rejectsMissingSearchEvidence() {
    /** 返回不含 web_search_usage 的完成态响应。 */
    async function fetchWithoutSearchUsage(): Promise<Response> {
      return createJsonResponse({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "仅有模型记忆" } }], usage: { total_tokens: 1 } });
    }
    /** 返回 web_search_usage 计数为零的响应。 */
    async function fetchZeroToolUsage(): Promise<Response> {
      return createJsonResponse(createCompletionFixture({ role: "assistant", content: "回答" }, 0));
    }

    await expect(createSearchCapability(fetchWithoutSearchUsage as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_NOT_PERFORMED");
    await expect(createSearchCapability(fetchZeroToolUsage as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_NOT_PERFORMED");
  });

  /** 重复 URL 去重，非法 URL 丢弃，超过十条来源时明确标记截断。 */
  it("去重来源并拒绝非法或超量 URL", async function filtersAndBoundsSources() {
    const annotations: Array<Record<string, unknown>> = [
      { type: "url_citation", title: "valid", url: "https://example.com/source" },
      { type: "url_citation", title: "duplicate", url: "https://example.com/source" },
      { type: "url_citation", title: "invalid", url: "file:///private/source" },
    ];
    for (let index = 0; index < 12; index++) annotations.push({ type: "url_citation", title: `source-${index}`, url: `https://source-${index}.example/item` });
    /** 返回包含重复、非法与超量引用的响应。 */
    async function fetchManySources(): Promise<Response> {
      return createJsonResponse(createCompletionFixture({ role: "assistant", content: "ANSWER", annotations }));
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

  /** 非 JSON、非完成态与空回答都以固定本地错误失败，不透传原始正文。 */
  it("拒绝畸形 JSON 与非完成态响应", async function rejectsMalformedResponses() {
    /** 返回无法解析的 JSON 正文。 */
    async function fetchMalformedJson(): Promise<Response> {
      return new Response(`{${PRIVATE_PROVIDER_BODY}`, { status: 200 });
    }
    /** 返回非 Chat Completions 对象形状的响应。 */
    async function fetchForeignShape(): Promise<Response> {
      return createJsonResponse({ object: "response", status: "completed" });
    }
    /** 返回未正常结束（长度截断）的响应，验证 Adapter 不把部分结果当作成功。 */
    async function fetchLengthCapped(): Promise<Response> {
      return createJsonResponse({ ...createCompletionFixture({ role: "assistant", content: "被截断的回答" }), choices: [{ finish_reason: "length", message: { role: "assistant", content: "被截断的回答" } }] });
    }
    /** 返回空回答的响应。 */
    async function fetchEmptyContent(): Promise<Response> {
      return createJsonResponse(createCompletionFixture({ role: "assistant", content: "  " }));
    }

    await expect(createSearchCapability(fetchMalformedJson as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchForeignShape as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchLengthCapped as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchEmptyContent as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
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

    await expect(probeXiaomiMiMoChatSearchConnectivity(FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(FIXTURE_ENDPOINT, expect.objectContaining({ method: "HEAD", redirect: "manual" }));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("body");
    await expect(probeXiaomiMiMoChatSearchConnectivity(FIXTURE_BASE_URL, createStatusFetch(500))).resolves.toBe("server_error");
  });
});

/** 验证 provider 选择边界把 xiaomi-mimo 路由到 MiMo 适配器，未注册 provider 仍 fail closed。 */
describe("Web search provider routing", function webSearchProviderRoutingSuite() {
  /** xiaomi-mimo 引用创建出可调用能力，未知引用仍返回 undefined 且不发请求。 */
  it("按 provider 路由创建与探测", async function routesProviderSelection() {
    const fetchMock = vi.fn(
      /** 返回可达但不支持 HEAD 的服务响应。 */
      async function fakeReachableEndpoint(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return new Response(null, { status: 404 });
      },
    );
    const capability = createWebSearchProviderCapability({
      credentialRef: { provider: "xiaomi-mimo", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      model: XIAOMI_MIMO_CHAT_SEARCH_MODEL,
      fetch: fetchMock as typeof fetch,
    });
    const unknownCapability = createWebSearchProviderCapability({
      credentialRef: { provider: "unknown-provider", key: "SEARCH" } as never,
      credentialStore: createCredentialStore(),
      baseUrl: FIXTURE_BASE_URL,
      model: XIAOMI_MIMO_CHAT_SEARCH_MODEL,
      fetch: fetchMock as typeof fetch,
    });

    expect(typeof capability?.search).toBe("function");
    expect(unknownCapability).toBeUndefined();
    await expect(probeWebSearchProviderConnectivity("xiaomi-mimo", FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(FIXTURE_ENDPOINT, expect.objectContaining({ method: "HEAD" }));
    await expect(probeWebSearchProviderConnectivity("unknown-provider", FIXTURE_BASE_URL, fetchMock as typeof fetch)).resolves.toBe("unsupported");
  });
});

/** 验证官方默认入口固定官方地址与模型：Search 是内置能力，不接受连接覆盖。 */
describe("Xiaomi MiMo official chat search entry", function xiaomiMiMoOfficialEntrySuite() {
  /** 官方入口固定官方 endpoint 与 mimo-v2.5，请求形状与可配置入口一致。 */
  it("固定官方 endpoint 与模型发送请求", async function sendsFixedOfficialRequest() {
    const fetchMock = vi.fn(
      /** 返回无引用的完成态 Chat Completions fixture。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse(createCompletionFixture({ role: "assistant", content: "OFFICIAL_ANSWER", annotations: [] }));
      },
    );
    const capability = createXiaomiMiMoOfficialChatSearchCapability({
      credentialRef: { provider: "xiaomi-mimo", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      fetch: fetchMock as typeof fetch,
    });
    const result = await capability.search({ query: "public" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(XIAOMI_MIMO_CHAT_SEARCH_ENDPOINT);
    expect(getFirstRequestBody(fetchMock)).toMatchObject({
      model: XIAOMI_MIMO_CHAT_SEARCH_MODEL,
      tools: [{ type: "web_search", max_keyword: 3, force_search: true }],
    });
    expect(result).toEqual({ answer: "OFFICIAL_ANSWER", sources: [], truncated: false });
    expect(() => createXiaomiMiMoOfficialChatSearchCapability({
      credentialRef: { provider: "xiaomi-mimo", key: "SEARCH" },
      credentialStore: createCredentialStore(),
      model: "mimo-v2.5-pro",
      fetch: fetchMock as typeof fetch,
    })).toThrow("WEB_SEARCH_MODEL_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** 官方探测只使用官方 endpoint 的无凭据 HEAD。 */
  it("以无凭据 HEAD 探测官方 endpoint", async function probesOfficialEndpoint() {
    const fetchMock = vi.fn(
      /** 返回可达但不支持 HEAD 的服务响应。 */
      async function fakeReachableEndpoint(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return new Response(null, { status: 404 });
      },
    );

    await expect(probeXiaomiMiMoOfficialChatSearchConnectivity(fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(XIAOMI_MIMO_CHAT_SEARCH_ENDPOINT, expect.objectContaining({ method: "HEAD", redirect: "manual" }));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("body");
    await expect(probeXiaomiMiMoOfficialChatSearchConnectivity(createStatusFetch(500))).resolves.toBe("server_error");
  });
});
