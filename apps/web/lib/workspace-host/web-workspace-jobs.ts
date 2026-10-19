/**
 * web-workspace-jobs.ts — Work Session 后台 Job 的 Web Host 安全适配。
 *
 * 本模块校验来源、路径参数和有限游标，只把 Core scoped Job 安全视图投影给浏览器。
 */

import type { JobListView, JobReadView, JobView, SessionJobService } from "@autopilot-agent/core";
import { readHttpErrorCode } from "../runtime-host/web-http-error";
import { runWorkspaceSessionRoute } from "./workspace-session-route";
import { workSessionErrorResponse } from "./work-session-error";

type SessionParams = Promise<{ workspaceId: string; sessionId: string }>;
type JobParams = Promise<{ workspaceId: string; sessionId: string; jobId: string }>;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const CURSOR_LIMIT = 2_048;
const STOP_BODY_LIMIT = 1_024;

/** 输出不缓存的安全 JSON，避免 Job 快照或日志被浏览器缓存复用。 */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE_HEADERS });
}

/** 为所有 Job 失败响应补 no-store，避免浏览器复用过期权限或状态。 */
function failure(code: Parameters<typeof workSessionErrorResponse>[0]): Response {
  const response = workSessionErrorResponse(code);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** 判断请求 URL 是否属于允许无 Origin 的本机回环 Host。 */
function isLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** 校验浏览器来源；写操作必须显式同源，读操作缺 Origin 时只允许回环 Host。 */
export function validateWorkJobRequestSource(request: Request, mutation: boolean): Response | undefined {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (origin === "null" || fetchSite === "cross-site") return failure("WORK_REQUEST_ORIGIN_INVALID");
  if (origin) {
    try {
      // Next 开发宿主可能把 request.url 规范成 localhost；仅对同端口回环 Host 恢复浏览器真实 origin。
      let expectedOrigin = requestUrl.origin;
      const host = request.headers.get("host");
      if (host && host !== requestUrl.host) {
        const actualUrl = new URL(`${requestUrl.protocol}//${host}`);
        if (!isLoopbackUrl(requestUrl) || !isLoopbackUrl(actualUrl) || actualUrl.port !== requestUrl.port || actualUrl.host !== host) return failure("WORK_REQUEST_ORIGIN_INVALID");
        expectedOrigin = actualUrl.origin;
      }
      if (new URL(origin).origin !== expectedOrigin) return failure("WORK_REQUEST_ORIGIN_INVALID");
    } catch {
      return failure("WORK_REQUEST_ORIGIN_INVALID");
    }
  } else if (mutation || !isLoopbackUrl(requestUrl)) {
    return failure("WORK_REQUEST_ORIGIN_INVALID");
  }
  return undefined;
}

/** 只接受 URL 安全标识，防止路径片段、控制字符和超长值进入 Core。 */
function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** 只接受有限不透明 cursor；内容真实性继续由 Core 签名或版本校验。 */
function readCursor(value: string | null): string | undefined | null {
  if (value === null) return undefined;
  return value.length > 0 && value.length <= CURSOR_LIMIT && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** 把 Core Job 错误收敛到 Web 稳定错误码，不透传底层 message。 */
function toJobErrorResponse(error: unknown): Response | undefined {
  const code = readHttpErrorCode(error);
  if (code === "INVALID_INPUT") return failure("JOB_INPUT_INVALID");
  const known = [
    "JOB_CURSOR_INVALID",
    "JOB_NOT_FOUND",
    "JOB_OWNER_UNAVAILABLE",
    "JOB_OWNER_UNKNOWN",
    "JOB_STATE_CONFLICT",
    "SESSION_HAS_ACTIVE_JOBS",
    "JOB_STOP_TIMEOUT",
    "JOB_STOP_FAILED",
    "JOB_STORAGE_FAILED",
  ] as const;
  return code && (known as readonly string[]).includes(code)
    ? failure(code as (typeof known)[number])
    : undefined;
}

/** 在已固定的 Work Session 上调用 scoped Job 服务，并统一安全错误与 no-store 响应。 */
async function runJobAction<T>(
  request: Request,
  params: SessionParams,
  mutation: boolean,
  action: (jobs: SessionJobService) => Promise<T>,
): Promise<Response> {
  const sourceFailure = validateWorkJobRequestSource(request, mutation);
  if (sourceFailure) return sourceFailure;
  const response = await runWorkspaceSessionRoute(params, async function invokeJobAction(context, sessionId) {
    try {
      const jobs = context.runtime.jobs.forSession({ workspaceId: context.workspaceRoot, sessionId });
      return json(await action(jobs));
    } catch (error) {
      return toJobErrorResponse(error) ?? failure("WORKSPACE_SESSION_FAILED");
    }
  }, { requireWritable: true });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** 列出当前 Work Session 的有限 Job 摘要。 */
export async function listWebWorkspaceJobs(request: Request, params: SessionParams): Promise<Response> {
  const sourceFailure = validateWorkJobRequestSource(request, false);
  if (sourceFailure) return sourceFailure;
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some(function hasUnknownKey(key) { return key !== "limit" && key !== "pageCursor"; })) {
    return failure("JOB_INPUT_INVALID");
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? undefined : /^\d+$/.test(limitText) ? Number(limitText) : NaN;
  const pageCursor = readCursor(url.searchParams.get("pageCursor"));
  if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) || pageCursor === null) {
    return failure("JOB_INPUT_INVALID");
  }
  return runJobAction<JobListView>(request, params, false, function list(jobs) { return jobs.list({ limit, pageCursor }); });
}

/** 读取当前 Work Session 中单个 Job 的安全摘要。 */
export async function readWebWorkspaceJob(request: Request, params: JobParams): Promise<Response> {
  const sourceFailure = validateWorkJobRequestSource(request, false);
  if (sourceFailure) return sourceFailure;
  const values = await params;
  if (!isOpaqueId(values.jobId) || new URL(request.url).search) return failure("JOB_INPUT_INVALID");
  return runJobAction<JobReadView>(request, Promise.resolve(values), false, function read(jobs) {
    return jobs.read({ jobId: values.jobId, waitMs: 0 });
  }).then(async function onlyJob(response) {
    if (!response.ok) return response;
    const body = await response.json() as JobReadView;
    return json({ job: body.job });
  });
}

/** 读取当前 Work Session 中单个 Job 的有限安全 stdout/stderr 窗口。 */
export async function readWebWorkspaceJobOutput(request: Request, params: JobParams): Promise<Response> {
  const sourceFailure = validateWorkJobRequestSource(request, false);
  if (sourceFailure) return sourceFailure;
  const values = await params;
  const url = new URL(request.url);
  if (!isOpaqueId(values.jobId) || [...url.searchParams.keys()].some(function hasUnknownKey(key) { return key !== "stdoutCursor" && key !== "stderrCursor"; })) {
    return failure("JOB_INPUT_INVALID");
  }
  const stdoutCursor = readCursor(url.searchParams.get("stdoutCursor"));
  const stderrCursor = readCursor(url.searchParams.get("stderrCursor"));
  if (stdoutCursor === null || stderrCursor === null) return failure("JOB_INPUT_INVALID");
  return runJobAction<JobReadView>(request, Promise.resolve(values), false, function readOutput(jobs) {
    return jobs.read({ jobId: values.jobId, stdoutCursor, stderrCursor, waitMs: 0 });
  });
}

/** 校验严格空对象后停止当前 Runtime 持有的 Job，并返回已确认安全终态。 */
export async function stopWebWorkspaceJob(request: Request, params: JobParams): Promise<Response> {
  const sourceFailure = validateWorkJobRequestSource(request, true);
  if (sourceFailure) return sourceFailure;
  const values = await params;
  if (!isOpaqueId(values.jobId)) return failure("JOB_INPUT_INVALID");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure("JOB_INPUT_INVALID");
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > STOP_BODY_LIMIT) return failure("JOB_INPUT_INVALID");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > STOP_BODY_LIMIT) return failure("JOB_INPUT_INVALID");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return failure("JOB_INPUT_INVALID"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return failure("JOB_INPUT_INVALID");
  return runJobAction<JobView>(request, Promise.resolve(values), true, function stop(jobs) {
    return jobs.stop({ jobId: values.jobId, source: "host" });
  }).then(async function wrapJob(response) {
    if (!response.ok) return response;
    return json({ job: await response.json() as JobView });
  });
}
