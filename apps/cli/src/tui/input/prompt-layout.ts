/** TUI prompt 视觉布局纯函数：测量视觉行、映射光标行列、生成布局。 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { TUI_CURSOR_WIDTH, TUI_INPUT_SEGMENTER, TUI_PROMPT_PREFIX } from "../constants.js";
import { splitTuiInputGraphemes } from "./graphemes.js";

/** 一条 prompt 视觉行及其源文本映射。 */
export interface TuiPromptVisualLine {
  text: string;
  start: number;
  end: number;
  width: number;
}

/** prompt 的完整视觉布局；输入状态仍只保存逻辑 grapheme cursorIndex。 */
export interface TuiPromptLayout {
  source: string;
  lines: TuiPromptVisualLine[];
  cursorOffset: number;
  cursorLine: number;
  cursorColumn: number;
}

/** 按 Ink 的 hard wrap 规则测量 prompt 的视觉行，并保留每行对应的源文本 offset。 */
export function measureTuiPromptVisualLines(source: string, columns: number): TuiPromptVisualLine[] {
  const wrapWidth = Math.max(1, columns - TUI_CURSOR_WIDTH);
  const wrapped = wrapAnsi(source, wrapWidth, { hard: true, trim: false });
  const wrappedLines = wrapped.split("\n");
  const lines: TuiPromptVisualLine[] = [];
  let searchOffset = 0;

  for (const line of wrappedLines) {
    let start = line.length > 0 ? source.indexOf(line, searchOffset) : searchOffset;
    if (start < 0) start = searchOffset;
    const end = start + line.length;
    lines.push({ text: line, start, end, width: stringWidth(line) });

    searchOffset = end;
    if (source[searchOffset] === "\n") searchOffset += 1;
  }

  return lines.length > 0 ? lines : [{ text: "", start: 0, end: 0, width: 0 }];
}

/** 将源文本 offset 映射为视觉行列；精确区分软换行和显式换行。 */
export function getTuiPromptCursorPosition(lines: TuiPromptVisualLine[], source: string, cursorOffset: number): { line: number; column: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || cursorOffset < line.start || cursorOffset > line.end) continue;

    // 软换行后的边界属于下一行；显式换行前的边界仍属于当前行。
    if (cursorOffset === line.end && lines[index + 1]?.start === line.end && source[line.end] !== "\n") continue;
    const localOffset = Math.max(0, Math.min(line.text.length, cursorOffset - line.start));
    return { line: index, column: stringWidth(line.text.slice(0, localOffset)) };
  }

  const lastLine = lines[lines.length - 1] ?? { text: "", start: 0, end: 0, width: 0 };
  return { line: Math.max(0, lines.length - 1), column: lastLine.width };
}

/** 将视觉行列映射回最近的 grapheme 边界，避免把中文或组合 emoji 拆开。 */
export function resolveTuiPromptCursorIndex(input: string, layout: TuiPromptLayout, targetLine: number, targetColumn: number): number {
  const line = layout.lines[targetLine];
  if (!line) return splitTuiInputGraphemes(input).length;

  const minimumOffset = line.start === 0 ? TUI_PROMPT_PREFIX.length : line.start;
  const minimumLocalOffset = Math.max(0, minimumOffset - line.start);
  let bestOffset = Math.max(line.start, minimumOffset);
  let bestColumn = stringWidth(line.text.slice(0, minimumLocalOffset));

  function consider(localOffset: number): void {
    if (localOffset < minimumLocalOffset || localOffset > line.text.length) return;
    const column = stringWidth(line.text.slice(0, localOffset));
    if (column <= targetColumn && column >= bestColumn) {
      bestColumn = column;
      bestOffset = line.start + localOffset;
    }
  }

  consider(minimumLocalOffset);
  for (const segment of TUI_INPUT_SEGMENTER.segment(line.text)) {
    consider(segment.index);
    consider(segment.index + segment.segment.length);
  }

  const inputOffset = Math.max(0, Math.min(input.length, bestOffset - TUI_PROMPT_PREFIX.length));
  let cursorIndex = 0;
  let sourceOffset = 0;
  for (const segment of TUI_INPUT_SEGMENTER.segment(input)) {
    if (sourceOffset + segment.segment.length > inputOffset) break;
    sourceOffset += segment.segment.length;
    cursorIndex += 1;
  }
  return cursorIndex;
}

/** 生成 prompt 的视觉布局；输入状态仍只保存逻辑 grapheme cursorIndex。 */
export function createTuiPromptLayout(input: string, cursorIndex: number, columns: number): TuiPromptLayout {
  const characters = splitTuiInputGraphemes(input);
  const cursor = Math.max(0, Math.min(cursorIndex, characters.length));
  const inputOffset = characters.slice(0, cursor).join("").length;
  const source = TUI_PROMPT_PREFIX + input;
  const lines = measureTuiPromptVisualLines(source, columns);
  const cursorOffset = TUI_PROMPT_PREFIX.length + inputOffset;
  const position = getTuiPromptCursorPosition(lines, source, cursorOffset);
  return { source, lines, cursorOffset, cursorLine: position.line, cursorColumn: position.column };
}
