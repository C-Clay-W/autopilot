/** workspace-scoped Agent 消息与 SSE Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/messages/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 保持流式 Agent Route 的最长执行时间与兼容入口一致。 */
export const maxDuration = 120;

/** 在当前工作区 Runtime 内提交消息或队列操作。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  }, { requireWritable: true });
}
