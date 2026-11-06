/**
 * GET/POST /api/workspaces/:workspaceId/threads/groups
 *
 * POST：人类在空闲 Work 会话上显式启用（或重新启用）协作组。
 * GET：列出本工作区当前人类创建的组（含已停用）；带 threadId 时只查该会话归属。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadId,
  optionalThreadInt,
  readThreadBody,
  requireThreadId,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 只允许人类显式操作；空闲校验、Trust 后的工作区校验与工具授权由 Core 复核。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function enableGroup({ threads }) {
    const body = await readThreadBody(request);
    const rootThreadId = requireThreadId(body.rootThreadId, "rootThreadId");
    const requestId = requireThreadId(body.requestId, "requestId");
    const groupId = optionalThreadId(body.groupId, "groupId");
    const result = await threads.enable({ protocolVersion: THREAD_PROTOCOL_VERSION, rootThreadId, requestId, ...(groupId ? { groupId } : {}) });
    return NextResponse.json(result, { status: 201 });
  });
}

/** 查询组归属或组列表；停用组仍可读，供面板恢复与历史展示。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readGroups({ threads }) {
    const url = new URL(request.url);
    const threadId = optionalThreadId(url.searchParams.get("threadId"), "threadId");
    if (threadId) {
      return NextResponse.json(await threads.groupOf({ protocolVersion: THREAD_PROTOCOL_VERSION, threadId }));
    }
    const cursor = optionalThreadId(url.searchParams.get("cursor"), "cursor", 2_048);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : optionalThreadInt(Number(rawLimit), "limit", 1, 100);
    return NextResponse.json(await threads.groups({ protocolVersion: THREAD_PROTOCOL_VERSION, ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }));
  }, { observeOnly: true });
}
