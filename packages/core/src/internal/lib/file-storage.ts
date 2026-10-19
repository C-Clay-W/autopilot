/**
 * 文件存储管理
 * - 独立数据目录（如 D:/rag-data/files/）
 * - 原图/缩略图一并保存
 */
import path from "node:path";
import { copyFile, mkdir, readFile, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { RagError } from "../rag-error";

const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 返回可配置的文件存储根目录 */
export function getStoragePath(storagePath?: string): string {
  return path.resolve(storagePath || process.env.RAG_FILE_STORAGE_PATH || "./rag-files");
}

/** 清理文件名，避免写入非法路径字符 */
function sanitizeFileName(fileName: string): string {
  return path.basename(fileName).replace(/[\\/:*?"<>|]/g, "_");
}

/** 将文件 Buffer 保存到本地存储目录，并返回绝对路径 */
export async function saveFile(
  buffer: Buffer,
  fileName: string,
  storagePath?: string,
): Promise<{ filePath: string; thumbnailPath?: string }> {
  const resolvedStoragePath = getStoragePath(storagePath);
  await mkdir(resolvedStoragePath, { recursive: true });
  const safeFileName = sanitizeFileName(fileName);
  const filePath = path.join(resolvedStoragePath, safeFileName);
  await writeFile(filePath, buffer);
  return { filePath };
}

/**
 * 将已保存的受信任页面图片读取为视觉模型可用的 data URL。
 *
 * 仅允许读取 RAG_FILE_STORAGE_PATH 下的 PNG/JPEG/WebP 文件，并限制文件体积，
 * 防止 LanceDB metadata 中的任意路径触发工作区外文件读取。
 *
 * @param imagePath LanceDB metadata 中保存的绝对或相对图片路径
 * @returns 图片 data URL
 */
export async function readStoredImageAsDataUrl(imagePath: string): Promise<string> {
  const { buffer, mimeType } = await readStoredImage(imagePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * 按文件名读取存储目录中的图片二进制，供受控 HTTP 图片响应使用。
 *
 * @param fileName 图片基础文件名，不能包含路径分隔符
 * @returns 图片二进制与 MIME 类型
 */
export async function readStoredImageByName(
  fileName: string,
  storagePath?: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!fileName || path.basename(fileName) !== fileName || sanitizeFileName(fileName) !== fileName) {
    throw new Error("图片文件名非法");
  }
  return readStoredImage(path.join(getStoragePath(storagePath), fileName), storagePath);
}

/**
 * 按文件名读取存储图片并转换为视觉模型可用的 data URL。
 *
 * @param fileName 图片基础文件名
 * @returns 图片 data URL
 */
export async function readStoredImageByNameAsDataUrl(fileName: string, storagePath?: string): Promise<string> {
  const { buffer, mimeType } = await readStoredImageByName(fileName, storagePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/** 删除已被资源记录引用的 PDF 页面图片，只允许删除受控存储目录内的受支持图片。 */
export async function deleteStoredImagesByName(fileNames: string[], storagePath?: string): Promise<number> {
  const uniqueNames = [...new Set(fileNames)].filter((fileName) => (
    fileName
    && path.basename(fileName) === fileName
    && sanitizeFileName(fileName) === fileName
    && Boolean(IMAGE_MIME_TYPES[path.extname(fileName).toLowerCase()])
  ));
  let deletedCount = 0;
  for (const fileName of uniqueNames) {
    try {
      await unlink(path.join(getStoragePath(storagePath), fileName));
      deletedCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return deletedCount;
}

/**
 * 校验并读取存储目录中的图片二进制。
 *
 * @param imagePath 图片绝对或相对路径
 * @returns 图片二进制与 MIME 类型
 */
async function readStoredImage(
  imagePath: string,
  storagePath?: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const absoluteStoragePath = getStoragePath(storagePath);
  const absoluteImagePath = path.resolve(imagePath);
  const relativePath = path.relative(absoluteStoragePath, absoluteImagePath);
  const mimeType = IMAGE_MIME_TYPES[path.extname(absoluteImagePath).toLowerCase()];

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("PDF 来源图片路径不在 RAG_FILE_STORAGE_PATH 目录内");
  }
  if (!mimeType) {
    throw new Error("PDF 来源图片类型不受支持");
  }

  const info = await lstat(absoluteImagePath);
  if (info.isSymbolicLink() || path.dirname(await realpath(absoluteImagePath)) !== await realpath(absoluteStoragePath)) throw new RagError("RAG_STORAGE_INVALID");
  if (!info.isFile()) {
    throw new Error("PDF 来源图片不是普通文件");
  }
  if (info.size > MAX_VISION_IMAGE_BYTES) {
    throw new Error("PDF 来源图片超过视觉问答大小限制");
  }

  const buffer = await readFile(absoluteImagePath);
  return { buffer, mimeType };
}

/** 将原始 PDF 复制到受控来源目录；文件名只由 Core 生成。 */
export async function saveOriginalPdf(pdfPath: string, storedPdfFileName: string, sourcePath: string): Promise<string> {
  if (!/^pdf-[a-f0-9]{32}\.pdf$/.test(storedPdfFileName)) throw new RagError("RAG_STORAGE_INVALID");
  const absoluteSourcePath = path.resolve(sourcePath);
  await mkdir(absoluteSourcePath, { recursive: true });
  const target = path.join(absoluteSourcePath, storedPdfFileName);
  await copyFile(path.resolve(pdfPath), target);
  return target;
}

/** 解析受控来源目录中的原始 PDF，拒绝浏览器路径和目录逃逸。 */
export function resolveStoredPdf(storedPdfFileName: string, sourcePath: string): string {
  if (!/^pdf-[a-f0-9]{32}\.pdf$/.test(storedPdfFileName)) throw new RagError("RAG_STORAGE_INVALID");
  const absoluteSourcePath = path.resolve(sourcePath);
  const target = path.resolve(absoluteSourcePath, storedPdfFileName);
  const relative = path.relative(absoluteSourcePath, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new RagError("RAG_STORAGE_INVALID");
  return target;
}

/** 删除 manifest 已引用的来源文件，只接受 Core 生成的受控名称。 */
export async function deleteStoredSource(storedSourceFileName: string, sourcePath: string): Promise<boolean> {
  if (!/^(?:pdf-[a-f0-9]{32}\.pdf|source-[a-f0-9]{32}\.[a-z0-9]+)$/.test(storedSourceFileName)) throw new RagError("RAG_STORAGE_INVALID");
  try {
    await unlink(path.join(path.resolve(sourcePath), storedSourceFileName));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 只读取 manifest 指定的普通来源文件，拒绝链接和目录逃逸并限制预览大小。 */
export async function readStoredSource(fileName: string, sourcePath: string): Promise<Buffer> {
  if (!/^source-[a-f0-9]{32}\.[a-z0-9]+$/.test(fileName)) throw new RagError("RAG_STORAGE_INVALID");
  const target = path.join(path.resolve(sourcePath), fileName);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024 || path.dirname(await realpath(target)) !== await realpath(sourcePath)) throw new RagError("RAG_STORAGE_INVALID");
  return readFile(target);
}

/** 预览/OCR 使用的 PDF 必须仍是当前来源根中的普通文件，拒绝链接来源。 */
export async function resolveReadableStoredPdf(fileName: string, sourcePath: string): Promise<string> {
  const target = resolveStoredPdf(fileName, sourcePath);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(target)) !== await realpath(sourcePath)) throw new RagError("RAG_STORAGE_INVALID");
  return target;
}
