/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/cancel：立即中止当前进程内的模型、工具与子进程取消树。
 */
import { NextResponse } from "next/server";
import { cancelActiveTurn } from "@/lib/agent-turn-store";
import { getSessionMeta } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";

/** 取消指定 turn；进程重启后没有活动控制器时仍将 durable 状态标为 interrupted。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as { turnId?: string };
    if (typeof body.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.turnId)) return NextResponse.json({ error: "请提供 turnId" }, { status: 400 });
    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    const state = await runtime.turns.getState({ sessionId: id, turnId: body.turnId });
    if (!state.turn) return workSessionErrorResponse("TURN_NOT_FOUND");
    const status = state.checkpoint?.status ?? state.turn.status;
    if (!state.checkpoint || status === "completed" || status === "failed" || status === "limit_reached") {
      return workSessionErrorResponse("TURN_NOT_CANCELLABLE");
    }
    const aborted = cancelActiveTurn(id, body.turnId);
    await runtime.turns.cancel({ sessionId: id, turnId: body.turnId });
    // 等待原执行协调器把 turn_interrupted 和 checkpoint 持久化，避免前端紧接 continue 读到 running。
    const deadline = Date.now() + 2_000;
    let settled = false;
    while (Date.now() < deadline) {
      const latest = await runtime.turns.getState({ sessionId: id, turnId: body.turnId });
      const latestStatus = latest.checkpoint?.status ?? latest.turn?.status;
      if (latestStatus && latestStatus !== "running" && latestStatus !== "awaiting_approval" && latestStatus !== "waiting_approval") {
        settled = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!settled) return NextResponse.json({ error: "活动 Agent 尚未确认停止，请稍后刷新状态" }, { status: 409 });
    return NextResponse.json({ ok: true, aborted, turnId: body.turnId });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
