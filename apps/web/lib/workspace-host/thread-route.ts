/**
 * thread-route.ts — 协作 Route 的共享入口
 *
 * 只做三件事：workspace → Trust → Runtime 的归属校验、把人类身份交给 ThreadHost、
 * 将 Core 协作错误映射为固定 HTTP 摘要。领域状态机、授权判定和持久化都在 Core。
 */

import { NextResponse } from "next/server";
import type * as Core from "@autopilot-agent/core";
import type { WebWorkspaceContext } from "./web-workspace-host";
import type { WebThreadHost } from "./web-thread-host";
import { requireWorkspaceSession, runWithWorkspaceRequestContext } from "./web-workspace-session";
import { toWorkspaceErrorResponse } from "./web-workspace-server";

/** 协作 Route 可用的受信上下文；浏览器只能影响 DTO，不能影响这里的身份。 */
export interface ThreadRouteScope {
  workspace: WebWorkspaceContext;
  host: WebThreadHost;
  threads: Core.ThreadFacade;
}

/** 协议版本固定为 1；所有请求都显式声明，不做字段降级。 */
export const THREAD_PROTOCOL_VERSION = 1 as const;

/** Core 协作错误码到 HTTP 状态的固定映射；越权与不存在统一脱敏为 404。 */
const THREAD_ERROR_MESSAGES: Readonly<Record<string, { status: number; message: string }>> = {
  INVALID_INPUT: { status: 400, message: "协作请求参数不合法" },
  MODEL_NOT_FOUND: { status: 400, message: "所选模型不在当前宿主目录中" },
  THREAD_NOT_FOUND: { status: 404, message: "协作会话不存在或不可见" },
  THREAD_SCOPE_DENIED: { status: 404, message: "协作会话不存在或不可见" },
  THREAD_REQUEST_CONFLICT: { status: 409, message: "相同请求编号已用于不同内容" },
  THREAD_STATE_CONFLICT: { status: 409, message: "共享板已被其他会话更新，请重新读取" },
  THREAD_NOT_RUNNING: { status: 409, message: "目标会话当前没有可引导的运行中任务" },
  THREAD_TURN_MISMATCH: { status: 409, message: "目标任务的 Turn 已变化，请重新读取后再发送" },
  THREAD_RECOVERY_REQUIRED: { status: 409, message: "该协作对象需要人工恢复后才能继续" },
  THREAD_HAS_PENDING_WORK: { status: 409, message: "协作会话仍有未完成工作，不能删除" },
  THREAD_CURSOR_INVALID: { status: 409, message: "游标无效或不属于当前视图，请重新读取" },
  THREAD_CURSOR_EXPIRED: { status: 409, message: "游标已过期，请重新读取" },
  THREAD_PAYLOAD_TOO_LARGE: { status: 413, message: "内容超过协作消息或共享板上限" },
  THREAD_HANDOFF_UNAVAILABLE: { status: 503, message: "当前宿主不支持交接文档写入" },
  THREAD_HANDOFF_WRITE_FAILED: { status: 503, message: "交接文档写入失败，请重试" },
  THREAD_HANDOFF_CONFLICT: { status: 409, message: "同一请求已用于不同的交接内容" },
  THREAD_STORAGE_FULL: { status: 503, message: "协作存储容量已满，请归档后再试" },
  THREADS_UNAVAILABLE: { status: 503, message: "当前宿主未启用协作能力" },
  THREAD_HOST_OFFLINE: { status: 503, message: "当前没有在线宿主驱动协作会话" },
};

/** 将协作领域错误收敛为固定摘要；未知异常不暴露路径或原始正文。 */
export function toThreadErrorResponse(error: unknown): Response {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  const known = code ? THREAD_ERROR_MESSAGES[code] : undefined;
  if (known && code) return NextResponse.json({ error: known.message, code }, { status: known.status });
  // 请求体解析失败等入口错误按 400 处理，不与领域冲突混淆。
  if (code === "INVALID_SESSION_REQUEST") return NextResponse.json({ error: "协作请求参数不合法", code: "INVALID_INPUT" }, { status: 400 });
  const workspaceError = toWorkspaceErrorResponse(error);
  if (workspaceError.status !== 500) return workspaceError;
  return NextResponse.json({ error: "协作服务发生内部错误", code: "THREADS_UNAVAILABLE" }, { status: 503 });
}

/**
 * 统一执行协作 Route：先确认工作区 Trust 与 Runtime，再确认协作宿主已装配，
 * 最后把人类身份绑定为 Core actor。任何一步失败都不进入领域调用。
 */
export async function runWorkspaceThreadRoute<T extends { workspaceId: string }>(
  params: Promise<T>,
  action: (scope: ThreadRouteScope) => Promise<Response>,
  options: { observeOnly?: boolean } = {},
): Promise<Response> {
  try {
    const { workspaceId } = await params;
    const workspace = await requireWorkspaceSession(workspaceId, undefined, options);
    return await runWithWorkspaceRequestContext(workspace, async function invokeThreadRoute() {
      const host = workspace.threadHost;
      if (!host) return NextResponse.json({ error: "当前宿主未启用协作能力", code: "THREADS_UNAVAILABLE" }, { status: 503 });
      // 受信宿主已在线：先接管驱动，再按当前事实回执 hostOnline，避免把“将要启动”写成离线。
      if (!options.observeOnly) host.ensureStarted();
      return await action({ workspace, host, threads: host.facade() });
    });
  } catch (error) {
    return toThreadErrorResponse(error);
  }
}

/** 读取 JSON 对象；非对象或解析失败按入口错误处理。 */
export async function readThreadBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await request.json(); } catch { return {}; }
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

/** 校验必填短字符串；拒绝空值、超长、路径分隔符与控制字符。 */
export function requireThreadId(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\\/\u0000-\u001f]/u.test(value)) throw invalidInput(name);
  return value;
}

/** 校验可选短字符串；缺失时返回 undefined，非法值直接拒绝。 */
export function optionalThreadId(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireThreadId(value, name, maxLength);
}

/** 校验可选整数范围；缺失时返回 undefined。 */
export function optionalThreadInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw invalidInput(name);
  return value;
}

/** 校验必填字符串内容（消息正文、标题等），只限制类型与长度，不解释语义。 */
export function requireThreadText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw invalidInput(name);
  return value;
}

/** 构造可通过 toThreadErrorResponse 正确映射的参数错误。 */
function invalidInput(name: string): Error & { code: string } {
  const error = new Error(name) as Error & { code: string };
  error.code = "INVALID_INPUT";
  error.name = "ThreadRouteInputError";
  return error;
}

/** 校验协作模式；模式必填，避免调用方猜测 send 的含义。 */
export function requireThreadMode(value: unknown): "notify" | "run" | "steer" {
  if (value !== "notify" && value !== "run" && value !== "steer") throw invalidInput("mode");
  return value;
}

/** 校验共享板操作数组；具体键、值、深度与容量由 Core 校验。 */
export function requireThreadOperations(value: unknown): Array<{ op: "set"; key: string; value: unknown } | { op: "remove"; key: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw invalidInput("operations");
  return value.map(function parseOperation(item) {
    if (!item || typeof item !== "object") throw invalidInput("operations");
    const record = item as Record<string, unknown>;
    const key = requireThreadId(record.key, "operations.key");
    if (record.op === "remove") return { op: "remove" as const, key };
    if (record.op === "set") return { op: "set" as const, key, value: record.value };
    throw invalidInput("operations.op");
  });
}

/** 校验等待目标集合；1–8 个不同目标由 Core 再校验一次。 */
export function requireThreadTargets(value: unknown): Array<{ threadId: string; taskId?: string; cursor?: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw invalidInput("targets");
  return value.map(function parseTarget(item) {
    if (!item || typeof item !== "object") throw invalidInput("targets");
    const record = item as Record<string, unknown>;
    const threadId = requireThreadId(record.threadId, "targets.threadId");
    const taskId = optionalThreadId(record.taskId, "targets.taskId");
    const cursor = optionalThreadId(record.cursor, "targets.cursor", 2_048);
    return { threadId, ...(taskId ? { taskId } : {}), ...(cursor ? { cursor } : {}) };
  });
}

/** 校验模型目录字段；只接受 provider/modelId 字符串，目录是否合法仍由 Core 判定。 */
export function optionalThreadModelRef(value: unknown): { provider: string; modelId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") throw invalidInput("modelRef");
  const record = value as Record<string, unknown>;
  return { provider: requireThreadId(record.provider, "modelRef.provider"), modelId: requireThreadId(record.modelId, "modelRef.modelId") };
}
