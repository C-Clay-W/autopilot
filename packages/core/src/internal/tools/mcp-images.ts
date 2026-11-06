/** MCP 图片在进入工具正文前复用会话 Store 规范化，原始编码不进入 transcript。 */
import type { SessionImageStore } from "../../runtime/ports/session-image-store";
import type { AgentImageReference } from "../types/agent-message";

/** 提取标准 MCP image 内容块，只保留受信引用和可见缺失说明。 */
export async function prepareMcpImages(output: unknown, store: SessionImageStore | undefined, sessionId: string | undefined, signal?: AbortSignal): Promise<{ output: unknown; images: AgentImageReference[] }> {
  if (!output || typeof output !== "object" || !Array.isArray((output as { content?: unknown }).content)) return { output, images: [] };
  const result = output as Record<string, unknown> & { content: unknown[] };
  const images: AgentImageReference[] = [];
  const content: unknown[] = [];
  let inputBytes = 0;
  for (const item of result.content) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") { content.push(item); continue; }
    if (signal?.aborted) throw new Error("MCP_IMAGE_CANCELLED");
    try {
      const image = item as { data?: unknown; mimeType?: unknown };
      if (!store || !sessionId || images.length >= 10 || typeof image.data !== "string" || image.data.length > 27_962_028 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType as string)) throw new Error("MCP_IMAGE_INVALID");
      const bytes = Buffer.from(image.data, "base64");
      inputBytes += bytes.length;
      if (!bytes.length || inputBytes > 20 * 1024 * 1024) throw new Error("MCP_IMAGE_LIMIT");
      const saved = await store.put({ sessionId, name: `tool-image-${images.length + 1}`, mimeType: image.mimeType as string, bytes });
      images.push({ type: "image-ref", id: saved.id, sha256: saved.sha256, width: saved.width, height: saved.height });
      content.push({ type: "text", text: `[工具图片 ${saved.id}]` });
    } catch {
      content.push({ type: "text", text: "[工具图片未提供：格式、大小或会话存储不可用]" });
    }
  }
  if (signal?.aborted) throw new Error("MCP_IMAGE_CANCELLED");
  return { output: { ...result, content }, images };
}
