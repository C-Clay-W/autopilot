/**
 * GET/PATCH /api/workspaces/:workspaceId/threads/groups/:groupId/state
 *
 * 读取或按显式 revision 更新协作共享板。CAS 冲突原样返回给调用方重新读取，
 * 不自动合并互相矛盾的结论，也不把共享板内容注入模型上下文。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadInt,
  readThreadBody,
  requireThreadId,
  requireThreadOperations,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 读取共享板当前值、revision 与最后更新者。 */
export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string; groupId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readState({ threads }) {
    const { groupId } = await params;
    return NextResponse.json(await threads.readState({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId }));
  }, { observeOnly: true });
}

/** 使用 expectedRevision 原子更新；旧版本返回 409 与当前 revision。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ workspaceId: string; groupId: string }> }) {
  return runWorkspaceThreadRoute(params, async function updateState({ threads }) {
    const { groupId } = await params;
    const body = await readThreadBody(request);
    const requestId = requireThreadId(body.requestId, "requestId");
    const expectedRevision = optionalThreadInt(body.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
    if (expectedRevision === undefined) return NextResponse.json({ error: "请提供 expectedRevision", code: "INVALID_INPUT" }, { status: 400 });
    const operations = requireThreadOperations(body.operations);
    return NextResponse.json(await threads.updateState({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, requestId, expectedRevision, operations }));
  });
}
