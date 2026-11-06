/**
 * GET /api/workspaces/:workspaceId/threads/:threadId
 *
 * 只读会话摘要、最近 Turn、消息页与历史。不 resume、不启动、不确认已读。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadId,
  optionalThreadInt,
  requireThreadId,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 返回安全读取结果；游标绑定工作区、状态根、组与视图。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; threadId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readThread({ threads }) {
    const { threadId } = await params;
    const url = new URL(request.url);
    const groupId = requireThreadId(url.searchParams.get("groupId"), "groupId");
    const cursor = optionalThreadId(url.searchParams.get("cursor"), "cursor", 2_048);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : optionalThreadInt(Number(rawLimit), "limit", 1, 100);
    return NextResponse.json(await threads.read({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, threadId, ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }));
  }, { observeOnly: true });
}
