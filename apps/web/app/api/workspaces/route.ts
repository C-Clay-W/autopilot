/**
 * GET /api/workspaces — 返回已登记工作区的安全摘要。
 *
 * 该 Route 不加载 Runtime、不创建 stateRoot，也不向浏览器暴露 Host 路径。
 */

import { NextResponse } from "next/server";
import { getWebWorkspaceHost, toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 列出 Registry 的安全工作区 DTO。 */
export async function GET() {
  try {
    const host = getWebWorkspaceHost();
    return NextResponse.json({ workspaces: await host.listWorkspaces(), directoryPickerAvailable: host.isDirectorySelectionAvailable() });
  } catch (error) {
    return toWorkspaceErrorResponse(error);
  }
}
