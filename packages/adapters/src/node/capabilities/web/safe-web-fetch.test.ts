/**
 * 安全 Web Fetch Adapter 契约测试：使用本地 HTTP 服务器和受控 DNS 验证 SSRF、重定向与正文硬门。
 */

import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSafeWebFetchCapability, type WebFetchHttpClient, type WebFetchHttpRequest } from "./safe-web-fetch";
import { validatePublicWebUrl, type WebFetchDnsResolver } from "./url-policy";

const PUBLIC_ADDRESS = { address: "8.8.8.8", family: 4 as const };
let server: http.Server;
let serverPort = 0;

/** 为所有用例提供完全本地、无外网依赖的响应与重定向 fixture。 */
function handleFixtureRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
  if (requestUrl.pathname === "/html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title> Fixture &amp; Title </title><style>.hidden{}</style><script>PRIVATE_SCRIPT</script></head><body><nav>Menu</nav><main><h1>Public heading</h1><p>First &amp; second.</p><iframe>PRIVATE_FRAME</iframe></main></body></html>");
    return;
  }
  if (requestUrl.pathname === "/same-redirect" || requestUrl.pathname === "/rebinding") {
    response.writeHead(302, { location: "/html" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/cross-redirect") {
    response.writeHead(302, { location: "http://other.example.com/html?private=hidden" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/loop") {
    response.writeHead(302, { location: "/loop" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/chain") {
    const remaining = Number(requestUrl.searchParams.get("remaining"));
    response.writeHead(302, { location: remaining > 1 ? `/chain?remaining=${remaining - 1}` : "/html" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/gzip") {
    const body = gzipSync(Buffer.from("压".repeat(120_000), "utf8"));
    response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": body.length });
    response.end(body);
    return;
  }
  if (requestUrl.pathname === "/gzip-bomb" || requestUrl.pathname === "/gzip-medium") {
    const size = requestUrl.pathname === "/gzip-bomb" ? 10 * 1024 * 1024 + 1 : 3 * 1024 * 1024;
    const body = gzipSync(Buffer.alloc(size, 97));
    response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": body.length });
    response.end(body);
    return;
  }
  if (requestUrl.pathname === "/raw-large") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(Buffer.alloc(10 * 1024 * 1024 + 1, 98));
    return;
  }
  if (requestUrl.pathname === "/unsupported") {
    response.writeHead(200, { "content-type": "image/png", "content-disposition": "attachment; filename=image.png" });
    response.end("PRIVATE_BINARY");
    return;
  }
  if (requestUrl.pathname === "/json") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end('{"status":"ok"}');
    return;
  }
  if (requestUrl.pathname === "/slow") return;
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

/** 启动只监听 loopback 的本地 fixture；生产 URL 始终由受控 DNS 映射为虚拟公网地址。 */
beforeAll(async function startFixtureServer() {
  server = http.createServer(handleFixtureRequest);
  await new Promise<void>(
    /** 等待随机端口完成监听。 */
    function waitForListening(resolve, reject) {
      /** 将 server 启动错误交给测试框架。 */
      function rejectServer(error: Error): void { reject(error); }
      /** 监听成功后移除临时错误监听并结束等待。 */
      function resolveListening(): void {
        server.removeListener("error", rejectServer);
        resolve();
      }
      server.once("error", rejectServer);
      server.listen(0, "127.0.0.1", resolveListening);
    },
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  serverPort = address.port;
});

/** 关闭 fixture 的活动连接，避免取消用例留下句柄。 */
afterAll(async function stopFixtureServer() {
  server.closeAllConnections();
  await new Promise<void>(
    /** 等待本地 HTTP server 完整释放端口。 */
    function waitForClose(resolve, reject) {
      /** 关闭完成后把结果交回测试框架。 */
      function resolveClose(error?: Error): void {
        if (error) reject(error);
        else resolve();
      }
      server.close(resolveClose);
    },
  );
});

/** 始终把公开 fixture hostname 解析为一个虚拟公网地址。 */
async function resolveFixtureDns(): Promise<readonly [typeof PUBLIC_ADDRESS]> {
  return [PUBLIC_ADDRESS];
}

/** 创建只在测试中把已校验请求转接到 loopback fixture 的 HTTP 客户端。 */
function createLocalHttpClient(requests: WebFetchHttpRequest[] = []): WebFetchHttpClient {
  /** 保留 Adapter 选择的钉住地址，同时把字节传输限定在本地测试服务器。 */
  function requestLocalFixture(input: WebFetchHttpRequest) {
    requests.push(input);
    return new Promise<Awaited<ReturnType<WebFetchHttpClient>>>(
      /** 建立本地 socket，并保留原目标 host/path 供 fixture 路由。 */
      function waitForFixtureResponse(resolve, reject) {
        /** 将 fixture 响应适配为待测边界。 */
        function resolveFixtureResponse(fixtureResponse: http.IncomingMessage): void {
          resolve({
            statusCode: fixtureResponse.statusCode ?? 0,
            headers: fixtureResponse.headers,
            body: fixtureResponse,
            /** 测试响应终止时同时关闭 socket 和响应流。 */
            abort() {
              fixtureResponse.destroy();
              fixtureRequest.destroy();
            },
          });
        }
        /** 将 fixture 请求失败交回测试框架。 */
        function rejectFixtureRequest(error: Error): void { reject(error); }
        const fixtureRequest = http.request({
          hostname: "127.0.0.1",
          port: serverPort,
          path: `${input.url.pathname}${input.url.search}`,
          method: "GET",
          signal: input.signal,
          headers: { host: input.url.host },
        }, resolveFixtureResponse);
        fixtureRequest.once("error", rejectFixtureRequest);
        fixtureRequest.end();
      },
    );
  }
  return requestLocalFixture;
}

/** URL policy 的协议、地址族与 DNS 结果契约。 */
describe("Web Fetch URL policy", function webFetchUrlPolicySuite() {
  /** literal 与 DNS 结果只要命中任一非公网范围就必须整体拒绝。 */
  it("拒绝协议、userinfo、loopback、私网、metadata 与混合 DNS 结果", async function blocksSsrfTargets() {
    const blocked = [
      "file:///etc/passwd",
      "https://user:secret@public.example.com/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.88.99.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2001:db8::1]/",
      "http://metadata.google.internal/",
    ];
    for (const url of blocked) await expect(validatePublicWebUrl(url, { resolveDns: resolveFixtureDns })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });

    /** 模拟同一 hostname 同时返回公网与私网地址。 */
    const mixedResolver: WebFetchDnsResolver = async function resolveMixedDns() {
      return [PUBLIC_ADDRESS, { address: "10.0.0.8", family: 4 }];
    };
    await expect(validatePublicWebUrl("https://public.example.com/", { resolveDns: mixedResolver })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    /** 模拟 resolver 错报地址族，验证策略 fail closed。 */
    const mismatchedResolver: WebFetchDnsResolver = async function resolveMismatchedDns() {
      return [{ address: "::1", family: 4 }];
    };
    await expect(validatePublicWebUrl("https://public.example.com/", { resolveDns: mismatchedResolver })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
  });

  /** 公网 DNS 结果必须原样返回给连接层，不能在校验后再按 hostname 连接。 */
  it("返回规范化 URL 与全部已校验公网地址", async function returnsPinnedPublicAddresses() {
    await expect(validatePublicWebUrl("https://public.example.com/path", { resolveDns: resolveFixtureDns })).resolves.toMatchObject({
      url: new URL("https://public.example.com/path"),
      addresses: [PUBLIC_ADDRESS],
    });
  });
});

/** 安全 Fetch 的逐跳连接、正文门禁、提取与取消契约。 */
describe("Safe Web Fetch capability", function safeWebFetchSuite() {
  /** HTML 必须通过 DOM 解析，脚本与嵌入节点不会进入模型可见正文。 */
  it("提取 HTML 标题和结构文本且钉住已校验地址", async function extractsBoundedHtml() {
    const requests: WebFetchHttpRequest[] = [];
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient(requests) });

    const result = await capability.fetch({ url: "http://public.example.com/html" });

    expect(result).toMatchObject({
      url: "http://public.example.com/html",
      finalUrl: "http://public.example.com/html",
      title: "Fixture & Title",
      contentType: "text/html",
      truncated: false,
    });
    expect(result.content).toContain("Public heading");
    expect(result.content).toContain("First & second.");
    expect(result.content).not.toContain("PRIVATE_SCRIPT");
    expect(result.content).not.toContain("PRIVATE_FRAME");
    expect(requests[0]?.address).toEqual(PUBLIC_ADDRESS);
  });

  /** 同域重定向每一跳都重新解析 DNS，且最多只使用已校验地址连接。 */
  it("重新校验并跟随同域重定向", async function followsValidatedSameHostRedirect() {
    const resolver = vi.fn(resolveFixtureDns);
    const requests: WebFetchHttpRequest[] = [];
    const capability = createSafeWebFetchCapability({ resolveDns: resolver, request: createLocalHttpClient(requests) });

    const result = await capability.fetch({ url: "http://public.example.com/same-redirect" });

    expect(result.finalUrl).toBe("http://public.example.com/html");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });

  /** 跨域 Location 即使解析为公网也不能复用原域授权继续发送请求。 */
  it("跨域重定向要求新的域名审批", async function blocksCrossHostRedirect() {
    const requests: WebFetchHttpRequest[] = [];
    const resolver = vi.fn(resolveFixtureDns);
    const capability = createSafeWebFetchCapability({ resolveDns: resolver, request: createLocalHttpClient(requests) });

    await expect(capability.fetch({ url: "http://public.example.com/cross-redirect" })).rejects.toMatchObject({ code: "WEB_REDIRECT_REQUIRES_APPROVAL" });
    expect(requests).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  /** 同域第二跳若 DNS 从公网变成私网，必须在发出第二次请求前 fail closed。 */
  it("阻止 DNS rebinding", async function blocksDnsRebinding() {
    let resolutionCount = 0;
    /** 首跳返回公网、第二跳返回 loopback，模拟 DNS rebinding。 */
    const resolver: WebFetchDnsResolver = async function resolveRebindingDns() {
      resolutionCount += 1;
      return resolutionCount === 1 ? [PUBLIC_ADDRESS] : [{ address: "127.0.0.1", family: 4 }];
    };
    const requests: WebFetchHttpRequest[] = [];
    const capability = createSafeWebFetchCapability({ resolveDns: resolver, request: createLocalHttpClient(requests) });

    await expect(capability.fetch({ url: "http://public.example.com/rebinding" })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    expect(requests).toHaveLength(1);
  });

  /** 超过十跳不再请求目标，避免无限循环与隐式请求风暴。 */
  it("限制重定向次数", async function limitsRedirectCount() {
    const requests: WebFetchHttpRequest[] = [];
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient(requests) });

    await expect(capability.fetch({ url: "http://public.example.com/loop" })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    expect(requests).toHaveLength(11);
  });

  /** 恰好十跳仍可到达正文，确保 Core 放宽后的预算在 Adapter 中完整可用。 */
  it("允许十跳以内的同域链路", async function followsTenRedirects() {
    const requests: WebFetchHttpRequest[] = [];
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient(requests) });
    await expect(capability.fetch({ url: "http://public.example.com/chain?remaining=10" })).resolves.toMatchObject({ contentType: "text/html", truncated: false });
    expect(requests).toHaveLength(11);
  });

  /** 原先超过 2 MiB 会被拒绝的响应，现在允许读取并按独立文本预算裁剪。 */
  it("接受 3 MiB 解压正文并保留文本裁剪", async function acceptsLargerDecodedBody() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    const result = await capability.fetch({ url: "http://public.example.com/gzip-medium" });
    expect(result.content).toHaveLength(100_000);
    expect(result.truncated).toBe(true);
  });

  /** 合法 gzip 会在解压后应用文本上限，并明确标记模型可见正文被裁剪。 */
  it("有界解压并裁剪文本", async function decompressesWithinBounds() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });

    const result = await capability.fetch({ url: "http://public.example.com/gzip" });

    expect(result.content).toHaveLength(100_000);
    expect(result.truncated).toBe(true);
  });

  /** 小压缩包不得展开为超过 10 MiB 的正文，防止压缩炸弹消耗无界内存。 */
  it("拒绝解压后超限正文", async function blocksCompressionBomb() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    await expect(capability.fetch({ url: "http://public.example.com/gzip-bomb" })).rejects.toMatchObject({ code: "WEB_RESPONSE_TOO_LARGE" });
  });

  /** 未压缩响应超过 10 MiB 时只保留安全前缀，并同时应用模型文本上限。 */
  it("截断未压缩超限正文", async function truncatesLargePlainText() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    const result = await capability.fetch({ url: "http://public.example.com/raw-large" });

    expect(result.content).toHaveLength(100_000);
    expect(result.truncated).toBe(true);
  });

  /** 下载、媒体与未知二进制类型必须在读取正文前拒绝。 */
  it("拒绝不支持的内容类型与附件下载", async function rejectsUnsupportedContent() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    await expect(capability.fetch({ url: "http://public.example.com/unsupported" })).rejects.toMatchObject({ code: "WEB_CONTENT_TYPE_UNSUPPORTED" });
  });

  /** JSON 属于首期允许类型，并保持文本内容而不执行或解释其中字段。 */
  it("读取有界 JSON 文本", async function readsJsonText() {
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    await expect(capability.fetch({ url: "http://public.example.com/json" })).resolves.toMatchObject({
      content: '{"status":"ok"}',
      contentType: "application/json",
      truncated: false,
    });
  });

  /** AbortSignal 必须终止仍在等待响应头的请求，并保留标准取消语义。 */
  it("取消等待中的 HTTP 请求", async function cancelsPendingRequest() {
    const controller = new AbortController();
    const capability = createSafeWebFetchCapability({ resolveDns: resolveFixtureDns, request: createLocalHttpClient() });
    const pending = capability.fetch({ url: "http://public.example.com/slow", signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
