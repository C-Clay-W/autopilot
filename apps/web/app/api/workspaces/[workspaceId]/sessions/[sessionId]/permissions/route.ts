/** workspace-scoped 持久授权读取与撤销 Route。 */

import { DELETE as legacyDelete, GET as legacyGet } from "@/app/api/sessions/[id]/permissions/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 列出当前工作区 Session 可见的授权。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyGet(request, { params: Promise.resolve({ id: sessionId }) });
  });
}

/** 撤销当前工作区 Session 可见的授权。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyDelete(request, { params: Promise.resolve({ id: sessionId }) });
  });
}
