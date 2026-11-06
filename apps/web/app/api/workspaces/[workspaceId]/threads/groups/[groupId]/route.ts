/**
 * PATCH /api/workspaces/:workspaceId/threads/groups/:groupId
 *
 * 人类显式启用或停用协作组。停用只拒绝后续写入，不停止活动 Turn，也不撤销已发生动作；
 * 重新启用必须由人类再次操作，并重新通过 Core 的空闲会话与工作区校验。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadId,
  readThreadBody,
  requireThreadId,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 切换协作组启用状态；`enabled` 必须显式给出。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ workspaceId: string; groupId: string }> }) {
  return runWorkspaceThreadRoute(params, async function setGroupEnabled({ threads }) {
    const { groupId } = await params;
    const body = await readThreadBody(request);
    const requestId = requireThreadId(body.requestId, "requestId");
    if (body.enabled === false) {
      return NextResponse.json(await threads.disable({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, requestId }));
    }
    if (body.enabled !== true) return NextResponse.json({ error: "请显式指定启用或停用", code: "INVALID_INPUT" }, { status: 400 });
    const rootThreadId = requireThreadId(body.rootThreadId, "rootThreadId");
    const guard = optionalThreadId(body.groupId, "groupId");
    if (guard !== undefined && guard !== groupId) return NextResponse.json({ error: "协作组与请求地址不一致", code: "INVALID_INPUT" }, { status: 400 });
    const result = await threads.enable({ protocolVersion: THREAD_PROTOCOL_VERSION, rootThreadId, requestId, groupId });
    return NextResponse.json(result);
  });
}
