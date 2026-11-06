/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/cancel：立即中止当前进程内的模型、工具与子进程取消树。
 */
import { NextResponse } from "next/server";
import { getWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import { cancelActiveTurn, hasActiveTurn } from "@/lib/agent-turn-store";
import { getSessionMeta } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";

/** 取消精确Turn的本地执行体，远端任务通过既有owner控制协议请求并等待真实收尾。 */
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
    const coreOwned = state.turn.status === "running" && await runtime.turns.cancelLocalExecution?.({ sessionId: id, turnId: body.turnId });
    const local = hasActiveTurn(id, body.turnId) || coreOwned;
    const threadHost = getWorkspaceRequestContext()?.threadHost;
    let aborted = Boolean(coreOwned);
    if (!local && state.turn.status === "running") {
      // 另一个Runner持有执行体时，仅通过既有控制意图请求实际owner停止。
      if (!threadHost) return NextResponse.json({ error: "执行宿主尚未确认停止", turnId: body.turnId, cancellation: "pending" }, { status: 202 });
      const facade = threadHost.facade();
      const membership = await facade.groupOf({ protocolVersion: 1, threadId: id });
      if (!membership.group) return NextResponse.json({ error: "执行宿主尚未确认停止", turnId: body.turnId, cancellation: "pending" }, { status: 202 });
      threadHost.ensureStarted();
      await facade.interrupt({ protocolVersion: 1, groupId: membership.group.groupId, threadId: id, expectedTurnId: body.turnId, requestId: `web-cancel-${body.turnId}` });
      threadHost.kick();
    } else {
      aborted = cancelActiveTurn(id, body.turnId) || Boolean(coreOwned);
      if (!coreOwned) await runtime.turns.cancel({ sessionId: id, turnId: body.turnId });
    }
    // 等待原执行协调器把 turn_interrupted 和 checkpoint 持久化，避免前端紧接 continue 读到 running。
    const deadline = Date.now() + 2_000;
    let settled = false;
    while (Date.now() < deadline) {
      const latest = await runtime.turns.getState({ sessionId: id, turnId: body.turnId });
      const latestStatus = latest.checkpoint?.status;
      if ((latestStatus === "interrupted" || latestStatus === "interrupted_recoverable") && latest.turn?.status === "interrupted") {
        const meta = await getSessionMeta(runtime, id);
        if (meta.runtimeStatus === "interrupted") {
          settled = true;
          break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!settled) return NextResponse.json({ error: "停止请求已发送，等待执行宿主确认", turnId: body.turnId, cancellation: "pending" }, { status: 202 });
    return NextResponse.json({ ok: true, aborted, turnId: body.turnId });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
