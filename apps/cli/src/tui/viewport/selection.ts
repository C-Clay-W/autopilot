/** 备用屏文字划选纯函数：来源坐标定位、跨行选区提取与平台剪贴板写入。 */

import { spawn } from "node:child_process";
import stringWidth from "string-width";
import { TUI_OSC52_MAX_BYTES } from "../constants.js";
import type { TimelineVisualLine } from "../../timeline-lines.js";

/** 备用屏文字划选端点；始终关联纯文本时间线的来源坐标。 */
export interface TuiTextSelectionPoint {
  itemId: string;
  sourceOffset: number;
}

/** 备用屏文字划选状态；锚点和焦点可跨多个视觉行。 */
export interface TuiTextSelection {
  anchor?: TuiTextSelectionPoint;
  focus?: TuiTextSelectionPoint;
}

/** 将终端列坐标映射到视觉行的完整 grapheme 边界，避免截断中文和 emoji。 */
export function resolveTuiVisualLineOffset(line: TimelineVisualLine, column: number): number {
  const targetColumn = Math.max(0, column);
  let displayColumn = 0;
  let offset = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.text)) {
    const nextColumn = displayColumn + stringWidth(segment.segment);
    if (targetColumn < nextColumn) return line.sourceStart + offset;
    displayColumn = nextColumn;
    offset += segment.segment.length;
  }
  return line.sourceStart + line.text.length;
}

/** 在当前视觉行中定位选区端点，以便随 resize 后的换行重新找到来源坐标。 */
export function findTuiSelectionLineIndex(lines: TimelineVisualLine[], point: TuiTextSelectionPoint): number {
  return lines.findIndex(function findSelectionLine(line): boolean {
    return line.itemId === point.itemId && point.sourceOffset >= line.sourceStart && point.sourceOffset <= line.sourceEnd;
  });
}

/** 从纯文本视觉行中提取跨行选区，供 Windows 剪贴板或 OSC 52 使用。 */
export function getTuiSelectedText(lines: TimelineVisualLine[], selection: TuiTextSelection): string {
  if (!selection.anchor || !selection.focus) return "";
  const anchorIndex = findTuiSelectionLineIndex(lines, selection.anchor);
  const focusIndex = findTuiSelectionLineIndex(lines, selection.focus);
  if (anchorIndex < 0 || focusIndex < 0) return "";
  const [startIndex, endIndex, startPoint, endPoint] = anchorIndex < focusIndex || anchorIndex === focusIndex && selection.anchor.sourceOffset <= selection.focus.sourceOffset
    ? [anchorIndex, focusIndex, selection.anchor, selection.focus]
    : [focusIndex, anchorIndex, selection.focus, selection.anchor];
  const fragments: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const start = index === startIndex ? Math.max(0, startPoint.sourceOffset - line.sourceStart) : 0;
    const end = index === endIndex ? Math.max(start, endPoint.sourceOffset - line.sourceStart) : line.text.length;
    fragments.push(line.text.slice(start, end));
  }
  return fragments.join("\n");
}

/** 返回当前视觉行被选中的本地字符范围，用于仅反显实际拖拽到的文本。 */
export function getTuiVisualLineSelectionRange(lines: TimelineVisualLine[], selection: TuiTextSelection, lineIndex: number): { start: number; end: number } | undefined {
  if (!selection.anchor || !selection.focus) return undefined;
  const anchorIndex = findTuiSelectionLineIndex(lines, selection.anchor);
  const focusIndex = findTuiSelectionLineIndex(lines, selection.focus);
  if (anchorIndex < 0 || focusIndex < 0) return undefined;
  const [startIndex, endIndex, startPoint, endPoint] = anchorIndex < focusIndex || anchorIndex === focusIndex && selection.anchor.sourceOffset <= selection.focus.sourceOffset
    ? [anchorIndex, focusIndex, selection.anchor, selection.focus]
    : [focusIndex, anchorIndex, selection.focus, selection.anchor];
  if (lineIndex < startIndex || lineIndex > endIndex) return undefined;
  const line = lines[lineIndex];
  if (!line) return undefined;
  const start = lineIndex === startIndex ? Math.max(0, startPoint.sourceOffset - line.sourceStart) : 0;
  const end = lineIndex === endIndex ? Math.max(start, endPoint.sourceOffset - line.sourceStart) : line.text.length;
  return start < end ? { start, end } : undefined;
}

/** 将当前选区交给平台剪贴板；Windows 不经 shell 调用 clip，其它平台使用有界 OSC 52。 */
export function copyTuiSelectedText(text: string, stdout: { write(chunk: string): void }): void {
  if (!text) return;
  if (process.platform === "win32") {
    const clipboard = spawn("clip", [], { stdio: "pipe", windowsHide: true });
    clipboard.on("error", function ignoreClipboardFailure(): void {});
    clipboard.stdin.end(text);
    return;
  }
  const bytes = Buffer.from(text);
  stdout.write(`\u001b]52;c;${bytes.subarray(0, TUI_OSC52_MAX_BYTES).toString("base64")}\u0007`);
}
