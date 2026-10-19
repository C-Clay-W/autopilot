/**
 * POST /api/workspaces/trust — 提交用户显式 Trust 决定。
 *
 * allow 后 Host 才注册目录并启动该工作区的 Runtime；deny 不创建 Runtime。
 */

import { NextResponse } from "next/server";
import { getWebWorkspaceHost, toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 校验 trust 请求为严格的 challengeId 与 allow/deny 枚举。 */
function parseTrustRequest(value: unknown): { challengeId: string; decision: "allow" | "deny" } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.challengeId) || (body.decision !== "allow" && body.decision !== "deny")) return undefined;
  return { challengeId: body.challengeId, decision: body.decision };
}

/** 写入用户明确授信决定并返回脱敏工作区摘要。 */
export async function POST(request: Request) {
  try {
    const body = parseTrustRequest(await request.json());
    if (!body) return NextResponse.json({ error: "只接受 challengeId 与 allow/deny", code: "INVALID_WORKSPACE_REQUEST" }, { status: 400 });
    return NextResponse.json({ workspace: await getWebWorkspaceHost().submitTrust(body) });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "请求 JSON 格式无效", code: "INVALID_WORKSPACE_REQUEST" }, { status: 400 });
    return toWorkspaceErrorResponse(error);
  }
}
