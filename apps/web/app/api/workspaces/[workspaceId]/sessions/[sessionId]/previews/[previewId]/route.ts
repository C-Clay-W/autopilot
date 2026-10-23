/** Work 内置预览引用解析 Route：返回受限导航 DTO，仅父应用 fetch 调用。 */

import { getWebWorkPreview } from "@/lib/workspace-host/work-preview-route";

/** 返回当前 Work Session 中指定预览引用的安全导航 DTO。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; previewId: string }> }) {
  return getWebWorkPreview(request, params);
}
