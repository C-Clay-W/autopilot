/**
 * GET/DELETE /api/sessions/:id/permissions：查看或撤销持久授权，不提供工具执行能力。
 *
 * Talk-Plan1013 Stage 4（G8）：数据来源统一为共享 Runtime approvals facade（Core grants
 * 权威存储），不再读取 Web 自有 permission-store；撤销按 toolName+constraint 精确匹配，
 * 由 Core 先删 grant 权威再删工作区 local 投影规则。DELETE 是状态变更入口，要求浏览器同源。
 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse, workSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
import { validateWorkJobRequestSource } from "@/lib/workspace-host/web-workspace-jobs";
import { NextResponse } from "next/server";
import { getAgentWorkspaceRoot } from "@/lib/agent-workspace";
import { getSharedWebRuntime } from "@/lib/composition-root";

/** 返回当前 session 可见的 session/workspace grant；canonical 私有身份由 Core 投影剔除。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    // 只读允许缺 Origin 的回环读取；跨站与外部 Host 仍拒绝。
    const crossOrigin = validateWorkJobRequestSource(request, false);
    if (crossOrigin) return crossOrigin;
    const runtime = await getSharedWebRuntime();
    const workspaceRoot = getAgentWorkspaceRoot();
    const [sessionGrants, workspaceGrants] = await Promise.all([
      runtime.approvals.listPersistentGrants({ sessionId: id }),
      runtime.approvals.listPersistentGrants({ workspaceRoot }),
    ]);
    const seen = new Set<string>();
    const grants = [...sessionGrants, ...workspaceGrants].filter(function dedupeGrants(grant) {
      const key = `${grant.scope}|${grant.toolName}|${grant.constraint}|${grant.workspaceRoot ?? ""}|${grant.sessionId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return NextResponse.json({ grants });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}

/** 按 toolName+constraint 撤销指定 grant；不接受或暴露工具输入。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  const crossOrigin = validateWorkJobRequestSource(request, true);
  if (crossOrigin) return crossOrigin;
  try {
    const { id } = await params;
    const body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as { toolName?: string; constraint?: string };
    if (typeof body.toolName !== "string" || !body.toolName || typeof body.constraint !== "string" || !body.constraint) {
      return NextResponse.json({ error: "请提供待撤销授权的 toolName 与 constraint" }, { status: 400 });
    }
    const runtime = await getSharedWebRuntime();
    const outcome = await runtime.approvals.revokePersistentGrant({
      workspaceRoot: getAgentWorkspaceRoot(),
      sessionId: id,
      toolName: body.toolName,
      constraint: body.constraint,
    });
    if (!outcome.deleted) return workSessionErrorResponse("PERMISSION_GRANT_NOT_FOUND");
    return NextResponse.json({ ok: true, ruleRemoved: outcome.ruleRemoved });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
