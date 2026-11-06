/** Node Work 会话图片存储：规范化副本并按工作区、会话及哈希校验。 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkImage, type SessionImageRef, type SessionImageStore } from "@autopilot-agent/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 返回受控会话目录；逐层拒绝符号链接，避免写入其他工作区。 */
function sessionDirectory(root: string, sessionId: string, create: boolean): string {
  if (!UUID.test(sessionId)) throw new Error("SESSION_IMAGE_INVALID");
  let current = fs.realpathSync(root);
  for (const part of [".local", "session-uploads", sessionId]) {
    current = path.join(current, part);
    if (create) {
      try { fs.mkdirSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SESSION_IMAGE_INVALID");
  }
  return current;
}

/** 创建绑定单一工作区的图片存储，不接收外部传入的存储路径。 */
export function createNodeSessionImageStore(workspaceRoot: string): SessionImageStore {
  return {
    /** 校验并保存规范化副本与不可变元数据。 */
    async put(input) {
      let normalized: Awaited<ReturnType<typeof normalizeWorkImage>>;
      try { normalized = await normalizeWorkImage({ bytes: input.bytes, mimeType: input.mimeType }); }
      catch { throw new Error("SESSION_IMAGE_INVALID"); }
      const directory = sessionDirectory(workspaceRoot, input.sessionId, true);
      const id = crypto.randomUUID();
      const extension = normalized.mimeType === "image/jpeg" ? ".jpg" : normalized.mimeType === "image/png" ? ".png" : normalized.mimeType === "image/webp" ? ".webp" : ".gif";
      const bytes = Buffer.from(normalized.bytes);
      const image: SessionImageRef = { id, name: path.basename(input.name), mimeType: normalized.mimeType, relativePath: `.local/session-uploads/${input.sessionId}/${id}${extension}`, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), width: normalized.width, height: normalized.height, bytes: bytes.length, gifFirstFrame: normalized.gifFirstFrame };
      fs.writeFileSync(path.join(directory, `${id}${extension}`), bytes, { flag: "wx" });
      fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(image), { flag: "wx" });
      return image;
    },
    /** 按会话和图片标识读取并复核文件哈希。 */
    async read(input) {
      if (!UUID.test(input.id)) throw new Error("SESSION_IMAGE_INVALID");
      const directory = sessionDirectory(workspaceRoot, input.sessionId, false);
      const metadataPath = path.join(directory, `${input.id}.json`);
      const metadataStat = fs.lstatSync(metadataPath);
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 4096) throw new Error("SESSION_IMAGE_INVALID");
      const image = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SessionImageRef;
      const extension = image.mimeType === "image/jpeg" ? ".jpg" : image.mimeType === "image/png" ? ".png" : image.mimeType === "image/webp" ? ".webp" : image.mimeType === "image/gif" ? ".gif" : "";
      if (!extension || image.id !== input.id || image.relativePath !== `.local/session-uploads/${input.sessionId}/${input.id}${extension}` || !/^[0-9a-f]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 3_932_160) throw new Error("SESSION_IMAGE_INVALID");
      const filePath = path.join(directory, `${input.id}${extension}`);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.bytes) throw new Error("SESSION_IMAGE_INVALID");
      const bytes = fs.readFileSync(filePath);
      if (bytes.length !== image.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("SESSION_IMAGE_INVALID");
      return { image, bytes };
    },
  };
}
