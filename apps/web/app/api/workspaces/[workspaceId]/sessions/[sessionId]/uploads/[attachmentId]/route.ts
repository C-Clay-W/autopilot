/** workspace-scoped 会话图片预览 Route。 */

import { GET as legacyGet } from "@/app/api/sessions/[id]/uploads/[attachmentId]/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 读取当前工作区 Session 自有附件的受控字节流。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; attachmentId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyGet(request, { params: params.then(function toLegacyParams(value) { return { id: sessionId, attachmentId: value.attachmentId }; }) });
  });
}
