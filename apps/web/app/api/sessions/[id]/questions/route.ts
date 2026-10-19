/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/questions：只接收结构化答案并交给 Runtime 持久化。
 * Browser 不得在此 Route 传递 checkpoint、Tool 调用、路径或模型消息；继续执行由独立 Continue Route 完成。
 */
import { NextResponse } from "next/server";
import { getSharedWebRuntime } from "@/lib/composition-root";
import { getSessionMeta } from "@/lib/session-store";

/** 验证 unknown 值是否为可安全枚举字段的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 验证对象不携带 Route 契约外的字段，防止 Browser 伪造 Runtime 私有状态。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(value).every(function isAllowedKey(key) { return allowedKeys.includes(key); });
}

/** 将 Browser 请求收窄为 Runtime questions.submit() 的受限 DTO，不在 Route 重复业务校验。 */
function parseQuestionSubmission(value: unknown): { turnId: string; requestId: string; answers: Array<{ id: string; selected: string[]; custom?: string }> } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["turnId", "requestId", "answers"]) || typeof value.turnId !== "string" || typeof value.requestId !== "string" || !Array.isArray(value.answers)) return null;
  const answers: Array<{ id: string; selected: string[]; custom?: string }> = [];
  for (const answer of value.answers) {
    if (!isRecord(answer) || !hasOnlyKeys(answer, ["id", "selected", "custom"]) || typeof answer.id !== "string" || !Array.isArray(answer.selected) || !answer.selected.every(function isLabel(label) { return typeof label === "string"; }) || ("custom" in answer && typeof answer.custom !== "string")) return null;
    answers.push({ id: answer.id, selected: [...answer.selected] as string[], ...(typeof answer.custom === "string" ? { custom: answer.custom } : {}) });
  }
  return { turnId: value.turnId, requestId: value.requestId, answers };
}

/** 提交已选选项或 Other 补充；答案仅被 Runtime 私有 Store 保存，响应不回显用户正文。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const body = parseQuestionSubmission(await readRequestObject(request, "INVALID_SESSION_REQUEST"));
    if (!body) return NextResponse.json({ error: "只接受 turnId、requestId 与 answers 结构化答案" }, { status: 400 });
    const { id } = await params;
    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    await runtime.questions.submit({ sessionId: id, turnId: body.turnId, requestId: body.requestId, answers: body.answers });
    return NextResponse.json({ ok: true, requestId: body.requestId });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
