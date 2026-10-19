/** workspace-scoped Turn 取消 Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/cancel/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 在当前工作区 Runtime 内取消目标 Turn。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  });
}
