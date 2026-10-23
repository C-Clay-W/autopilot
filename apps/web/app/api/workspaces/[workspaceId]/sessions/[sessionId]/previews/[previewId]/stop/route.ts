/** Work 内置预览服务停止 Route：只停止该引用拥有的受管 Job。 */

import { stopWebWorkPreview } from "@/lib/workspace-host/work-preview-route";

/** 接受严格空对象并停止该预览引用拥有的受管 Job。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; previewId: string }> }) {
  return stopWebWorkPreview(request, params);
}
