/**
 * web-workspace-session.ts — workspace-scoped Session 的统一归属断言与请求上下文。
 *
 * 仅 Route 使用此模块；浏览器永远不能读取其中的 root、Runtime 或 Composition Root。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { WebWorkspaceContext } from "./web-workspace-host";
import { getWebWorkspaceHost, WebWorkspaceSessionError } from "./web-workspace-server";

const workspaceRequestContext = new AsyncLocalStorage<WebWorkspaceContext>();

/** 返回当前 workspace-scoped Route 已固定的服务器上下文，普通默认 Route 返回 undefined。 */
export function getWorkspaceRequestContext(): WebWorkspaceContext | undefined {
  return workspaceRequestContext.getStore();
}

/** 在整个异步 Route 生命周期内固定 Context，避免任何全局 current workspace 状态。 */
export async function runWithWorkspaceRequestContext<T>(context: WebWorkspaceContext, action: () => Promise<T>): Promise<T> {
  return workspaceRequestContext.run(context, action);
}

/** 校验 workspaceId、Trust 与 Session 的 projectId；拒绝跨产品和未绑定旧记录，不改写历史。 */
export async function requireWorkspaceSession(workspaceId: string, sessionId?: string): Promise<WebWorkspaceContext> {
  const context = await getWebWorkspaceHost().getContext(workspaceId);
  if (!sessionId) return context;
  const session = await context.runtime.sessions.get(sessionId);
  if (!session) throw new WebWorkspaceSessionError("WORKSPACE_SESSION_NOT_FOUND");
  if (session.productMode === "chat" || session.projectId !== context.projectId) throw new WebWorkspaceSessionError("WORKSPACE_SESSION_NOT_FOUND");
  return context;
}
