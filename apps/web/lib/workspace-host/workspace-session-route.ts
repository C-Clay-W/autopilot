/**
 * workspace-session-route.ts — workspace-scoped Session 子 Route 的统一入口。
 *
 * 先完成 workspaceId -> Runtime -> projectId -> sessionId 断言，再运行既有会话业务逻辑。
 */

import type { WebWorkspaceContext } from "./web-workspace-host";
import { findWorkSessionErrorResponse, workSessionErrorResponse } from "./work-session-error";
import { toWorkspaceErrorResponse } from "./web-workspace-server";
import { requireWorkspaceSession, runWithWorkspaceRequestContext } from "./web-workspace-session";

/** 校验 URL 中的不透明 Session ID，拒绝路径、空值与异常长度。 */
function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** 在受限上下文中调用既有 Session Route，所有子 Route 共用同一归属检查。 */
export async function runWorkspaceSessionRoute(
  params: Promise<{ workspaceId: string; sessionId: string }>,
  action: (context: WebWorkspaceContext, sessionId: string) => Promise<Response>,
  options: { requireWritable?: boolean } = {},
): Promise<Response> {
  try {
    const { workspaceId, sessionId } = await params;
    if (!isSessionId(sessionId)) return workSessionErrorResponse("INVALID_SESSION_ID");
    const context = await requireWorkspaceSession(workspaceId, sessionId);
    if (options.requireWritable && (await context.runtime.turns.getState({ sessionId })).readOnlyReason) {
      return workSessionErrorResponse("WORK_HISTORY_READ_ONLY");
    }
    // 这里的invokeRoute() 函数没有地方调用，只是给这个匿名回调起了一个局部名字，报错会显示 invokeRoute 而不是 anonymous
    // noted by clayw on 20260915
    const response = await runWithWorkspaceRequestContext(context, function invokeRoute() { return action(context, sessionId); });
    return await normalizeSessionRouteError(response);
  } catch (error) {
    return toWorkspaceErrorResponse(error);
  }
}

/** 将既有子 Route 的失败收敛为新 workspace API 的稳定安全摘要，避免遗留错误文本泄露服务器细节。 */
async function normalizeSessionRouteError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  // 只读取内部 Route 的 code；原始 error 文本始终丢弃，损坏正文不能冒充领域错误。
  const body: unknown = await response.json().catch(function invalidBody() { return undefined; });
  const known = findWorkSessionErrorResponse(body);
  if (known) return known;
  const code = response.status === 400 ? "INVALID_SESSION_REQUEST"
    : response.status === 404 ? "WORKSPACE_SESSION_NOT_FOUND"
      : response.status === 409 ? "WORKSPACE_SESSION_CONFLICT"
        : "WORKSPACE_SESSION_FAILED";
  return workSessionErrorResponse(code);
}
