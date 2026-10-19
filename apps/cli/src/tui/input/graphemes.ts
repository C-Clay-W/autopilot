/** TUI 输入的 Unicode grapheme 纯函数：把用户输入拆成可感知字符并统一换行符。 */

import { TUI_INPUT_SEGMENTER } from "../constants.js";

/** 将单行输入拆为用户可感知字符，避免中文与组合 emoji 的光标索引错位。 */
export function splitTuiInputGraphemes(input: string): string[] {
  return Array.from(TUI_INPUT_SEGMENTER.segment(input), function readSegment(segment) { return segment.segment; });
}

/** 将终端粘贴的 CRLF 或 CR 统一为 TUI 内部唯一的 LF，避免 CR 在终端渲染时覆盖前文。 */
export function normalizeTuiInputLineEndings(input: string): string {
  return input.replace(/\r\n?|\n/g, "\n");
}
