/**
 * POST /api/workspaces/:workspaceId/threads/:threadId/interrupt
 *
 * 提交跨会话中断意图。接受不代表已停止：实际结束以 Turn 状态为准，
 * 审批/用户输入等待与需恢复会话不走此路径。
 */

import { NextResponse } from "next/server";
import {
  readThreadBody,
  requireThreadId,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 持久化中断意图并唤醒本宿主 Runner；返回的 hostOffline 表示 owner 是否失联。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; threadId: string }> }) {
  return runWorkspaceThreadRoute(params, async function interruptThread({ threads, host }) {
    const { threadId } = await params;
    const body = await readThreadBody(request);
    const result = await threads.interrupt({
      protocolVersion: THREAD_PROTOCOL_VERSION,
      groupId: requireThreadId(body.groupId, "groupId"),
      threadId,
      requestId: requireThreadId(body.requestId, "requestId"),
      expectedTurnId: requireThreadId(body.expectedTurnId, "expectedTurnId"),
    });
    host.kick();
    return NextResponse.json(result, { status: 202 });
  });
}
