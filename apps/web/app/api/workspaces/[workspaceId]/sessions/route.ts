/**
 * GET/POST /api/workspaces/:workspaceId/sessions — 工作区内列出或创建 Session。
 */

import { NextResponse } from "next/server";
import { createSession } from "@/lib/session-store";
import { toWebSessionDto } from "@/lib/runtime-host/web-ui-dto";
import { toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";
import { requireWorkspaceSession, runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";

/** 读取当前 stateRoot 内属于该 Project 的会话，只读展示历史归属。 */
async function listWorkspaceSessions(workspaceId: string) {
  const context = await requireWorkspaceSession(workspaceId);
  return runWithWorkspaceRequestContext(context, async function loadSessions() {
    const sessions = await context.runtime.sessions.list();
    return sessions.filter(function belongsToProject(session) { return session.productMode !== "chat" && session.projectId === context.projectId; })
      .map(function toDto(session) { return toWebSessionDto(session); })
      .sort(function sortByUpdatedAt(left, right) { return right.updatedAt - left.updatedAt; });
  });
}

/** 返回指定工作区的安全会话列表。 */
export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    return NextResponse.json({ sessions: await listWorkspaceSessions(workspaceId) });
  } catch (error) {
    return toWorkspaceErrorResponse(error);
  }
}

/** 在已 ensure 的 Project 下创建新 Session 并初始化展示投影。 */
export async function POST(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const context = await requireWorkspaceSession(workspaceId);
    return await runWithWorkspaceRequestContext(context, async function createWorkspaceSession() {
      return NextResponse.json(await createSession(context.runtime, { projectId: context.projectId }));
    });
  } catch (error) {
    return toWorkspaceErrorResponse(error);
  }
}
