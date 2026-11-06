/**
 * GET /api/workspaces/:workspaceId/threads/capabilities
 *
 * 面板在启用协作前需要向用户展示授权工具清单。本 Route 只返回宿主策略常量，
 * 不读请求体，也不代表任何会话已经获得权限。
 */

import { NextResponse } from "next/server";
import { runWorkspaceThreadRoute, THREAD_PROTOCOL_VERSION } from "@/lib/workspace-host/thread-route";
import { WEB_THREAD_ALLOWED_TOOLS } from "@/lib/workspace-host/web-thread-capability";

/** 返回当前宿主的协作授权工具目录。 */
export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readCapabilities() {
    return NextResponse.json({ protocolVersion: THREAD_PROTOCOL_VERSION, allowedTools: WEB_THREAD_ALLOWED_TOOLS });
  }, { observeOnly: true });
}
