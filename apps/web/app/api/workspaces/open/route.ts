/**
 * POST /api/workspaces/open — 消费目录选择 token 并返回工作区摘要或 Trust challenge。
 */

import { NextResponse } from "next/server";
import { getWebWorkspaceHost, toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 校验 open 请求只携带一次性 token。 */
function parseOpenRequest(value: unknown): { selectionToken: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.selectionToken !== "string" || !/^[a-f0-9-]{36}$/i.test(body.selectionToken)) return undefined;
  return { selectionToken: body.selectionToken };
}

/** 复查选择目录的 canonical identity 与 Trust，不在此处 bootstrap 未 Trust Runtime。 */
export async function POST(request: Request) {
  try {
    const body = parseOpenRequest(await request.json());
    if (!body) return NextResponse.json({ error: "只接受 selectionToken", code: "INVALID_WORKSPACE_REQUEST" }, { status: 400 });
    const result = await getWebWorkspaceHost().inspectSelection(body.selectionToken);
    return "challengeId" in result ? NextResponse.json({ challenge: result }) : NextResponse.json({ workspace: result });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "请求 JSON 格式无效", code: "INVALID_WORKSPACE_REQUEST" }, { status: 400 });
    return toWorkspaceErrorResponse(error);
  }
}
