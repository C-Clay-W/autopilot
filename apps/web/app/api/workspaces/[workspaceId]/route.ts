/**
 * DELETE /api/workspaces/:workspaceId — 仅注销工作区 Registry 条目。
 *
 * 不删除目录、Trust、stateRoot、Session 或正在运行的 Turn。
 */

import { NextResponse } from "next/server";
import { getWebWorkspaceHost, toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 校验 opaque workspaceId 的基本形状，拒绝路径片段。 */
function isWorkspaceId(value: string): boolean {
  return /^v[0-9]+-[a-f0-9]{16,128}$/i.test(value);
}

/** 仅从 Registry 注销指定工作区。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    if (!isWorkspaceId(workspaceId)) return NextResponse.json({ error: "工作区标识无效", code: "INVALID_WORKSPACE_ID" }, { status: 400 });
    const removed = await getWebWorkspaceHost().removeWorkspace(workspaceId);
    return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "工作区不存在", code: "WORKSPACE_NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return toWorkspaceErrorResponse(error);
  }
}
