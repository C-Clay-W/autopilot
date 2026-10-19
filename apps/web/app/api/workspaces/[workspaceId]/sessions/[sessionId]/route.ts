/** workspace-scoped Session 详情与删除 Route。 */

import { DELETE as legacyDelete, GET as legacyGet } from "@/app/api/sessions/[id]/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";

/** 读取已完成统一归属校验的 Session 详情。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyGet(request, { params: Promise.resolve({ id: sessionId }) });
  });
}

/** 删除已完成统一归属校验的 Session。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(params, function invokeLegacyRoute(_context, sessionId) {
    return legacyDelete(request, { params: Promise.resolve({ id: sessionId }) });
  });
}
