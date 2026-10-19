/** workspace-scoped Turn 恢复 Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/continue/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 在当前工作区 Runtime 内恢复同一 Session 的 checkpoint。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  }, { requireWritable: true });
}
