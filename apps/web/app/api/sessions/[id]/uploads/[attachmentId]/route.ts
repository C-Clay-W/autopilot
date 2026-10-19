/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * GET /api/sessions/:id/uploads/:attachmentId：安全返回当前会话已保存的图片附件，供聊天消息预览。
 */
import { readSessionImage } from "@/lib/session-attachment-store";

/** Resolve a session-owned image and return only its validated bytes with the stored MIME type. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id, attachmentId } = await params;
    const image = readSessionImage(id, attachmentId);
    const content = image.content.buffer.slice(image.content.byteOffset, image.content.byteOffset + image.content.byteLength) as ArrayBuffer;
    return new Response(content, {
      headers: {
        "Content-Type": image.attachment.mimeType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
