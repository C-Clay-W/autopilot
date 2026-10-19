/** workspace-scoped 结构化问题回答 Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/questions/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 提交已属于当前工作区 Session 的受限结构化回答。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  }, { requireWritable: true });
}
