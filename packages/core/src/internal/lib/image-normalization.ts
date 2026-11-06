/** 受控图片头检查和 Canvas 规范化，供 Work 输入与 RAG 共用绘制原语。 */
import type { Image } from "@napi-rs/canvas";

/** Work 发送图片的安全大小上限。 */
const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 3_932_160;
const MAX_PIXELS = 40_000_000;
type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** 在解码前从支持格式的有界头部取得类型和尺寸，拒绝无法确认尺寸的文件。 */
function readImageHeader(bytes: Buffer): { mimeType: ImageMime; width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString("ascii") === "IHDR") return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = bytes.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { mimeType: "image/webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { mimeType: "image/jpeg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  throw new Error("图片格式或尺寸无效");
}

/** 按既有打包布局在运行时加载 Canvas 原生绑定，绕开打包器对该模块的静态分析。 */
export async function loadCanvasModule(): Promise<typeof import("@napi-rs/canvas")> {
  let req: NodeRequire;
  try {
    const { createRequire } = await import("node:module");
    req = createRequire(import.meta.url);
  } catch {
    req = eval("require") as NodeRequire;
  }
  return req(Buffer.from("QG5hcGktcnMvY2FudmFz", "base64").toString()) as typeof import("@napi-rs/canvas");
}

/** 按目标尺寸绘制已解码图片，复用同一 Canvas 绘制路径。 */
export async function drawImageCanvas(image: Image, width: number, height: number, background?: string) {
  const { createCanvas } = await loadCanvasModule();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  if (background) { context.fillStyle = background; context.fillRect(0, 0, width, height); }
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/** 规范化 Work 图片；保留合规原图，GIF 使用静态首帧。 */
export async function normalizeWorkImage(input: { bytes: Uint8Array; mimeType?: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mimeType: ImageMime; width: number; height: number; gifFirstFrame: boolean }> {
  if (input.signal?.aborted) throw new Error("图片处理已取消");
  const bytes = Buffer.from(input.bytes);
  if (!bytes.length || bytes.length > MAX_INPUT) throw new Error("图片超过 20 MiB 输入上限");
  const header = readImageHeader(bytes);
  if ((input.mimeType && input.mimeType !== header.mimeType) || !header.width || !header.height || header.width * header.height > MAX_PIXELS) throw new Error("图片类型或像素数无效");
  const { loadImage } = await loadCanvasModule();
  const image = await loadImage(bytes);
  if (!image.width || !image.height || image.width * image.height > MAX_PIXELS || image.width !== header.width || image.height !== header.height) throw new Error("图片解码尺寸无效");
  if (input.signal?.aborted) throw new Error("图片处理已取消");
  if (header.mimeType !== "image/gif" && header.width <= 2000 && header.height <= 2000 && bytes.length <= MAX_OUTPUT && bytes.toString("base64").length <= 5_242_880) return { bytes, mimeType: header.mimeType, width: header.width, height: header.height, gifFirstFrame: false };
  let scale = Math.min(1, 2000 / Math.max(image.width, image.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const png = (await drawImageCanvas(image, width, height)).toBuffer("image/png");
    if (png.length <= MAX_OUTPUT && png.toString("base64").length <= 5_242_880) return { bytes: png, mimeType: "image/png", width, height, gifFirstFrame: header.mimeType === "image/gif" };
    const canvas = await drawImageCanvas(image, width, height, "#ffffff");
    for (const quality of [80, 60, 40, 20]) {
      const jpeg = canvas.toBuffer("image/jpeg", quality);
      if (jpeg.length <= MAX_OUTPUT && jpeg.toString("base64").length <= 5_242_880) return { bytes: jpeg, mimeType: "image/jpeg", width, height, gifFirstFrame: header.mimeType === "image/gif" };
    }
    if (input.signal?.aborted) throw new Error("图片处理已取消");
    scale *= 0.75;
  }
  throw new Error("图片无法压缩到发送上限");
}
