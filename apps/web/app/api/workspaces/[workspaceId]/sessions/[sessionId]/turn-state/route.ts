/**
 * turn-state/route.ts — 普通 Work Turn 的只读发现入口
 *
 * 页面在上一轮结束后用它确认宿主是否已为同一 Session 启动新的 Turn。
 * 只读取持久 Turn 身份与状态，不领取/消费输入、不启动 Turn、不触发恢复或 lease 迁移。
 */

import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";
import { workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";

export const runtime = "nodejs";

/** GET /api/workspaces/:workspaceId/sessions/:sessionId/turn-state */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(context.params, async function readTurnState(workspace, sessionId) {
    const ports = workspace.compositionRoot.getRuntimePorts();
    if (!ports) return workSessionErrorResponse("WORKSPACE_SESSION_FAILED");
    const requested = new URL(request.url).searchParams.get("turnId");
    if (requested && !/^[A-Za-z0-9_-]{1,128}$/.test(requested)) return workSessionErrorResponse("INVALID_SESSION_REQUEST");
    const turn = requested ? await ports.turnStore.get(requested) : await ports.turnStore.getLatest(sessionId);
    if (turn && turn.sessionId !== sessionId) return workSessionErrorResponse("TURN_NOT_FOUND");
    const checkpoint = requested && turn ? await ports.checkpointStore.getByTurn(sessionId, turn.id) : undefined;
    const terminal = turn && ["interrupted", "completed", "failed", "limit_reached"].includes(turn.status);
    const inactive = checkpoint && !["running", "awaiting_approval", "awaiting_user_input"].includes(checkpoint.status);
    return Response.json({ turnId: turn?.id ?? null, status: turn?.status ?? null, ...(requested ? { cancellation: terminal && inactive ? "confirmed" : "pending" } : {}) });
  });
}
