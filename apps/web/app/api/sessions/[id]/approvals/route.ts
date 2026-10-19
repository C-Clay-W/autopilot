/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
import { validateWorkJobRequestSource } from "@/lib/workspace-host/web-workspace-jobs";
/**
 * POST /api/sessions/:id/approvals：只记录对冻结审批凭证的决定，不接受任何工具输入。
 */
import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";

/** 验证并持久化审批决定；allow_session/workspace 同时创建受约束的真实 grant。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  // Talk-Plan1013 Stage 4（16.8 #4）：审批提交是状态变更入口，必须来自浏览器同源请求；
  // 非浏览器客户端缺 Origin 且非回环时同样拒绝，防止跨站或远端伪造四字段决定。
  const crossOrigin = validateWorkJobRequestSource(request, true);
  if (crossOrigin) return crossOrigin;
  try {
    const { id } = await params;
    const body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as { turnId?: string; approvalId?: string; decision?: "allow_once" | "allow_session" | "allow_workspace" | "deny" };
    if (typeof body.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.turnId) || typeof body.approvalId !== "string" || !body.approvalId || !body.decision || !["allow_once", "allow_session", "allow_workspace", "deny"].includes(body.decision)) {
      return NextResponse.json({ error: "turnId、approvalId 和合法 decision 为必填项" }, { status: 400 });
    }
    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    const state = await runtime.turns.getRecoverableState({ sessionId: id, turnId: body.turnId });
    if (!state || state.status !== "awaiting_approval" || state.approval?.approvalId !== body.approvalId) {
      return workSessionErrorResponse("APPROVAL_MISMATCH");
    }
    const decision = await runtime.approvals.submit({
      sessionId: id,
      turnId: body.turnId,
      approvalId: body.approvalId,
      decision: body.decision,
    });
    return NextResponse.json({ ok: true, approvalId: decision.approvalId, decision: decision.decision });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
