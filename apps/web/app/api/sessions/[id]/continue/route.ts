/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/continue：提交恢复意图并立即回执；
 * 实际 checkpoint 续跑由 Workspace TurnHost 消费完整事件流（Talk-Plan1028 7.17）。
 */
import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";
import { requireWorkspaceTurnHost } from "@/lib/workspace-host/web-workspace-session";
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
      if (body.approvalId && body.approvalId !== recoverable.approval?.approvalId) return NextResponse.json({ error: "审批已失效或不属于当前任务" }, { status: 409 });
      // Core不再交付过期审批身份时，只续跑原checkpoint重签；没有批准决定可传给执行器。
      if (recoverable.approval) {
        if (!body.approvalId && recoverable.interactionState !== "decided") return NextResponse.json({ error: "审批暂停的任务需要 approvalId" }, { status: 400 });
        const decision = await runtime.approvals.getDecision({ sessionId: id, turnId: body.turnId, approvalId: body.approvalId ?? recoverable.approval.approvalId });
        if (!decision) return NextResponse.json({ error: "请先提交审批决定" }, { status: 409 });
        approval = { approvalId: decision.approvalId, decision: decision.decision === "deny" ? "deny" : "allow" };
      }
    }
    if (recoverable.status === "awaiting_user_input" && (!body.requestId || typeof body.requestId !== "string")) {
      return NextResponse.json({ error: "等待用户回答的任务需要 requestId" }, { status: 400 });
    }

    if (approval || body.requestId) {
      const handoff = await runtime.turns.requestInteractionContinuation?.({ sessionId: id, turnId: body.turnId, approvalId: approval?.approvalId, requestId: approval ? undefined : body.requestId });
      if (handoff?.queued) return NextResponse.json({ accepted: true, turnId: body.turnId, controlId: handoff.controlId }, { status: 202 });
    }

    // 宿主执行与请求生命周期无关：浏览器断开只影响观察流，不影响续跑。
    requireWorkspaceTurnHost().continue({
      sessionId: id,
      turnId: body.turnId,
      approval,
      requestId: body.requestId,
      initialProjection: projectEvents(state.events),
    });
    return NextResponse.json({ accepted: true, turnId: body.turnId }, { status: 202 });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
