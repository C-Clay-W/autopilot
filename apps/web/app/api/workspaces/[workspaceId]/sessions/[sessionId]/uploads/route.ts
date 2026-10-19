/** workspace-scoped 会话图片上传 Route。 */

import { POST as legacyPost } from "@/app/api/sessions/[id]/uploads/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 保存当前工作区 Session 的图片附件。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyPost(request, { params: Promise.resolve({ id: sessionId }) });
  }, { requireWritable: true });
}
