/** 通过受信宿主端口读取会话图片，Kernel 不依赖宿主目录结构。 */
import type { SessionImageStore } from "../../runtime/ports/session-image-store";
import { getAgentImageReferences, type AgentImageReference, type AgentMessage } from "../types/agent-message";
import type { ModelImageData } from "./model-sampler";

const REQUEST_IMAGE_BASE64_BYTES = 28 * 1024 * 1024;
const TOOL_IMAGE_BASE64_BYTES = 6 * 1024 * 1024;

/** 会话图片缺失、越权或损坏时使用固定内部错误，不暴露宿主路径。 */
export class SessionImageError extends Error {
  /** 创建不包含宿主路径的固定图片错误。 */
  constructor() { super("会话图片不可用或已损坏"); this.name = "SessionImageError"; }
}

/** 请求超过编码总预算时保留用户附件并要求显式缩减上下文。 */
export class SessionImageBudgetError extends SessionImageError {
  /** 使用可操作且不包含本机路径的固定提示。 */
  constructor() { super(); this.message = "当前请求的图片总量超过上限，请压缩会话历史或减少图片后重试"; this.name = "SessionImageBudgetError"; }
}

/** 读取宿主验证后的不可变副本，采样时才展开 Base64。 */
export async function readSessionImageData(store: SessionImageStore | undefined, sessionId: string | undefined, id: string, remainingBase64Bytes = 5_242_880) {
  if (!store || !sessionId) throw new SessionImageError();
  try {
    const { image, bytes } = await store.read({ sessionId, id });
    if (!bytes.length || bytes.length !== image.bytes || bytes.length > 3_932_160 || image.id !== id || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) throw new SessionImageError();
    // 在分配编码字符串前检查实际字节，避免先展开完整历史再发现超限。
    if (4 * Math.ceil(bytes.length / 3) > remainingBase64Bytes) throw new SessionImageBudgetError();
    const data = Buffer.from(bytes).toString("base64");
    if (data.length > 5_242_880) throw new SessionImageError();
    return { image, data };
  } catch (error) { if (error instanceof SessionImageBudgetError) throw error; throw new SessionImageError(); }
}

/** 投影图片引用；仅改变本次请求，checkpoint 和用户附件原样保留。 */
function projectImages(messages: AgentMessage[], retained: Map<object, AgentImageReference[]>, fallback: boolean): AgentMessage[] {
  return messages.map(function projectMessage(message) {
    return { ...message, content: message.content.map(function projectBlock(block) {
      if (fallback && block.type === "image-ref") return { type: "text" as const, text: "[图片已交由视觉工具分析]" };
      if (block.type !== "tool-result" || !block.images?.length) return block;
      const { images, ...result } = block;
      const kept = fallback ? [] : retained.get(block) ?? [];
      const omitted = images.length - kept.length;
      return { ...result, content: omitted ? [...result.content, { type: "text" as const, text: fallback ? "[图片已交由视觉工具分析]" : `[older tool image omitted: image budget exceeded; count=${omitted}]` }] : result.content, ...(kept.length ? { images: kept } : {}) };
    }) };
  });
}

/** 按全请求与工具子预算展开图片；回退只读下一个尚未完成的图片。 */
export async function prepareSessionImages(messages: AgentMessage[], store: SessionImageStore | undefined, sessionId: string | undefined, fallback: boolean, completedIds: ReadonlySet<string>) {
  for (const message of messages) if (getAgentImageReferences(message).length > 10) throw new SessionImageError();
  const imageData: ModelImageData = {};
  const metadata = new Map<string, Awaited<ReturnType<typeof readSessionImageData>>["image"]>();
  const retained = new Map<object, AgentImageReference[]>();
  /** 仅缓存本次选中图片，并逐次复核引用不可变身份。 */
  async function hydrate(reference: AgentImageReference, remaining: number) {
    if (remaining <= 0) throw new SessionImageBudgetError();
    const cached = imageData[reference.id];
    if (cached && cached.data.length > remaining) throw new SessionImageBudgetError();
    const loaded = cached ? { image: metadata.get(reference.id)!, data: cached.data } : await readSessionImageData(store, sessionId, reference.id, remaining);
    if (loaded.image.sha256 !== reference.sha256 || loaded.image.width !== reference.width || loaded.image.height !== reference.height) throw new SessionImageError();
    imageData[reference.id] = { mimeType: loaded.image.mimeType as ModelImageData[string]["mimeType"], data: loaded.data };
    metadata.set(reference.id, loaded.image);
    return loaded;
  }
  if (fallback) {
    const reference = messages.flatMap(getAgentImageReferences).find(function pending(image) { return !completedIds.has(image.id); });
    const pendingImage = reference ? { reference, image: (await hydrate(reference, 5_242_880)).image } : undefined;
    return { messages: projectImages(messages, retained, true), imageData: {} as ModelImageData, pendingImage };
  }
  let requestBytes = 0;
  for (const message of messages) {
    const images = message.content.filter(function userImage(block): block is AgentImageReference { return block.type === "image-ref"; });
    let messageBytes = 0;
    for (const reference of images) {
      const loaded = await hydrate(reference, REQUEST_IMAGE_BASE64_BYTES - requestBytes);
      requestBytes += loaded.data.length;
      messageBytes += loaded.image.bytes;
    }
    if (messageBytes > 20 * 1024 * 1024) throw new SessionImageError();
  }
  let toolBytes = 0;
  let exhausted = false;
  for (let index = messages.length - 1; index >= 0; index--) for (const block of messages[index].content) {
    if (block.type !== "tool-result" || !block.images?.length) continue;
    const kept: AgentImageReference[] = [];
    for (let imageIndex = block.images.length - 1; imageIndex >= 0; imageIndex--) {
      if (exhausted) break;
      const reference = block.images[imageIndex];
      try {
        const loaded = await hydrate(reference, Math.min(TOOL_IMAGE_BASE64_BYTES - toolBytes, REQUEST_IMAGE_BASE64_BYTES - requestBytes));
        toolBytes += loaded.data.length;
        requestBytes += loaded.data.length;
        kept.unshift(reference);
      } catch (error) {
        if (!(error instanceof SessionImageBudgetError)) throw error;
        exhausted = true;
      }
    }
    retained.set(block, kept);
  }
  return { messages: projectImages(messages, retained, false), imageData, pendingImage: undefined };
}
