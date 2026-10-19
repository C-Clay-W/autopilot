/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * GET /api/sessions — 列出所有会话（id/title/updatedAt）
 * POST /api/sessions — 新建会话
 */

import { NextResponse } from "next/server";
import { createSession } from "@/lib/session-store";
import { getSharedWebRuntime } from "@/lib/composition-root";
import { toWebSessionDto } from "@/lib/runtime-host/web-ui-dto";

/** 列出已校验工作区中的会话摘要。 */
export async function GET() {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const runtime = await getSharedWebRuntime();
    const runtimeSessions = await runtime.sessions.list();
    const sessions = runtimeSessions.map((session) => toWebSessionDto(session));
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return NextResponse.json({ sessions });
  } catch (err) {
    return toWorkSessionErrorResponse(err);
  }
}

/** 在已校验的工作区上下文创建会话。 */
export async function POST() {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const runtime = await getSharedWebRuntime();
    const meta = await createSession(runtime);
    return NextResponse.json(meta);
  } catch (err) {
    return toWorkSessionErrorResponse(err);
  }
}
