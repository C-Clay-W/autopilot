/**
 * web-workspace-server.ts — Web Workspace Host 的服务器单例与安全错误映射。
 *
 * Route 只能从这里取得 Host；本机 chooser 的调用仍需每次请求确认回环来源。
 */

import { findWorkSessionErrorResponse } from "./work-session-error";
import { NextResponse } from "next/server";
import { createWebWorkspaceHost, WebWorkspaceHostError, type WebWorkspaceHost } from "./web-workspace-host";

const WORKSPACE_HOST_ERROR_CODES = [
  "DIRECTORY_PICKER_UNAVAILABLE",
  "DIRECTORY_PICKER_BUSY",
  "DIRECTORY_SELECTION_EXPIRED",
  "DIRECTORY_INVALID",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_TRUSTED",
  "TRUST_CHALLENGE_EXPIRED",
] as const;

type WorkspaceHostErrorCode = (typeof WORKSPACE_HOST_ERROR_CODES)[number];

/** 将允许公开的 Host 错误码映射为固定文案，避免透传底层异常内容。 */
const WORKSPACE_HOST_ERROR_MESSAGES: Record<WorkspaceHostErrorCode, string> = {
  DIRECTORY_PICKER_UNAVAILABLE: "无法打开本机目录选择器",
  DIRECTORY_PICKER_BUSY: "目录选择正在进行",
  DIRECTORY_SELECTION_EXPIRED: "目录选择已过期，请重新选择",
  DIRECTORY_INVALID: "所选目录不可用",
  WORKSPACE_NOT_FOUND: "工作区不存在",
  WORKSPACE_NOT_TRUSTED: "工作区尚未获得信任",
  TRUST_CHALLENGE_EXPIRED: "信任确认已过期，请重新选择",
};

/** 开发态 Route 热重载会重执行模块；Host 状态必须绑定进程而非模块实例。 */
const WEB_WORKSPACE_HOST_KEY = "__autopilotWebWorkspaceHost__";
type WebWorkspaceHostGlobal = typeof globalThis & { [WEB_WORKSPACE_HOST_KEY]?: WebWorkspaceHost };

/** 返回保存 Web Host 跨模块热更新状态的全局对象。 */
function getWebWorkspaceHostGlobal(): WebWorkspaceHostGlobal {
  return globalThis as WebWorkspaceHostGlobal;
}

/** 获取进程内唯一的 Workspace Host，令牌与 Runtime 缓存不会在 Route 间丢失。 */
export function getWebWorkspaceHost(): WebWorkspaceHost {
  const hostGlobal = getWebWorkspaceHostGlobal();
  if (!hostGlobal[WEB_WORKSPACE_HOST_KEY]) hostGlobal[WEB_WORKSPACE_HOST_KEY] = createWebWorkspaceHost({ nativeDirectorySelectionEnabled: true });
  return hostGlobal[WEB_WORKSPACE_HOST_KEY];
}

/** 仅允许回环请求调用服务器本机的原生目录选择器。 */
export function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** 读取白名单 Host 错误码，兼容开发态热更新前后不同模块实例创建的异常。 */
function readWorkspaceHostErrorCode(error: unknown): WorkspaceHostErrorCode | undefined {
  const candidate = error instanceof WebWorkspaceHostError
    ? error.code
    : error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof candidate === "string" && (WORKSPACE_HOST_ERROR_CODES as readonly string[]).includes(candidate)
    ? candidate as WorkspaceHostErrorCode
    : undefined;
}

/** 将 Host 与归属错误收敛为稳定、不含路径的 HTTP DTO。 */
export function toWorkspaceErrorResponse(error: unknown): Response {
  const hostErrorCode = readWorkspaceHostErrorCode(error);
  if (hostErrorCode) {
    const status = hostErrorCode === "WORKSPACE_NOT_TRUSTED" ? 403
      : hostErrorCode === "WORKSPACE_NOT_FOUND" ? 404
        : hostErrorCode === "DIRECTORY_PICKER_BUSY" || hostErrorCode === "DIRECTORY_PICKER_UNAVAILABLE" ? 409
          : hostErrorCode === "DIRECTORY_SELECTION_EXPIRED" || hostErrorCode === "TRUST_CHALLENGE_EXPIRED" ? 409
            : 400;
    return NextResponse.json({ error: WORKSPACE_HOST_ERROR_MESSAGES[hostErrorCode], code: hostErrorCode }, { status });
  }
  if (error instanceof WebWorkspaceSessionError) {
    return NextResponse.json({ error: "会话不存在或不属于当前工作区", code: error.code }, { status: 404 });
  }
  const sessionError = findWorkSessionErrorResponse(error);
  if (sessionError) return sessionError;
  return NextResponse.json({ error: "工作区服务发生内部错误", code: "WORKSPACE_INTERNAL_ERROR" }, { status: 500 });
}

/** 重置单例只供定向测试注入 Host，生产 Route 不调用。 */
export function setWebWorkspaceHostForTest(host: WebWorkspaceHost | undefined): void {
  getWebWorkspaceHostGlobal()[WEB_WORKSPACE_HOST_KEY] = host;
}

/** 由统一 helper 抛出的跨工作区会话归属错误。 */
export class WebWorkspaceSessionError extends Error {
  constructor(public readonly code: "WORKSPACE_SESSION_NOT_FOUND") {
    super("会话不存在或不属于当前工作区");
    this.name = "WebWorkspaceSessionError";
  }
}
