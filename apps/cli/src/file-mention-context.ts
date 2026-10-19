/**
 * CLI 提交侧 @文件 mention 解析：从 prompt 原文提取 @ 引用，校验工作区边界后读取文件或
 * 列目录一层，把有界内容以 `<system-reminder>` 附加块按出现顺序拼回 content；
 * 失败路径（未找到/越界/过大/读取失败）降级为 notice，不阻断提交。
 */

import { readFile as nodeReadFile, readdir as nodeReaddir, stat as nodeStat } from "node:fs/promises";
import path from "node:path";
import { FILE_MENTION_TOKEN_CHARACTER } from "./tui/input/file-mention.js";

/** 单文件扫描上限（对齐 core read_file 的 8MiB 扫描上限），超出直接拒绝。 */
const FILE_MENTION_SIZE_LIMIT = 8 * 1024 * 1024;
/** 附加内容行数上限，超出截断。 */
const FILE_MENTION_LINE_LIMIT = 2000;
/** 附加内容字节上限（UTF-8），超出截断。 */
const FILE_MENTION_BYTES_LIMIT = 256 * 1024;
/** 目录一层条目上限，超出截断并标注。 */
const FILE_MENTION_DIRECTORY_LIMIT = 100;

/** resolveFileMentionContext 依赖的最小文件系统接缝；测试可注入受控实现。 */
export interface FileMentionFs {
  /** 返回目标的存在性形态与字节大小；目标不存在时抛错。 */
  stat(absolutePath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  /** 以 UTF-8 读取目标文件全文。 */
  readFile(absolutePath: string): Promise<string>;
  /** 列出目录一层条目（不递归）。 */
  listDirectory(absolutePath: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
}

/** 默认接缝实现：直接使用 node:fs/promises。 */
const nodeFileMentionFs: FileMentionFs = {
  async stat(absolutePath) {
    const stats = await nodeStat(absolutePath);
    return { isFile: stats.isFile(), isDirectory: stats.isDirectory(), size: stats.size };
  },
  readFile(absolutePath) {
    return nodeReadFile(absolutePath, "utf8");
  },
  async listDirectory(absolutePath) {
    const entries = await nodeReaddir(absolutePath, { withFileTypes: true });
    return entries.map(function toEntry(entry) {
      return { name: entry.name, isDirectory: entry.isDirectory() };
    });
  },
};

/** resolveFileMentionContext 的返回契约；无有效 @ 引用时 content 保持原文。 */
export interface ResolvedFileMentionContext {
  /** 增强后的 prompt：原文 + `<system-reminder>` 附加块（至少一个 @ 引用成功时）。 */
  content: string;
  /** 面向用户的失败提示，按 mention 出现顺序。 */
  notices: string[];
}

/** 从 prompt 原文提取 @ 引用的相对路径；`@` 必须位于行首或空白后，去重保序，`\` 归一为 `/`。 */
export function extractFileMentions(content: string): string[] {
  const mentions: string[] = [];
  for (const match of content.matchAll(/(^|\s)@/gu)) {
    // 从 @ 后取连续合法 token 字符：空白结束，中文标点等非法字符同样结束（plan 冻结的 token 字符集契约）。
    const atEnd = match.index! + match[0].length;
    let end = atEnd;
    while (end < content.length && FILE_MENTION_TOKEN_CHARACTER.test(content[end]!)) end += 1;
    if (end === atEnd) continue;
    const mentionPath = content.slice(atEnd, end).replace(/\\/g, "/");
    if (!mentions.includes(mentionPath)) mentions.push(mentionPath);
  }
  return mentions;
}

/** 校验 mention 为工作区内相对路径：拒绝空路径、绝对路径、UNC/盘符与 `..` 逃逸。 */
function isInsideWorkspace(workspaceRoot: string, mentionPath: string): boolean {
  if (mentionPath === "" || mentionPath.includes("\0")) return false;
  if (mentionPath.startsWith("/") || path.win32.isAbsolute(mentionPath)) return false;
  const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, mentionPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 按 UTF-8 字节边界截断单行文本，回退扫描避免切断多字节字符。 */
function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** 逐行累积保留前 2000 行且不超过 256KiB；单行超限时对该行做字节级截断兜底。 */
function boundedFileText(text: string): { content: string; label: string } {
  const allLines = text.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const selected: string[] = [];
  let bytes = 0;
  for (const line of allLines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
    if (selected.length >= FILE_MENTION_LINE_LIMIT || bytes + lineBytes > FILE_MENTION_BYTES_LIMIT) break;
    selected.push(line);
    bytes += lineBytes;
  }
  if (selected.length === 0 && allLines.length > 0) {
    return {
      content: truncateUtf8ByBytes(allLines[0]!, FILE_MENTION_BYTES_LIMIT),
      label: `前 256KiB，共 ${allLines.length} 行`,
    };
  }
  if (selected.length < allLines.length) {
    return { content: selected.join("\n"), label: `前 ${selected.length} 行，共 ${allLines.length} 行` };
  }
  return { content: selected.join("\n"), label: `${allLines.length} 行` };
}

/** 解析单个 @ 引用；成功返回附加块小节，失败写入 notice 并返回 undefined。 */
async function resolveSingleMention(
  mentionPath: string,
  workspaceRoot: string,
  fs: FileMentionFs,
  notices: string[],
): Promise<string | undefined> {
  if (!isInsideWorkspace(workspaceRoot, mentionPath)) {
    notices.push(`@${mentionPath} 超出工作区边界，已拒绝读取`);
    return undefined;
  }
  const absolutePath = path.resolve(workspaceRoot, mentionPath);
  let stats: { isFile: boolean; isDirectory: boolean; size: number };
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    notices.push(`@${mentionPath} 未找到`);
    return undefined;
  }

  if (stats.isFile) {
    if (stats.size > FILE_MENTION_SIZE_LIMIT) {
      notices.push(`@${mentionPath} 超过 8MiB，已拒绝读取`);
      return undefined;
    }
    let text: string;
    try {
      text = await fs.readFile(absolutePath);
    } catch {
      notices.push(`@${mentionPath} 读取失败`);
      return undefined;
    }
    const bounded = boundedFileText(text);
    return `--- @${mentionPath} (${bounded.label}) ---\n${bounded.content}`;
  }

  if (stats.isDirectory) {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = await fs.listDirectory(absolutePath);
    } catch {
      notices.push(`@${mentionPath} 读取失败`);
      return undefined;
    }
    const sorted = entries.slice().sort(function compareEntries(left, right) {
      return left.name.localeCompare(right.name);
    });
    const selected = sorted.slice(0, FILE_MENTION_DIRECTORY_LIMIT);
    const label = sorted.length > FILE_MENTION_DIRECTORY_LIMIT
      ? `前 ${FILE_MENTION_DIRECTORY_LIMIT} 项，共 ${sorted.length} 项`
      : `${sorted.length} 项`;
    const content = selected
      .map(function renderEntry(entry) {
        return entry.isDirectory ? `${entry.name}/` : entry.name;
      })
      .join("\n");
    return `--- @${mentionPath} (${label}) ---\n${content}`;
  }

  notices.push(`@${mentionPath} 未找到`);
  return undefined;
}

/** 解析 prompt 中的全部 @ 引用并构造增强 content；至少一个引用成功时在原文后追加附加块。 */
export async function resolveFileMentionContext(
  content: string,
  workspaceRoot: string,
  options: { fs?: FileMentionFs } = {},
): Promise<ResolvedFileMentionContext> {
  const mentions = extractFileMentions(content);
  if (mentions.length === 0) return { content, notices: [] };
  const fs = options.fs ?? nodeFileMentionFs;
  const sections: string[] = [];
  const notices: string[] = [];
  for (const mentionPath of mentions) {
    const section = await resolveSingleMention(mentionPath, workspaceRoot, fs, notices);
    if (section !== undefined) sections.push(section);
  }
  if (sections.length === 0) return { content, notices };
  const block = [
    "<system-reminder>",
    "用户通过 @ 引用了以下工作区文件，内容已直接附加：",
    ...sections,
    "</system-reminder>",
  ].join("\n");
  return { content: `${content}\n\n${block}`, notices };
}
