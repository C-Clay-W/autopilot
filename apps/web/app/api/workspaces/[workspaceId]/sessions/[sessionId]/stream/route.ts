/** Work Turn 的只读观察入口：重放持久事件并跟随宿主执行，断开观察不取消任务。 */
import type { NextRequest } from "next/server";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";
import { createWebTurnStream } from "@/lib/workspace-host/web-turn-stream";

export const runtime = "nodejs";
export const maxDuration = 1800;

/** GET /api/workspaces/:workspaceId/sessions/:sessionId/stream?turnId=&cursor= */
export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return runWorkspaceSessionRoute(context.params, async function observe(context, sessionId) {
    const turnId = new URL(request.url).searchParams.get("turnId") ?? "";
    const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? "0");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) {
      return Response.json({ error: "请提供 turnId", code: "INVALID_SESSION_REQUEST" }, { status: 400 });
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Response.json({ error: "游标不合法", code: "INVALID_SESSION_REQUEST" }, { status: 400 });
    }
    const ports = context.compositionRoot.getRuntimePorts();
    if (!ports) return Response.json({ error: "当前宿主未就绪", code: "WORKSPACE_SESSION_FAILED" }, { status: 503 });
    const stream = createWebTurnStream({
      ports,
      host: context.turnHost,
      sessionId,
      turnId,
      cursor,
      signal: request.signal,
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
    });
  });
}
