/**
 * 知识上传的共用适配；当前 Work Route 已停用，保留供 Chat 知识入库复用。
 *
 * 仅接受受信宿主给出的知识根，复用 Core RAG Agent 并按根串行化入库/删除，
 * 锁只在 Core promise 真正结束后释放。
 */
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { loadCore } from "./core-loader";
import { KnowledgeUploadError } from "./knowledge-error";
import type { RAGAgentOptions } from "@autopilot-agent/core";

/** canonical 上传支持的文档类型。 */
export type KnowledgeUploadType = "pdf" | "text" | "excel" | "image";

/** Web 校验后的上传对象。 */
export interface ValidatedKnowledgeUpload { type: KnowledgeUploadType; file: File; safeName: string; buffer: Buffer; }

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const queues = new Map<string, Promise<void>>();

/** 将同一知识根的写任务串行执行，并在 Core 完成后释放队列槽位。 */
export async function withKnowledgeWriteLock<T>(ragRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(ragRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(function createRelease(resolve) { release = resolve; });
  const tail = previous.then(function waitPrevious() { return current; });
  queues.set(ragRoot, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(ragRoot) === tail) queues.delete(ragRoot);
  }
}

/** 根据扩展名、声明 MIME 与 magic bytes 统一校验上传。 */
export async function validateKnowledgeUpload(file: File): Promise<ValidatedKnowledgeUpload> {
  const safeName = path.basename(file.name).replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!safeName || safeName !== file.name) throw new KnowledgeUploadError("UPLOAD_NAME_INVALID");
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new KnowledgeUploadError("UPLOAD_SIZE_INVALID");
  const extension = path.extname(safeName).toLowerCase();
  const type: KnowledgeUploadType = extension === ".pdf" ? "pdf"
    : extension === ".xlsx" || extension === ".xls" ? "excel"
      : [".png", ".jpg", ".jpeg", ".webp"].includes(extension) ? "image"
      : extension === ".txt" || extension === ".md" || extension === ".docx" ? "text"
        : (() => { throw new KnowledgeUploadError("UPLOAD_TYPE_UNSUPPORTED"); })();
  const buffer = Buffer.from(await file.arrayBuffer());
  if (type === "image") {
    if (buffer.length > 20 * 1024 * 1024) throw new KnowledgeUploadError("UPLOAD_SIZE_INVALID");
    const mime = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? "image/jpeg" : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
    const expected = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    if (mime !== expected || (file.type && file.type !== mime)) throw new KnowledgeUploadError("UPLOAD_MIME_INVALID");
  }
  const isPdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle = buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (type === "pdf" && !isPdf) throw new KnowledgeUploadError("UPLOAD_MIME_INVALID");
  if ((extension === ".docx" || extension === ".xlsx") && !isZip) throw new KnowledgeUploadError("UPLOAD_MIME_INVALID");
  if (extension === ".xls" && !isOle) throw new KnowledgeUploadError("UPLOAD_MIME_INVALID");
  if (file.type && type === "pdf" && file.type !== "application/pdf") throw new KnowledgeUploadError("UPLOAD_MIME_INVALID");
  return { type, file, safeName, buffer };
}

/** 在系统临时目录中执行一次入库，并保证 finally 清理。 */
export async function ingestKnowledgeUpload(
  ragRoot: string,
  upload: ValidatedKnowledgeUpload,
  signal: AbortSignal,
  onProgress: (event: unknown) => void,
  ragOptions: Omit<RAGAgentOptions, "storage"> = {},
) {
  return withKnowledgeWriteLock(ragRoot, async function ingestUnderLock() {
    const temporaryRoot = path.join(os.tmpdir(), "autopilot-knowledge", randomUUID());
    const temporaryFile = path.join(temporaryRoot, upload.safeName);
    signal.throwIfAborted();
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryFile, upload.buffer, { flag: "wx", mode: 0o600 });
      const rag = loadCore().createRAGAgent({ ...ragOptions, storage: { rootPath: ragRoot } });
      return await rag.ingest(temporaryFile, { type: upload.type, displayName: upload.safeName, title: upload.safeName, signal, onProgress });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
