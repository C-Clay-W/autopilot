/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/continue：通过 Core Runtime checkpoint 恢复一个暂停或中断的 turn。
 */
import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { projectEvents } from "@/lib/runtime-host/web-message-projection";

/** 恢复 paused、interrupted、limit_reached 或等待用户回答的 turn；审批和答案均由 Runtime 可信 Store 读取。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as { turnId?: string; approvalId?: string; requestId?: string };
    if (typeof body.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.turnId)) return NextResponse.json({ error: "请提供 turnId" }, { status: 400 });

    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    const state = await runtime.turns.getState({ sessionId: id, turnId: body.turnId });
    if (!state.turn) return workSessionErrorResponse("TURN_NOT_FOUND");
    const recoverable = await runtime.turns.getRecoverableState({ sessionId: id, turnId: body.turnId });
    if (recoverable?.status === "running") {
      return NextResponse.json({ error: "当前 Turn 正在运行", code: "TURN_ALREADY_RUNNING" }, { status: 409 });
    }
    if (!recoverable?.recoverable) {
      if (state.readOnlyReason) return workSessionErrorResponse(state.readOnlyReason);
      return workSessionErrorResponse("TURN_NOT_RESUMABLE");
    }

    let approval: { approvalId: string; decision: "allow" | "deny" } | undefined;
    if (recoverable.status === "awaiting_approval") {
      if (!body.approvalId) return NextResponse.json({ error: "审批暂停的任务需要 approvalId" }, { status: 400 });
      const decision = await runtime.approvals.getDecision({ sessionId: id, turnId: body.turnId, approvalId: body.approvalId });
      if (!decision) return NextResponse.json({ error: "请先提交审批决定" }, { status: 409 });
      approval = { approvalId: decision.approvalId, decision: decision.decision === "deny" ? "deny" : "allow" };
    }
    if (recoverable.status === "awaiting_user_input" && (!body.requestId || typeof body.requestId !== "string")) {
      return NextResponse.json({ error: "等待用户回答的任务需要 requestId" }, { status: 400 });
    }

    return new Response(createRuntimeAgentStream({
      sessionId: id,
      turnId: body.turnId,
      runtime,
      mode: "continue",
      requestSignal: request.signal,
      initialProjection: projectEvents(state.events),
      initialSeq: Math.max(0, ...state.events.filter((event) => event.turnId === body.turnId).map((event) => event.seq)),
      approval,
      requestId: body.requestId,
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
