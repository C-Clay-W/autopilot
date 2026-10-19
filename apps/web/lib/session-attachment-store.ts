/**
 * 会话图片附件存储：浏览器上传的图片只保存为会话附件，供 Agent 视觉工具按需读取，不进入 RAG。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentWorkspaceRoot } from "@/lib/agent-workspace";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mimeType || (file.type && file.type !== mimeType)) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  const directory = getSessionAttachmentDirectory(sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const id = crypto.randomUUID();
  const filePath = path.join(directory, `${id}${extension}`);
  const attachment: SessionImageAttachment = { id, name, mimeType, relativePath: getWorkspaceRelativePath(filePath) };
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(temporaryPath, filePath);
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(attachment), "utf8");
  return attachment;
}

/** Resolve browser-submitted attachment IDs only from their own session directory. */
export function resolveSessionImages(sessionId: string, attachmentIds: unknown): SessionImageAttachment[] {
  if (attachmentIds === undefined) return [];
  if (!Array.isArray(attachmentIds)) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
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
  return { attachment, content: new Uint8Array(fs.readFileSync(filePath)) };
}

/** Remove all image bytes and metadata when their owning conversation is deleted. */
export function deleteSessionImages(sessionId: string): void {
  const directory = getSessionAttachmentDirectory(sessionId);
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}
