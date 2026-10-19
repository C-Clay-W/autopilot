/**
 * Web 工作区兼容入口；canonical workspaceRoot 的 Node 实现统一位于共享 Adapter 包。
 */

import { createNodeWorkspaceAdapter } from "@autopilot-agent/adapters";
import { getWorkspaceRequestContext } from "./workspace-host/web-workspace-session";

/** 定位由服务端信任的 canonical workspaceRoot，不接受浏览器传入的路径。 */
export function getAgentWorkspaceRoot(): string {
  const requestContext = getWorkspaceRequestContext();
  if (requestContext) return requestContext.workspaceRoot;
  return createNodeWorkspaceAdapter().resolveWorkspaceRoot() as string;
}
