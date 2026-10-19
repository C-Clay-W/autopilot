/**
 * DeepSeek Responses Search Adapter 契约测试：验证固定请求、保守归一化、错误和取消边界。
 */

import { describe, expect, it, vi } from "vitest";
import type { CredentialStore, ResolvedAutopilotSettings } from "@autopilot-agent/core";
import { createNodeCapabilityLoader } from "../../create-node-capability-loader";
import type { NodeSettingsLoader } from "../../settings/node-settings-loader";
import {
  createDeepSeekResponsesSearchCapability,
  DEEPSEEK_RESPONSES_SEARCH_ENDPOINT,
  DEEPSEEK_RESPONSES_SEARCH_MODEL,
  probeDeepSeekResponsesSearchConnectivity,
} from "./deepseek-responses-search";

const PRIVATE_QUERY = "PRIVATE_HTTP_QUERY";
const PRIVATE_PROVIDER_BODY = "PRIVATE_PROVIDER_ERROR_BODY";

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

/** 创建绑定固定 fetch 与可选模型的 Search capability 测试实例。 */
function createSearchCapability(fetchImplementation: typeof fetch, model?: string) {
  return createDeepSeekResponsesSearchCapability({
    credentialRef: { provider: "deepseek", key: "SEARCH" },
    credentialStore: createCredentialStore(),
    model,
    fetch: fetchImplementation,
  });
}

/** 验证最小请求不会携带主 Agent tools、消息或内部状态。 */
describe("DeepSeek Responses Search Adapter", function deepSeekResponsesSearchSuite() {
  /** 固定 endpoint、Flash 模型和唯一 server tool，并解析候选 URL citation。 */
  it("发送固定最小请求并归一化 answer 与 sources", async function sendsFixedRequestAndNormalizesResult() {
    const fetchMock = vi.fn(
      /** 返回含一个候选引用的完成态 Responses fixture。 */
      async function fakeCompletedResponse(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return createJsonResponse({
          object: "response",
          status: "completed",
          output: [
            { type: "web_search_call", id: "search", status: "completed" },
            {
              type: "message",
              content: [{
                type: "output_text",
                text: "PUBLIC_ANSWER",
                annotations: [{ type: "url_citation", title: "Fixture source", url: "https://example.com/source" }],
              }],
            },
          ],
          usage: { total_tokens: 10 },
        });
      },
    );
    const result = await createSearchCapability(fetchMock as typeof fetch).search({ query: PRIVATE_QUERY });
    const requestBody = getFirstRequestBody(fetchMock);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DEEPSEEK_RESPONSES_SEARCH_ENDPOINT);
    expect(requestInit.method).toBe("POST");
    expect(requestBody).toEqual({
      model: DEEPSEEK_RESPONSES_SEARCH_MODEL,
      input: PRIVATE_QUERY,
      instructions: expect.stringContaining("当前日期（UTC）"),
      stream: false,
      reasoning: { effort: "none" },
      tools: [{ type: "web_search" }],
    });
    expect(requestBody).not.toHaveProperty("provider");
    expect(requestBody).not.toHaveProperty("messages");
    expect(requestBody).not.toHaveProperty("checkpoint");
    expect(requestBody).not.toHaveProperty("memory");
    expect(requestBody).not.toHaveProperty("rag");
    expect(result).toEqual({
      answer: "PUBLIC_ANSWER",
      sources: [{ title: "Fixture source", url: "https://example.com/source" }],
      truncated: false,
    });
  });

  /** 宿主只能声明 Flash，不允许切换 Search 模型或继承主问答推理设置。 */
  it("只接受 Flash 声明并拒绝其他 Search 模型", async function acceptsOnlyFlashSearchModel() {
    const fetchMock = vi.fn(
      /** 返回无引用的完成态响应。 */
      async function fakeCompletedResponse(): Promise<Response> {
        return createJsonResponse({ object: "response", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "ANSWER", annotations: [] }] }] });
      },
    );

    await createSearchCapability(fetchMock as typeof fetch, "deepseek-flash").search({ query: "public" });

    expect(getFirstRequestBody(fetchMock)).toMatchObject({ model: "deepseek-flash" });
    expect(() => createSearchCapability(fetchMock as typeof fetch, "deepseek-v4-pro")).toThrow("WEB_SEARCH_MODEL_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** 无引用仍返回答案；未知 item 与 annotation 必须安全忽略。 */
  it("接受无引用答案并忽略未知响应项", async function acceptsAnswerWithoutCitations() {
    /** 返回未知结构与有效 output_text 混合的响应。 */
    async function fetchUnknownItems(): Promise<Response> {
      return createJsonResponse({
        object: "response",
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed" },
          { type: "future_server_tool", private: PRIVATE_PROVIDER_BODY },
          { type: "message", content: [{ type: "output_text", text: "NO_SOURCE_ANSWER", annotations: [{ type: "future_annotation", value: PRIVATE_PROVIDER_BODY }] }] },
        ],
      });
    }

    await expect(createSearchCapability(fetchUnknownItems as typeof fetch).search({ query: "public" })).resolves.toEqual({
      answer: "NO_SOURCE_ANSWER",
      sources: [],
      truncated: false,
    });
  });

  /** 服务端多轮搜索中的旧猜测和引用不能与最终结论混在一起；没有真实搜索动作则失败。 */
  it("只返回最终消息，并拒绝未搜索或最终消息未完成", async function selectsVerifiedFinalMessage() {
    const output: Array<Record<string, unknown>> = [
      { type: "web_search_call", status: "completed" },
      { type: "message", status: "completed", content: [{ type: "output_text", text: "旧猜测", annotations: [{ type: "url_citation", url: "https://old.example/", title: "旧引用" }] }] },
      { type: "web_search_call", status: "completed" },
      { type: "message", status: "completed", content: [{ type: "output_text", text: "最终核查结论", annotations: [{ type: "url_citation", url: "https://current.example/", title: "最终引用" }] }] },
    ];
    const capability = createSearchCapability(async function provideCurrentOutput() { return createJsonResponse({ object: "response", status: "completed", output }); });
    expect(await capability.search({ query: "public" })).toMatchObject({ answer: "最终核查结论", sources: [{ url: "https://current.example/" }] });
    output[3].status = "incomplete";
    await expect(capability.search({ query: "public" })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    output.splice(0, output.length, { type: "message", content: [{ type: "output_text", text: "仅有模型记忆" }] });
    await expect(capability.search({ query: "public" })).rejects.toThrow("WEB_SEARCH_NOT_PERFORMED");
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
      return createJsonResponse({ object: "response", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "ANSWER", annotations }] }] });
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

  /** 非 JSON 与 completed 以外状态都以固定本地错误失败，不透传原始正文。 */
  it("拒绝畸形 JSON 与非完成态响应", async function rejectsMalformedResponses() {
    /** 返回无法解析的 JSON 正文。 */
    async function fetchMalformedJson(): Promise<Response> {
      return new Response(`{${PRIVATE_PROVIDER_BODY}`, { status: 200 });
    }
    /** 返回 failed 状态及不可泄露的 Provider 错误。 */
    async function fetchFailedResponse(): Promise<Response> {
      return createJsonResponse({ object: "response", status: "failed", error: { message: PRIVATE_PROVIDER_BODY }, output: [] });
    }
    /** 返回未完成状态，验证 Adapter 不把部分结果当作成功。 */
    async function fetchIncompleteResponse(): Promise<Response> {
      return createJsonResponse({ object: "response", status: "incomplete", incomplete_details: { reason: "limit" }, output: [] });
    }

    await expect(createSearchCapability(fetchMalformedJson as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchFailedResponse as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
    await expect(createSearchCapability(fetchIncompleteResponse as typeof fetch).search({ query: PRIVATE_QUERY })).rejects.toThrow("WEB_SEARCH_RESPONSE_INVALID");
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

  /** 连通探测只使用官方 endpoint 的无凭据 HEAD，不发送请求正文。 */
  it("以无凭据 HEAD 探测官方 endpoint", async function probesOfficialEndpointWithoutCredentials() {
    const fetchMock = vi.fn(
      /** 返回可达但不支持 HEAD 的服务响应。 */
      async function fakeReachableEndpoint(_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
        return new Response(null, { status: 404 });
      },
    );

    await expect(probeDeepSeekResponsesSearchConnectivity(fetchMock as typeof fetch)).resolves.toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(DEEPSEEK_RESPONSES_SEARCH_ENDPOINT, expect.objectContaining({ method: "HEAD", redirect: "manual" }));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("body");
  });
});

/** 创建带指定主模型标识和固定 Search 引用的安全 settings 快照。 */
function createSettings(modelRef: ResolvedAutopilotSettings["modelRef"]): ResolvedAutopilotSettings {
  return {
    modelRef,
    availableModels: [],
    modelCandidates: [],
    modelOverrides: {},
    rag: {},
    sandbox: { allowedDomains: Object.freeze([]), deniedRead: Object.freeze([]), deniedWrite: Object.freeze([]) },
    permissions: { allow: Object.freeze([]), deny: Object.freeze([]), ask: Object.freeze([]) },
    firstParty: {},
    providerRoutes: {},
    webSearch: { provider: "openai-compatible", baseUrl: "https://responses.fixture/v1", model: "deepseek-v4-flash", credentialRef: { provider: "openai-compatible", key: "SEARCH" } } as any,
    diagnostics: [],
  };
}

/** 创建只返回单份受信快照的 settings loader。 */
function createSettingsLoader(settings: ResolvedAutopilotSettings): NodeSettingsLoader {
  return {
    /** 返回不含真实路径和明文凭据的测试快照。 */
    load() {
      return { paths: { user: "/missing/user-settings.json", project: "/missing/project-settings.json", local: "/missing/local-settings.json" }, settings };
    },
    /** 测试无需热重载，返回空停止函数。 */
    watch() {
      /** 停止函数不持有任何资源。 */
      return function stopWatching() {};
    },
  };
}

/** 验证共享 Node loader 对不同主模型都装配同一个独立 Search route。 */
describe("Node Web capability loader", function nodeWebCapabilityLoaderSuite() {
  /** 两个主模型都不能覆盖宿主注入的 Search 请求模型。 */
  it("保持主模型与 Search 模型隔离", async function isolatesMainModelFromSearchModel() {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(
      /** 记录每个 Search 请求并返回固定完成态。 */
      async function recordSearchRequest(_input: URL | RequestInfo, init?: RequestInit) {
        if (typeof init?.body === "string") requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return createJsonResponse({ object: "response", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "ANSWER", annotations: [] }] }] });
      },
    );
    const mainModels: Array<ResolvedAutopilotSettings["modelRef"]> = [
      { provider: "main-provider-a", modelId: "main-model-a" },
      { provider: "main-provider-b", modelId: "main-model-b" },
    ];
    for (const modelRef of mainModels) {
      const loader = createNodeCapabilityLoader({
        env: { OPENAI_COMPATIBLE_SEARCH: "fixture-search-key" },
        settingsLoader: createSettingsLoader(createSettings(modelRef)),
        webSearchFetch: fetchMock as typeof fetch,
      });
      const web = await loader.loadWeb("/trusted-workspace");
      await web?.search?.search({ query: "public" });
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({ model: "deepseek-v4-flash", tools: [{ type: "web_search" }] });
    expect(requestBodies[1]).toMatchObject({ model: "deepseek-v4-flash", tools: [{ type: "web_search" }] });
  });

  /** 配置缺失或 CredentialStore 无法解析时只隐藏 Search，独立安全 Fetch 仍可用。 */
  it("在 Search 配置或真实凭据缺失时 fail closed", async function hidesUnavailableSearch() {
    const noConfiguration = createNodeCapabilityLoader({ settingsLoader: createSettingsLoader({ ...createSettings(undefined), webSearch: undefined }) });
    const missingCredential = createNodeCapabilityLoader({ env: {}, settingsLoader: createSettingsLoader(createSettings(undefined)) });
    const unsupportedFetch = vi.fn();
    const unsupportedProvider = createNodeCapabilityLoader({
      env: { SEARCH_PROVIDER_SEARCH: "fixture-search-key" },
      settingsLoader: createSettingsLoader({
        ...createSettings(undefined),
        webSearch: { provider: "unsupported", baseUrl: "https://unsupported.fixture", model: "search", credentialRef: { provider: "unsupported", key: "SEARCH" } } as any,
      }),
      webSearchFetch: unsupportedFetch as typeof fetch,
      webSearchConnectivityFetch: unsupportedFetch as typeof fetch,
    });

    const noConfigurationWeb = await noConfiguration.loadWeb("/trusted-workspace");
    const missingCredentialWeb = await missingCredential.loadWeb("/trusted-workspace");
    const unsupportedProviderWeb = await unsupportedProvider.loadWeb("/trusted-workspace");

    expect(noConfigurationWeb).toMatchObject({ fetch: { fetch: expect.any(Function) } });
    expect(missingCredentialWeb).toMatchObject({ fetch: { fetch: expect.any(Function) } });
    expect(unsupportedProviderWeb).toMatchObject({ fetch: { fetch: expect.any(Function) } });
    expect(noConfigurationWeb?.search).toBeUndefined();
    expect(missingCredentialWeb?.search).toBeUndefined();
    expect(unsupportedProviderWeb?.search).toBeUndefined();
    await expect(unsupportedProvider.probeWebSearchConnectivity("/trusted-workspace")).resolves.toBe("unsupported");
    expect(unsupportedFetch).not.toHaveBeenCalled();
  });
});
