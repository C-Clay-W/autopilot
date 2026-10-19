/**
 * Node 持久指令加载器：在 canonical workspaceRoot 内冻结 AGENTS.md 及安全的 Markdown @ 引用。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FrozenInstruction } from "@autopilot-agent/core";

const MAX_INSTRUCTION_CHARS = 24_000;
const RECOMMENDED_INSTRUCTION_LINES = 200;
const MAX_REFERENCE_DEPTH = 5;

/** 带额外行数诊断的宿主指令条目。 */
export interface NodeFrozenInstruction extends FrozenInstruction {
  lineCount: number;
}

/** 指令发现结果及可展示诊断。 */
export interface InstructionDiscovery {
  instructions: NodeFrozenInstruction[];
  diagnostics: string[];
}

/** 解析已存在文件的真实路径。 */
function realPath(value: string): string {
  return fs.realpathSync.native(value);
}

/** 判断 candidate 是否位于 root 内。 */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** 仅识别整行相对 Markdown @ 引用，避免把普通正文当成文件引用。 */
function getMarkdownReference(line: string): string | undefined {
  const match = line.match(/^\s*@([^\s]+)\s*$/);
  if (!match || !/\.(md|markdown|txt)$/i.test(match[1])) return undefined;
  return match[1];
}

/** 递归展开单个指令文件的相对引用，并拒绝循环、越界和过深引用。 */
function readInstructionContent(root: string, filePath: string, seen: Set<string>, diagnostics: string[], depth = 0): string {
  const canonical = realPath(filePath);
  const displayPath = path.relative(root, canonical).replace(/\\/g, "/");
  if (depth > MAX_REFERENCE_DEPTH) {
    diagnostics.push(`AGENTS.md 引用层级超过 ${MAX_REFERENCE_DEPTH}：${displayPath}`);
    return "";
  }
  if (seen.has(canonical)) {
    diagnostics.push(`AGENTS.md 引用存在循环：${displayPath}`);
    return "";
  }
  seen.add(canonical);
  const content = fs.readFileSync(canonical, "utf8");
  const expanded = content.split(/\r?\n/).map((line) => {
    const reference = getMarkdownReference(line);
    if (!reference) return line;
    const candidate = path.resolve(path.dirname(canonical), reference);
    if (!fs.existsSync(candidate)) {
      diagnostics.push(`AGENTS.md 引用不存在，未加载：${reference}（来自 ${displayPath}）`);
      return "";
    }
    const target = realPath(candidate);
    if (!isWithin(root, target)) {
      diagnostics.push(`AGENTS.md 引用超出工作区，已拒绝：${reference}（来自 ${displayPath}）`);
      return "";
    }
    return readInstructionContent(root, target, seen, diagnostics, depth + 1);
  }).join("\n");
  seen.delete(canonical);
  return expanded;
}

/** 在 workspaceRoot 到目标目录之间按层发现 AGENTS.md，并保持近层规则优先。 */
export function discoverInstructions(workspaceRoot: string, targetDirectory = workspaceRoot): InstructionDiscovery {
  const root = realPath(workspaceRoot);
  const target = realPath(targetDirectory);
  if (!isWithin(root, target)) throw new Error("指令发现目标超出工作区边界");
  const folders: string[] = [];
  for (let current = target;; current = path.dirname(current)) {
    folders.unshift(current);
    if (current === root) break;
  }
  const seen = new Set<string>();
  const instructions: NodeFrozenInstruction[] = [];
  const diagnostics: string[] = [];
  for (const folder of folders) {
    const candidate = path.join(folder, "AGENTS.md");
    if (!fs.existsSync(candidate)) continue;
    const canonical = realPath(candidate);
    if (!isWithin(root, canonical) || seen.has(canonical)) continue;
    const content = readInstructionContent(root, canonical, new Set<string>(), diagnostics);
    if (content.length > MAX_INSTRUCTION_CHARS) throw new Error(`AGENTS.md 指令超过 ${MAX_INSTRUCTION_CHARS} 字符上限: ${path.relative(root, canonical)}`);
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    if (lineCount > RECOMMENDED_INSTRUCTION_LINES) diagnostics.push(`AGENTS.md 有 ${lineCount} 行有效规则，超过建议的 ${RECOMMENDED_INSTRUCTION_LINES} 行`);
    seen.add(canonical);
    instructions.push({
      path: path.relative(root, canonical).replace(/\\/g, "/"),
      content,
      contentHash: crypto.createHash("sha256").update(content).digest("hex"),
      lineCount,
    });
  }
  return { instructions, diagnostics };
}
