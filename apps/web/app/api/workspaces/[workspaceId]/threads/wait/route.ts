/**
 * POST /api/workspaces/:workspaceId/threads/wait
 *
 * 只观察 1–8 个目标直到变化、需关注或超时。等待不启动、不恢复、不取消任何目标；
 * 请求断开只结束本次等待，与目标 Turn 的生命周期无关。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadInt,
  readThreadBody,
  requireThreadId,
  requireThreadTargets,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 等待最长 30 秒，给请求收尾留出余量。 */
export const maxDuration = 40;

/** 返回每个目标的观察结果与独立游标。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function waitThreads({ threads }) {
    const body = await readThreadBody(request);
    const groupId = requireThreadId(body.groupId, "groupId");
    const targets = requireThreadTargets(body.targets);
    if (body.timeoutMs === undefined) return NextResponse.json({ error: "请提供 timeoutMs", code: "INVALID_INPUT" }, { status: 400 });
    const timeoutMs = optionalThreadInt(body.timeoutMs, "timeoutMs", 0, 30_000);
    if (timeoutMs === undefined) return NextResponse.json({ error: "timeoutMs 不合法", code: "INVALID_INPUT" }, { status: 400 });
    // 客户端断开只中止本次观察：信号不会传递给任何目标 Turn。
    const result = await threads.wait({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, targets, timeoutMs, signal: request.signal });
    return NextResponse.json(result);
  });
}
