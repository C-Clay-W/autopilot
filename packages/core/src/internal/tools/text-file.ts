/**
 * 文本文件编解码与换行工具：只接受可无损往返的 UTF-8/UTF-16 文本，拒绝未知或二进制编码。
 */
import { createToolError, TOOL_ERROR_CODES } from "./tool-error";

export type TextFileEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";
export type LineEnding = "\n" | "\r\n" | "\r";

/** 识别 UTF-8 / UTF-16 BOM 并安全解码，避免将未知二进制误当作文本编辑。 */
export function decodeTextFile(buffer: Buffer): { content: string; encoding: TextFileEncoding } {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { content: buffer.subarray(3).toString("utf8"), encoding: "utf8-bom" };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { content: buffer.subarray(2).toString("utf16le"), encoding: "utf16le" };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const current = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = current;
    }
    return { content: swapped.toString("utf16le"), encoding: "utf16be" };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (content.includes("\0")) throw new Error("NUL");
    return { content, encoding: "utf8" };
  } catch {
    throw createToolError(TOOL_ERROR_CODES.BINARY_FILE, "文件不是可安全编辑的 UTF-8 或 UTF-16 文本");
  }
}

/** 保持输入文件的编码与 BOM，避免编辑后无意改变文本格式。 */
export function encodeTextFile(content: string, encoding: TextFileEncoding): Buffer {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  if (encoding === "utf8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
  const utf16le = Buffer.from(content, "utf16le");
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]);
  const utf16be = Buffer.from(utf16le);
  for (let index = 0; index + 1 < utf16be.length; index += 2) {
    const current = utf16be[index];
    utf16be[index] = utf16be[index + 1];
    utf16be[index + 1] = current;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]);
}

/** 将任意换行统一为 LF，供模型输出与文件内容进行稳定匹配。 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

/** 保留目标文件的主要换行风格，避免全文件出现无意义 diff。 */
export function detectLineEnding(content: string): LineEnding {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (content.match(/\r(?!\n)/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

/** 将规范化 LF 文本恢复为原文件的换行风格。 */
export function restoreLineEndings(content: string, lineEnding: LineEnding): string {
  return lineEnding === "\n" ? content : content.replace(/\n/g, lineEnding);
}
