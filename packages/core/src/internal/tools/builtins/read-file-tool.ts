/**
 * read_file 工具：在工作区硬边界内流式分页读取文本，并仅向模型返回请求行区间。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { assertRegularFile } from "../permissions/workspace-path";
import { getReadStateKey, resolveFileTarget, resolveExternalTargetRestriction } from "../permissions/path-access-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { TextFileEncoding } from "../text-file";
import type { AgentToolDefinition } from "../types";
import { MAX_READ_RESULT_BYTES, MAX_TEXT_LINE_CHARACTERS, MAX_TEXT_SCAN_BYTES } from "./text-read-limits";

const readFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(2000).default(2000),
}).strict();

/** 在每个可观察等待点检查取消，避免大文件扫描忽略 Runtime 的 AbortSignal。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "文件读取已取消");
}

/** 从首段字节识别现有支持的文本编码；未带 BOM 的文件只按严格 UTF-8 处理。 */
function getEncoding(bytes: Buffer, final: boolean): { encoding: TextFileEncoding; skipBytes: number } | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return { encoding: "utf8-bom", skipBytes: 3 };
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { encoding: "utf16le", skipBytes: 2 };
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return { encoding: "utf16be", skipBytes: 2 };
  if (bytes.length >= 3 || final) return { encoding: "utf8", skipBytes: 0 };
  return null;
}

/** 将 UTF-16BE 字节转换为 TextDecoder 可消费的 LE 序列，并保留跨 chunk 的半个 code unit。 */
function swapUtf16Be(bytes: Buffer, carry: Buffer): { bytes: Buffer; carry: Buffer } {
  const combined = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
  const length = combined.length - (combined.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = combined[index + 1];
    swapped[index + 1] = combined[index];
  }
  return { bytes: swapped, carry: combined.subarray(length) };
}

/** 对流式字节作严格文本解码，统一将非法编码和 NUL 收敛为二进制拒绝。 */
function decodeChunk(decoder: TextDecoder, bytes: Buffer, stream: boolean): string {
  try {
    const content = decoder.decode(bytes, { stream });
    if (content.includes("\0")) throw new Error("NUL");
    return content;
  } catch {
    throw createToolError(TOOL_ERROR_CODES.BINARY_FILE, "文件不是可安全读取的 UTF-8 或 UTF-16 文本");
  }
}

/** 创建受控文本读取工具定义。 */
export function createReadFileTool(): AgentToolDefinition<z.infer<typeof readFileSchema>, Record<string, unknown>> {
  return {
    name: "read_file",
    description: "读取工作区内文本文件。默认从第 1 行读取最多 2000 行；通读时省略 offset/limit，已知目标位置时用 offset/limit 定位读取，单次最多 2000 行。编辑已有文件前必须先定位并读取目标范围；服务端记录完整文件哈希，模型无需接收整个大文件也能安全编辑。单次最多扫描 8 MiB，返回正文最多 256 KiB；超出正文上限时缩小 limit 或选择更小范围。每次编辑成功后 read state 自动更新。",
    inputSchema: readFileSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 3, resourceKey: "workspace:file-read" }, retry: { safe: true } },
    async createActionFacts(input, context) {
      // Talk-Plan1013 Stage5 R5：外部目标先查当前 Read 限制——deny 在任何正文读取前硬拒绝，
      // ask 该次调用逐次确认（allow_once-only，不写持久规则）；allow 与工作区内目标维持读取免新增路径审批。
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      const restriction = await resolveExternalTargetRestriction(context, target, "read_file");
      return {
        toolName: "read_file",
        effect: "none",
        destructive: false,
        operation: "read",
        risk: "read_only",
        ...(target.isExternal ? {
          externalTarget: { canonicalTarget: target.canonicalTarget, canonicalWorkspace: target.canonicalWorkspace },
          externalRestriction: restriction,
        } : {}),
        ...(restriction === "deny" ? { hardDenyReason: "读取该工作区外文件已被显式规则拒绝" } : {}),
        ...(restriction === "ask" ? { requiresApproval: true, approval: { reason: "读取该工作区外文件需要逐次确认" } } : {}),
      };
    },
    async execute(input, context) {
      throwIfAborted(context.signal);
      // Talk-Plan1013 Stage 1：合法外部目标在此通过预检，读取免新增路径审批；路径安全与既有读取策略保持。
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      if (!target.exists) throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "文件不存在");
      await assertRegularFile(target.absolutePath);
      const initialStats = await stat(target.absolutePath);
      if (initialStats.size > MAX_TEXT_SCAN_BYTES) throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "文件超过 8 MiB 安全扫描上限");

      const hash = createHash("sha256");
      const selectedLines: string[] = [];
      let selectedBytes = 0;
      let totalLines = 0;
      let currentLine = "";
      let ignoreLfAfterCr = false;
      let encoding: TextFileEncoding | undefined;
      let decoder: TextDecoder | undefined;
      let prefix: Buffer = Buffer.alloc(0);
      let utf16beCarry: Buffer = Buffer.alloc(0);
      let scannedBytes = 0;

      /** 记录一行的总数与请求区间；不保留区间外的正文。 */
      function captureLine(line: string): void {
        totalLines += 1;
        if (totalLines < input.offset || totalLines >= input.offset + input.limit) return;
        const lineBytes = Buffer.byteLength(line, "utf8");
        const separatorBytes = selectedLines.length > 0 ? 1 : 0;
        if (selectedBytes + separatorBytes + lineBytes > MAX_READ_RESULT_BYTES) {
          throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "请求行区间超过 256 KiB 返回上限，请缩小 limit 或选择更小范围");
        }
        selectedBytes += separatorBytes + lineBytes;
        selectedLines.push(line);
      }

      /** 消费解码后的文本并正确合并 CRLF、跨 chunk 行与末尾空行。 */
      function consumeText(content: string): void {
        for (let index = 0; index < content.length; index += 1) {
          const character = content[index];
          if (ignoreLfAfterCr) {
            ignoreLfAfterCr = false;
            if (character === "\n") continue;
          }
          if (character === "\r") {
            captureLine(currentLine);
            currentLine = "";
            ignoreLfAfterCr = true;
            continue;
          }
          if (character === "\n") {
            captureLine(currentLine);
            currentLine = "";
            continue;
          }
          currentLine += character;
          if (currentLine.length > MAX_TEXT_LINE_CHARACTERS) {
            throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "文件存在超过 64 Ki 字符的单行，拒绝无界读取");
          }
        }
      }

      /** 初始化编码解码器后处理前缀字节，避免 BOM 被错误显示给模型。 */
      function initializeDecoder(final: boolean): void {
        if (decoder) return;
        const detected = getEncoding(prefix, final);
        if (!detected) return;
        encoding = detected.encoding;
        decoder = new TextDecoder(encoding === "utf8" || encoding === "utf8-bom" ? "utf-8" : "utf-16le", { fatal: true });
        const initial = prefix.subarray(detected.skipBytes);
        prefix = Buffer.alloc(0);
        if (encoding === "utf16be") {
          const swapped = swapUtf16Be(initial, utf16beCarry);
          utf16beCarry = swapped.carry;
          consumeText(decodeChunk(decoder, swapped.bytes, true));
        } else {
          consumeText(decodeChunk(decoder, initial, true));
        }
      }

      /** 解码后续字节；UTF-16BE 保持单个跨 chunk 字节而不拼接完整文件。 */
      function consumeBytes(bytes: Buffer): void {
        if (!decoder) {
          prefix = Buffer.concat([prefix, bytes]);
          initializeDecoder(false);
          return;
        }
        if (encoding === "utf16be") {
          const swapped = swapUtf16Be(bytes, utf16beCarry);
          utf16beCarry = swapped.carry;
          consumeText(decodeChunk(decoder, swapped.bytes, true));
          return;
        }
        consumeText(decodeChunk(decoder, bytes, true));
      }

      const stream = createReadStream(target.absolutePath, { highWaterMark: 64 * 1024 });
      const abort = function abortRead(): void { stream.destroy(createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "文件读取已取消")); };
      context.signal?.addEventListener("abort", abort, { once: true });
      try {
        for await (const chunk of stream) {
          throwIfAborted(context.signal);
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          scannedBytes += bytes.byteLength;
          if (scannedBytes > MAX_TEXT_SCAN_BYTES) throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "文件超过 8 MiB 安全扫描上限");
          hash.update(bytes);
          consumeBytes(bytes);
        }
        initializeDecoder(true);
        if (!decoder || !encoding) {
          encoding = "utf8";
          decoder = new TextDecoder("utf-8", { fatal: true });
        }
        if (encoding === "utf16be" && utf16beCarry.length > 0) throw createToolError(TOOL_ERROR_CODES.BINARY_FILE, "UTF-16BE 文件包含不完整 code unit");
        consumeText(decodeChunk(decoder, Buffer.alloc(0), false));
        captureLine(currentLine);
        throwIfAborted(context.signal);
      } finally {
        context.signal?.removeEventListener("abort", abort);
        stream.destroy();
      }

      const finalStats = await stat(target.absolutePath);
      if (finalStats.size !== initialStats.size || finalStats.mtimeMs !== initialStats.mtimeMs) {
        throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "文件读取期间已变化，请重新读取");
      }
      const startLine = Math.min(input.offset, totalLines + 1);
      const endLine = startLine + selectedLines.length - 1;
      const truncated = endLine < totalLines;
      const isCompleteRead = startLine === 1 && !truncated;
      const fullSha256 = hash.digest("hex");
      const readStateKey = getReadStateKey(target);
      const existing = context.fileReadStates?.get(readStateKey);
      const observedRanges = existing?.observedRanges ?? [];
      const newRange = selectedLines.length > 0 ? { startLine, endLine } : undefined;
      const merged = newRange ? [...observedRanges, newRange].sort(function byStart(left, right) { return left.startLine - right.startLine; }) : observedRanges;
      const compact: typeof observedRanges = [];
      for (const range of merged) {
        const last = compact[compact.length - 1];
        if (last && last.endLine >= range.startLine - 1) last.endLine = Math.max(last.endLine, range.endLine);
        else compact.push({ ...range });
      }
      context.fileReadStates?.set(readStateKey, { sha256: fullSha256, mtimeMs: finalStats.mtimeMs, observedRanges: compact });
      return {
        // 外部目标返回 canonical 绝对路径供后续 edit/read 复用；内部目标维持工作区相对路径契约。
        path: target.isExternal ? target.canonicalTarget : target.relativePath!,
        content: selectedLines.join("\n"),
        startLine,
        endLine,
        totalLines,
        truncated,
        isCompleteRead,
        sha256: isCompleteRead ? fullSha256 : null,
        encoding,
      };
    },
    serializeOutput(output) { return output; },
  };
}
