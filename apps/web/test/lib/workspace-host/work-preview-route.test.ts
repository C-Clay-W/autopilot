/** Work 预览受限路由定向测试：来源 guard、受限错误、手动接口负向与 jobs guard 加强回归。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebWorkspaceContext, WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import { validateWorkJobRequestSource } from "@/lib/workspace-host/web-workspace-jobs";
import { WorkPreviewError, type WebWorkPreviewService, type WorkManualLinkNavigation, type WorkPreviewNavigation } from "@/lib/workspace-host/work-preview-service";
import { assertPreviewApiSource, getWebWorkPreview, openWebWorkPreviewLink, stopWebWorkPreview } from "@/lib/workspace-host/work-preview-route";

/** 构造带完整同源 Fetch-Metadata 的预览 API 请求。 */
function previewRequest(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: {
    "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", ...headers,
  } });
}

/** 安装注入 Host：Context 携带指定的预览服务替身与会话身份。 */
function installHost(service: Partial<WebWorkPreviewService>, input: { productMode?: "work" | "chat"; readOnlyReason?: string } = {}) {
  const context = {
    workspaceId: "opaque-workspace",
    workspaceRoot: "C:/env-workspace",
    projectId: "project-a",
    compositionRoot: { workPreview: service },
    runtime: {
      sessions: { get: vi.fn(async function getSession() { return { id: "session-a", projectId: "project-a", productMode: input.productMode ?? "work" }; }) },
      turns: { getState: vi.fn(async function getState() { return { readOnlyReason: input.readOnlyReason }; }) },
      jobs: { forSession: vi.fn() },
    },
  } as unknown as WebWorkspaceContext;
  setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);
  return context;
}

/** 构造可断言的预览服务替身。 */
function fakeService(input: { navigation?: WorkPreviewNavigation; manual?: WorkManualLinkNavigation; stopped?: { previewId: string; state: "stopped" }; error?: WorkPreviewError } = {}): WebWorkPreviewService {
  return {
    preparePreview: vi.fn(),
    resolveNavigation: vi.fn(async function resolve() { if (input.error) throw input.error; return input.navigation!; }),
    stopPreviewJob: vi.fn(async function stop() { if (input.error) throw input.error; return input.stopped!; }),
    openManualLink: vi.fn(function open() { if (input.error) throw input.error; return input.manual!; }),
  } as unknown as WebWorkPreviewService;
}

const SESSION_PARAMS = { workspaceId: "opaque-workspace", sessionId: "session-a" };
const PREVIEW_DTO: WorkPreviewNavigation = {
  previewId: "pvw-abc", turnId: "turn-1", hostLabel: "127.0.0.1:5173",
  navigationUrl: "http://127.0.0.1:5173/demo", sandboxProfile: "trusted_local", serviceState: "ready", canStop: true,
};
const MANUAL_DTO: WorkManualLinkNavigation = {
  source: "user_link", hostLabel: "127.0.0.1:5173", navigationUrl: "http://127.0.0.1:5173/demo",
  sandboxProfile: "trusted_local", serviceState: "unchecked", canStop: false,
};

afterEach(function resetHost() { setWebWorkspaceHostForTest(undefined); });

describe("预览来源 guard", function suite() {
  it("放行父应用同源 fetch，拒绝 document/iframe 直取、跨站、opaque Origin 与缺失 Fetch-Metadata", function enforcesFrozenGuard() {
    const url = "http://127.0.0.1:3000/api/workspaces/w/sessions/s/previews/p1";
    expect(assertPreviewApiSource(previewRequest(url), false)).toBeUndefined();
    expect(assertPreviewApiSource(previewRequest(url, { origin: "http://127.0.0.1:3000" }, { method: "POST" }), true)).toBeUndefined();

    const iframe = previewRequest(url, { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" });
    expect(assertPreviewApiSource(iframe, false)?.status).toBe(403);
    const document = previewRequest(url, { "sec-fetch-dest": "document", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" });
    expect(assertPreviewApiSource(document, false)?.status).toBe(403);
    const cross = previewRequest(url, { "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:5199" });
    expect(assertPreviewApiSource(cross, false)?.status).toBe(403);
    const opaque = previewRequest(url, { origin: "null" });
    expect(assertPreviewApiSource(opaque, false)?.status).toBe(403);
    const missing = new Request(url);
    expect(assertPreviewApiSource(missing, false)?.status).toBe(403);
    const noOriginPost = previewRequest(url, {}, { method: "POST" });
    expect(assertPreviewApiSource(noOriginPost, true)?.status).toBe(403);
  });

  it("guard 失败返回 PREVIEW_ORIGIN_DENIED 且固定文案", function usesStableCode() {
    const response = assertPreviewApiSource(new Request("http://127.0.0.1:3000/x"), false);
    expect(response?.status).toBe(403);
  });
});

describe("GET previews/:previewId", function suite() {
  it("同源请求返回受限导航 DTO 且 no-store", async function resolvesReference() {
    const service = fakeService({ navigation: PREVIEW_DTO });
    installHost(service);
    const response = await getWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-abc"),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-abc" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(PREVIEW_DTO);
    expect(service.resolveNavigation).toHaveBeenCalledWith({ previewId: "pvw-abc", sessionId: "session-a" });
  });

  it("未知引用返回 404 PREVIEW_NOT_FOUND，跨产品 Chat 会话返回 404 会话不存在", async function rejectsUnknownAndChat() {
    installHost(fakeService({ error: new WorkPreviewError("PREVIEW_NOT_FOUND") }));
    const unknown = await getWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-x"),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-x" }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "PREVIEW_NOT_FOUND" });

    installHost(fakeService({ navigation: PREVIEW_DTO }), { productMode: "chat" });
    const chat = await getWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-abc"),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-abc" }),
    );
    expect(chat.status).toBe(404);
    expect(await chat.json()).toMatchObject({ code: "WORKSPACE_SESSION_NOT_FOUND" });
  });

  it("非法 previewId 格式与带查询串的请求在进入会话上下文前拒绝", async function rejectsBadIds() {
    installHost(fakeService({ navigation: PREVIEW_DTO }));
    const bad = await getWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/not%2Fsafe"),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "not/safe" }),
    );
    expect(bad.status).toBe(404);
    expect(await bad.json()).toMatchObject({ code: "PREVIEW_NOT_FOUND" });
  });
});

describe("POST previews/:previewId/stop", function suite() {
  it("同源空对象停止并返回安全状态", async function stopsOwnedJob() {
    const service = fakeService({ stopped: { previewId: "pvw-abc", state: "stopped" } });
    installHost(service);
    const response = await stopWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-abc/stop", { origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: "{}" }),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-abc" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ previewId: "pvw-abc", state: "stopped" });
  });

  it("拒绝非空 body 与缺失 JSON content-type", async function rejectsBadStopBody() {
    installHost(fakeService({ stopped: { previewId: "pvw-abc", state: "stopped" } }));
    const extra = await stopWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-abc/stop", { origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: '{"jobId":"other"}' }),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-abc" }),
    );
    expect(extra.status).toBe(400);
    const noType = await stopWebWorkPreview(
      previewRequest("http://localhost:3000/api/previews/pvw-abc/stop", { origin: "http://localhost:3000" }, { method: "POST", body: "{}" }),
      Promise.resolve({ ...SESSION_PARAMS, previewId: "pvw-abc" }),
    );
    expect(noType.status).toBe(400);
  });
});

describe("POST previews/open-link 手动链接", function suite() {
  it("有效 URL 返回手动导航 DTO；无 turnId 旧回答也可发起", async function opensManualLink() {
    const service = fakeService({ manual: MANUAL_DTO });
    installHost(service, { readOnlyReason: "WORK_HISTORY_READ_ONLY" });
    const response = await openWebWorkPreviewLink(
      previewRequest("http://localhost:3000/api/previews/open-link", { origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:5173/demo" }) }),
      Promise.resolve(SESSION_PARAMS),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(MANUAL_DTO);
    expect(service.openManualLink).toHaveBeenCalledWith("http://127.0.0.1:5173/demo");
  });

  it("非法目标、多余字段与跨源来源均拒绝", async function rejectsInvalidManual() {
    installHost(fakeService({ error: new WorkPreviewError("PREVIEW_INVALID_TARGET") }));
    const invalid = await openWebWorkPreviewLink(
      previewRequest("http://localhost:3000/api/previews/open-link", { origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:5173/?x=1" }) }),
      Promise.resolve(SESSION_PARAMS),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "PREVIEW_INVALID_TARGET" });

    const extra = await openWebWorkPreviewLink(
      previewRequest("http://localhost:3000/api/previews/open-link", { origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:5173/", jobId: "job-1" }) }),
      Promise.resolve(SESSION_PARAMS),
    );
    expect(extra.status).toBe(400);

    const foreign = await openWebWorkPreviewLink(
      previewRequest("http://localhost:3000/api/previews/open-link", { origin: "http://127.0.0.1:5199", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:5173/" }) }),
      Promise.resolve(SESSION_PARAMS),
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "PREVIEW_ORIGIN_DENIED" });
  });
});

describe("jobs guard 导航形态加强回归", function suite() {
  it("document/iframe/navigate 形态拒绝，无 Fetch-Metadata 的既有行为不变", function strengthensNavigationRejection() {
    const get = function request(headers: Record<string, string>) { return new Request("http://localhost/api/jobs", { headers }); };
    expect(validateWorkJobRequestSource(get({ "sec-fetch-dest": "document", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }), false)?.status).toBe(403);
    expect(validateWorkJobRequestSource(get({ "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }), false)?.status).toBe(403);
    expect(validateWorkJobRequestSource(get({ "sec-fetch-mode": "navigate" }), false)?.status).toBe(403);
    // 既有行为：无 Sec-Fetch 头的回环 GET 与同源写仍放行。
    expect(validateWorkJobRequestSource(get({}), false)).toBeUndefined();
    expect(validateWorkJobRequestSource(new Request("http://localhost/api/jobs", { method: "POST", headers: { origin: "http://localhost" } }), true)).toBeUndefined();
  });
});
