/**
 * TUI @文件提及的输入侧纯函数：从输入与光标（grapheme 索引）提取当前 mention token、
 * 按四档确定性评分过滤候选、把选中候选替换回输入。目录候选以尾随 `/` 标记，`\` 一律归一为 `/`。
 */

import { splitTuiInputGraphemes } from "./graphemes.js";

/** @ 候选菜单一次展示的候选集上限。 */
export const FILE_MENTION_MAX_CANDIDATES = 50;

/** mention token 中的合法字符（Unicode 字母/数字/组合标记与常用路径符号）；空白与中文标点等结束 token。 */
export const FILE_MENTION_TOKEN_CHARACTER = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]$/u;

/** extractFileMentionToken 返回的当前 mention 上下文；光标不在 @ token 内时返回 null。 */
export interface FileMentionToken {
  /** `@` 字符的 grapheme 索引。 */
  start: number;
  /** token 自然结束的 grapheme 索引（光标右侧的 token 残余也计入，插入时整体替换）。 */
  end: number;
  /** `@` 之后、光标之前的查询文本（`\` 已归一为 `/`）。 */
  query: string;
}

/** 判定单个 grapheme 是否属于 mention token 字符集（Unicode 字母/数字/组合标记与常用路径符号）。 */
function isTokenGrapheme(character: string): boolean {
  return /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]$/u.test(character);
}

/** 从输入与光标提取当前 @ 文件 mention token；`@` 必须位于行首或空白后，token 中途遇空白即中断。 */
export function extractFileMentionToken(input: string, cursor: number): FileMentionToken | null {
  const characters = splitTuiInputGraphemes(input);
  if (!Number.isInteger(cursor) || cursor <= 0 || cursor > characters.length) return null;

  // 从光标向左扫描：全部字符必须是 token 字符，且恰好在空白或行首之前命中 @。
  let atIndex = -1;
  for (let index = cursor - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    if (character === "@") {
      const previous = index > 0 ? characters[index - 1]! : "";
      if (index > 0 && !/\s/u.test(previous)) return null;
      atIndex = index;
      break;
    }
    if (!isTokenGrapheme(character)) return null;
  }
  if (atIndex < 0) return null;

  // 向右吞掉光标后的 token 残余，让插入替换覆盖完整 token（如光标停在 main.ts 的 ma 处）；
  // 只吞 ASCII 文件名字符：光标右侧紧邻的中文等非 ASCII 极大概率是已输入正文，视为边界不吞，避免整体替换吞字。
  let end = cursor;
  while (end < characters.length) {
    const character = characters[end]!;
    if (!isTokenGrapheme(character) || !/^[\x00-\x7F]$/u.test(character)) break;
    end += 1;
  }

  return {
    start: atIndex,
    end,
    query: characters.slice(atIndex + 1, cursor).join("").replace(/\\/g, "/"),
  };
}

/** 取候选的最后一段作为参与匹配的名称；目录先去掉尾随斜杠。 */
function candidateName(candidatePath: string): string {
  const trimmed = candidatePath.endsWith("/") ? candidatePath.slice(0, -1) : candidatePath;
  return trimmed.split("/").pop() ?? trimmed;
}

/** 按四档确定性评分过滤并排序候选：完整路径前缀 > 文件名前缀 > 路径子串 > 文件名子串（大小写不敏感，同分 localeCompare）。 */
export function filterFileMentionCandidates(
  candidates: readonly string[],
  query: string,
  maxCandidates: number = FILE_MENTION_MAX_CANDIDATES,
): string[] {
  const normalizedQuery = query.replace(/\\/g, "/").toLocaleLowerCase();
  const scored: Array<{ path: string; tier: number }> = [];
  for (const candidate of candidates) {
    const normalizedPath = candidate.replace(/\\/g, "/");
    const lowerPath = normalizedPath.toLocaleLowerCase();
    const lowerName = candidateName(normalizedPath).toLocaleLowerCase();
    let tier: number;
    if (lowerPath.startsWith(normalizedQuery)) tier = 3;
    else if (lowerName.startsWith(normalizedQuery)) tier = 2;
    else if (lowerPath.includes(normalizedQuery)) tier = 1;
    else if (lowerName.includes(normalizedQuery)) tier = 0;
    else continue;
    scored.push({ path: normalizedPath, tier });
  }
  return scored
    .sort(function compareCandidates(left, right) {
      return right.tier - left.tier || left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(0, maxCandidates))
    .map(function readPath(candidate) {
      return candidate.path;
    });
}

/** 渲染分段条目；isMention 的片段（含 `@` 与路径）应使用强调色展示。 */
export interface TuiFileMentionSegment {
  text: string;
  isMention: boolean;
}

/** 把 prompt 文本切成普通/mention 交替段，边界与 @ 提取语义一致；用于输入框与时间线的强调展示。 */
export function splitTuiFileMentionSegments(content: string): TuiFileMentionSegment[] {
  const segments: TuiFileMentionSegment[] = [];
  let plainStart = 0;
  for (const match of content.matchAll(/(^|\s)@/gu)) {
    const atStart = match.index! + match[0].length - 1;
    let end = atStart + 1;
    while (end < content.length && FILE_MENTION_TOKEN_CHARACTER.test(content[end]!)) end += 1;
    if (end === atStart + 1) continue;
    if (atStart > plainStart) segments.push({ text: content.slice(plainStart, atStart), isMention: false });
    segments.push({ text: content.slice(atStart, end), isMention: true });
    plainStart = end;
  }
  if (plainStart < content.length) segments.push({ text: content.slice(plainStart), isMention: false });
  return segments;
}

/** 把选中候选替换回输入的 mention token；文件补尾随空格结束 token，目录保留尾随 `/` 继续下钻。 */
export function applyFileMentionSuggestion(
  input: string,
  token: FileMentionToken,
  suggestion: string,
): { input: string; cursor: number } {
  const characters = splitTuiInputGraphemes(input);
  const replacement = suggestion.endsWith("/") ? `@${suggestion}` : `@${suggestion} `;
  const replacementGraphemes = splitTuiInputGraphemes(replacement);
  characters.splice(token.start, token.end - token.start, ...replacementGraphemes);
  return { input: characters.join(""), cursor: token.start + replacementGraphemes.length };
}
