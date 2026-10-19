/**
 * POST /api/workspaces/picker — 在本机回环 Host 启动原生目录选择。
 *
 * 仅返回一次性 token 和脱敏目录名，绝不接收浏览器提交的路径。
 */

import { NextResponse } from "next/server";
import { getWebWorkspaceHost, isLoopbackRequest, toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 验证 picker 请求没有夹带路径或未定义的控制字段。 */
async function requireEmptyBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim()) throw new Error("请求不能包含目录路径或额外字段");
}

/** 生成短期、一次性的目录选择 token。 */
export async function POST(request: Request) {
  try {
    await requireEmptyBody(request);
    if (!isLoopbackRequest(request)) return NextResponse.json({ error: "当前 Host 不支持本机目录选择", code: "DIRECTORY_PICKER_UNAVAILABLE" }, { status: 409 });
    const selection = await getWebWorkspaceHost().beginDirectorySelection(request.signal);
    return NextResponse.json({ selection: selection ?? null });
  } catch (error) {
    if (error instanceof Error && error.message.includes("额外字段")) return NextResponse.json({ error: "请求不能包含目录路径或额外字段", code: "INVALID_WORKSPACE_REQUEST" }, { status: 400 });
    return toWorkspaceErrorResponse(error);
  }
}
