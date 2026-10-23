/** Work 手动链接内置打开 Route：Work 弹窗明确点击后校验并返回手动导航 DTO。 */

import { openWebWorkPreviewLink } from "@/lib/workspace-host/work-preview-route";

/** 校验用户确认的链接并返回受限手动导航 DTO；不做服务端探测，不创建工具事实。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return openWebWorkPreviewLink(request, params);
}
