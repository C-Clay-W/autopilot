/** 只读本授权范围内指定发起会话的有界任务投影；读取不启动/恢复宿主或目标。 */
import { NextResponse } from "next/server";
import { requireThreadId, runWorkspaceThreadRoute, THREAD_PROTOCOL_VERSION } from "@/lib/workspace-host/thread-route";

/** workspace/Trust/人类owner由既有入口验证，浏览器不能自报actor或执行事实。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; groupId: string }> }) {
  const target = await params;
  return runWorkspaceThreadRoute(params, async function readTasks({ threads }) {
    const threadId = requireThreadId(new URL(request.url).searchParams.get("threadId"), "threadId");
    return NextResponse.json(await threads.tasks({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId: target.groupId, threadId }));
  }, { observeOnly: true });
}
