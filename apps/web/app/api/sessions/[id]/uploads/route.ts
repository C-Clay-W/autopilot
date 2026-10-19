/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestForm } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * POST /api/sessions/:id/uploads：保存会话图片附件，返回供后续 Agent 消息引用的受控附件 ID。
 */
import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-store";
import { persistUserMessage } from "@/lib/runtime-host/web-message-projection";
import { storeSessionImage } from "@/lib/session-attachment-store";
import { getSharedWebRuntime } from "@/lib/composition-root";

/** 在已绑定的 Runtime 中校验会话，只保存一个受支持的任务图片附件。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    const formData = await readRequestForm(request, "INVALID_SESSION_REQUEST");
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请提供图片文件" }, { status: 400 });
    const attachment = await storeSessionImage(id, file);
    if (formData.get("persist") === "true") await persistUserMessage(runtime, id, "", [attachment]);
    return NextResponse.json({ attachment });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
