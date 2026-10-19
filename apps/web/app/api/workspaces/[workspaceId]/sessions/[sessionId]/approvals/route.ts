/** workspace-scoped 审批决定 Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/approvals/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 提交已属于当前工作区 Session 的冻结审批决定。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  }, { requireWritable: true });
}
