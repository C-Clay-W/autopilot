/**
 * work-preview-route.ts — Work 内置预览受限 API 的路由层。
 *
 * 覆盖工具引用（GET 解析 / stop）与用户手动 open-link 两个来源；统一执行冻结的严格来源
 * guard（Sec-Fetch 齐全且 dest=empty、site=same-origin，拒绝内嵌页 document/iframe 直取与
 * opaque Origin）、no-store 与固定安全错误映射。不提供 URL 抓取、代理或转发。
 */

import { runWorkspaceSessionRoute } from "./workspace-session-route";
import { workSessionErrorResponse } from "./work-session-error";
import { expectedRequestOrigin, isLoopbackHost } from "./request-source-origin";
import { WorkPreviewError, type WebWorkPreviewService, type WorkManualLinkNavigation, type WorkPreviewNavigation } from "./work-preview-service";

type SessionParams = Promise<{ workspaceId: string; sessionId: string }>;
type PreviewParams = Promise<{ workspaceId: string; sessionId: string; previewId: string }>;

/** 输出不缓存的安全 JSON；导航 DTO 与停止状态都禁止浏览器缓存复用。 */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** 为预览失败响应补 no-store，避免过期授权或状态被复用。 */
function previewFailure(code: Parameters<typeof workSessionErrorResponse>[0]): Response {
  const response = workSessionErrorResponse(code);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** WorkPreviewError 映射到白名单错误；其余异常收敛为通用 500，不透传底层细节。 */
function toPreviewErrorResponse(error: unknown): Response | undefined {
  return error instanceof WorkPreviewError ? previewFailure(error.code) : undefined;
}

/** 校验预览 API 请求来源：只允许父应用同源 fetch，拒绝内嵌页导航直取与 opaque Origin。 */
export function assertPreviewApiSource(request: Request, mutation: boolean): Response | undefined {
  // 浏览器保证且不可伪造的 Fetch-Metadata 是区分父应用 fetch 与内嵌页 document/iframe 直取的唯一依据。
  const dest = request.headers.get("sec-fetch-dest")?.toLowerCase();
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  const mode = request.headers.get("sec-fetch-mode")?.toLowerCase();
  if (!dest || !site || !mode) return previewFailure("PREVIEW_ORIGIN_DENIED");
  if (dest !== "empty") return previewFailure("PREVIEW_ORIGIN_DENIED");
  if (site !== "same-origin") return previewFailure("PREVIEW_ORIGIN_DENIED");
  if (mode !== "cors" && mode !== "same-origin") return previewFailure("PREVIEW_ORIGIN_DENIED");
  const origin = request.headers.get("origin");
  if (origin === "null") return previewFailure("PREVIEW_ORIGIN_DENIED");
  const requestUrl = new URL(request.url);
  const expected = expectedRequestOrigin(requestUrl, request.headers.get("host"));
  if (!expected) return previewFailure("PREVIEW_ORIGIN_DENIED");
  if (origin) {
    try {
      if (new URL(origin).origin !== expected) return previewFailure("PREVIEW_ORIGIN_DENIED");
    } catch {
      return previewFailure("PREVIEW_ORIGIN_DENIED");
    }
  } else if (mutation || !isLoopbackHost(requestUrl.hostname)) {
    // 同源变更请求必带 Origin；无 Origin 的 GET 仅允许本机回环目标。
    return previewFailure("PREVIEW_ORIGIN_DENIED");
  }
  return undefined;
}

/** 判断 previewId 是否为 URL 安全的不透明标识；非法格式按不存在处理，不泄露存在性。 */
function isOpaquePreviewId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** 在已固定的 Work Session 上调用预览服务，并统一 guard、安全错误与 no-store。 */
async function runPreviewAction<T>(
  request: Request,
  params: SessionParams,
  input: { mutation: boolean; requireWritable: boolean },
  action: (service: WebWorkPreviewService, sessionId: string) => Promise<T>,
): Promise<Response> {
  const sourceFailure = assertPreviewApiSource(request, input.mutation);
  if (sourceFailure) return sourceFailure;
  const response = await runWorkspaceSessionRoute(params, async function invokePreviewAction(context, sessionId) {
    try {
      return json(await action(context.compositionRoot.workPreview, sessionId));
    } catch (error) {
      return toPreviewErrorResponse(error) ?? previewFailure("WORKSPACE_SESSION_FAILED");
    }
  }, { requireWritable: input.requireWritable });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** 解析工具交付预览引用并返回受限导航 DTO；只读操作，历史渲染/复制不调用。 */
export async function getWebWorkPreview(request: Request, params: PreviewParams): Promise<Response> {
  const values = await params;
  if (!isOpaquePreviewId(values.previewId) || new URL(request.url).search) return previewFailure("PREVIEW_NOT_FOUND");
  return runPreviewAction(request, Promise.resolve(values), { mutation: false, requireWritable: false }, function resolve(service, sessionId) {
    return service.resolveNavigation({ previewId: values.previewId, sessionId });
  });
}

/** 停止引用拥有的受管 Job；只接受严格空对象，不接受 jobId/PID/命令。 */
export async function stopWebWorkPreview(request: Request, params: PreviewParams): Promise<Response> {
  const values = await params;
  if (!isOpaquePreviewId(values.previewId)) return previewFailure("PREVIEW_NOT_FOUND");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return previewFailure("PREVIEW_INVALID_TARGET");
  const text = await request.text();
  if (text.length > 64) return previewFailure("PREVIEW_INVALID_TARGET");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return previewFailure("PREVIEW_INVALID_TARGET"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return previewFailure("PREVIEW_INVALID_TARGET");
  }
  return runPreviewAction(request, Promise.resolve(values), { mutation: true, requireWritable: true }, function stop(service, sessionId) {
    return service.stopPreviewJob({ previewId: values.previewId, sessionId });
  });
}

/** 手动链接校验：Work 弹窗明确点击的 POST；只校验返回导航 DTO，不服务端探测目标。 */
export async function openWebWorkPreviewLink(request: Request, params: SessionParams): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return previewFailure("PREVIEW_INVALID_TARGET");
  const text = await request.text();
  if (text.length > 4_096) return previewFailure("PREVIEW_INVALID_TARGET");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return previewFailure("PREVIEW_INVALID_TARGET"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return previewFailure("PREVIEW_INVALID_TARGET");
  const keys = Object.keys(body as Record<string, unknown>);
  const url = (body as Record<string, unknown>).url;
  if (keys.length !== 1 || keys[0] !== "url" || typeof url !== "string" || url.length === 0 || url.length > 2_048) {
    return previewFailure("PREVIEW_INVALID_TARGET");
  }
  return runPreviewAction(request, params, { mutation: true, requireWritable: false }, async function openLink(service) {
    return service.openManualLink(url);
  });
}

/** 导航 DTO 响应的专用包装；仅为类型可读性保留导出。 */
export type { WorkPreviewNavigation, WorkManualLinkNavigation };
