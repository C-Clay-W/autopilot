/**
 * 会话图片附件存储：浏览器上传的图片只保存为会话附件，供 Agent 视觉工具按需读取，不进入 RAG。
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { getAgentWorkspaceRoot } from "@/lib/agent-workspace";
import { createNodeSessionImageStore } from "@autopilot-agent/adapters";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface SessionImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  relativePath: string;
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
  gifFirstFrame?: boolean;
}

interface UploadedImage {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Work 图片附件的领域错误；校验/缺失与磁盘、元数据等内部故障分别表达。 */
export class SessionAttachmentError extends Error {
  /** 保留附件领域错误码与标准堆栈，HTTP 层仅使用固定安全映射。 */
  constructor(public readonly code: "WORK_ATTACHMENT_INVALID" | "WORK_ATTACHMENT_NOT_FOUND") {
    super(code);
    this.name = "SessionAttachmentError";
  }
}

/** Return the server-controlled attachment directory for one session. */
function getSessionAttachmentDirectory(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  return path.join(getAgentWorkspaceRoot(), ".local", "session-uploads", sessionId);
}

/** Convert an absolute attachment path to a workspace-relative vision tool path. */
function getWorkspaceRelativePath(filePath: string): string {
  const workspaceRoot = getAgentWorkspaceRoot();
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) throw new Error("会话附件不在 Agent 工作区内");
  return relativePath;
}

/** Validate and write one image plus immutable display metadata for later session recovery. */
export async function storeSessionImage(sessionId: string, file: UploadedImage): Promise<SessionImageAttachment> {
  const name = path.basename(file.name);
  const extension = path.extname(name).toLowerCase();
  const inputMimeType = IMAGE_MIME_BY_EXTENSION[extension];
  if (!inputMimeType || (file.type && file.type !== inputMimeType)) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > MAX_IMAGE_BYTES) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  try {
    const attachment = await createNodeSessionImageStore(getAgentWorkspaceRoot()).put({ sessionId, name, mimeType: inputMimeType, bytes });
    if (getWorkspaceRelativePath(path.resolve(getAgentWorkspaceRoot(), attachment.relativePath)) !== attachment.relativePath) throw new Error("图片附件路径越界");
    return attachment;
  }
  catch (error) {
    if (error instanceof Error && (error.message.startsWith("图片") || error.message === "SESSION_IMAGE_INVALID")) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
    throw error;
  }
}

/** Resolve browser-submitted attachment IDs only from their own session directory. */
export function resolveSessionImages(sessionId: string, attachmentIds: unknown): SessionImageAttachment[] {
  if (attachmentIds === undefined) return [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  const directory = getSessionAttachmentDirectory(sessionId);
  const resolved: SessionImageAttachment[] = [];
  for (const id of attachmentIds) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
    const metadataPath = path.join(directory, `${id}.json`);
    if (!fs.existsSync(metadataPath)) throw new SessionAttachmentError("WORK_ATTACHMENT_NOT_FOUND");
    const attachment = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SessionImageAttachment;
    if (attachment.id !== id || !attachment.relativePath || !attachment.name || !attachment.mimeType) throw new Error("图片附件元数据无效");
    resolved.push(attachment);
  }
  return resolved;
}

/** Read one attachment only after both its session metadata and real path stay inside the session directory. */
export function readSessionImage(sessionId: string, attachmentId: string): { attachment: SessionImageAttachment; content: Uint8Array } {
  const [attachment] = resolveSessionImages(sessionId, [attachmentId]);
  if (!attachment) throw new SessionAttachmentError("WORK_ATTACHMENT_NOT_FOUND");
  const directory = fs.realpathSync(getSessionAttachmentDirectory(sessionId));
  const filePath = fs.realpathSync(path.resolve(getAgentWorkspaceRoot(), attachment.relativePath));
  if (!filePath.startsWith(`${directory}${path.sep}`)) throw new Error("图片附件路径越界");
  const content = fs.readFileSync(filePath);
  if (attachment.sha256 && (attachment.bytes !== content.length || crypto.createHash("sha256").update(content).digest("hex") !== attachment.sha256)) throw new Error("图片附件校验失败");
  return { attachment, content: new Uint8Array(content) };
}

/** Remove all image bytes and metadata when their owning conversation is deleted. */
export function deleteSessionImages(sessionId: string): void {
  const directory = getSessionAttachmentDirectory(sessionId);
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}
