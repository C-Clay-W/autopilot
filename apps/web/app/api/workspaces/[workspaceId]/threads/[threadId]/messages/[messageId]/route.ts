/**
 * GET /api/workspaces/:workspaceId/threads/:threadId/messages/:messageId
 *
 * 单条消息的持久回执与真实执行投影。`execution` 只来自 Turn 事实，
 * 未终态不填成功；接受、投递与任务完成是三种不同状态。
 */

import { NextResponse } from "next/server";
import {
  requireThreadId,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 返回消息交付状态；读取不确认已读，也不改变任何状态。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; threadId: string; messageId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readMessageStatus({ threads }) {
    const { threadId, messageId } = await params;
    const url = new URL(request.url);
    const groupId = requireThreadId(url.searchParams.get("groupId"), "groupId");
    return NextResponse.json(await threads.messageStatus({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, threadId, messageId }));
  });
}
