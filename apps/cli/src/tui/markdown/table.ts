/** Markdown 表格纯函数：拆分、识别分隔行、归一化列数与列宽适配，不涉及渲染。 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/** 将一行 Markdown 表格拆成可在终端逐格显示的安全文本。 */
export function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(function trimCell(cell) { return cell.trim(); });
}

/** 判断一行是否是 GitHub 风格 Markdown 表格的分隔行。 */
export function isMarkdownTableDivider(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(function isDivider(cell) { return /^:?-{3,}:?$/.test(cell); });
}

/** 将模型行归一为表头列数；命令内容多出的 shell 管道合并进最后一列。 */
export function normalizeMarkdownTableCells(line: string, cellCount: number): string[] | undefined {
  if (!line.includes("|")) return undefined;
  const cells = splitMarkdownTableRow(line);
  if (cells.length < cellCount) return undefined;
  if (cells.length === cellCount) return cells;
  return [...cells.slice(0, cellCount - 1), cells.slice(cellCount - 1).join(" | ")];
}

/** 判断一行是否包含至少指定列数的竖线分列表格数据。 */
export function hasMarkdownTableCells(line: string, cellCount: number): boolean {
  return normalizeMarkdownTableCells(line, cellCount) !== undefined;
}

/** 判断模型漏掉分隔行时，表头和首行数据是否仍可安全识别为宽松表格。 */
export function isLooseMarkdownTable(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const trimmedHeader = header.trim();
  if (!/^\|.+/.test(trimmedHeader)) return false;
  const cells = splitMarkdownTableRow(header);
  return cells.length >= 2 && hasMarkdownTableCells(lines[index + 1] ?? "", cells.length);
}

/** 判断一行是否会开始新的 Markdown 块，避免把相邻段落错误合并。 */
export function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*(`{3,}|~{3,})/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
    || /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)
    || (line.includes("|") && (isMarkdownTableDivider(lines[index + 1] ?? "") || isLooseMarkdownTable(lines, index)));
}

/** 计算 Markdown 表格每列的最大显示宽度。 */
export function getTuiMarkdownTableColumnWidths(rows: string[][]): number[] {
  return rows[0].map(function getColumnWidth(_cell, columnIndex): number {
    return Math.max(3, ...rows.map(function getCellWidth(row): number { return stringWidth(row[columnIndex] ?? ""); }));
  });
}

/** 将表格列压缩到当前终端宽度，保留每列至少三个可读字符。 */
export function fitTuiMarkdownTableColumnWidths(widths: number[], maximumWidth: number): number[] {
  const fitted = widths.map(function fitColumn(width): number { return Math.max(3, width); });
  const availableWidth = Math.max(fitted.length * 3, maximumWidth - fitted.length * 3 - 1);
  while (fitted.reduce(function sumWidths(total, width): number { return total + width; }, 0) > availableWidth) {
    let widestIndex = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      if ((fitted[index] ?? 0) > (fitted[widestIndex] ?? 0)) widestIndex = index;
    }
    if ((fitted[widestIndex] ?? 3) <= 3) break;
    fitted[widestIndex] = Math.max(3, (fitted[widestIndex] ?? 3) - 1);
  }
  return fitted;
}

/** 将单元格文本按指定宽度硬换行，返回逐行显示文本。 */
export function wrapTuiMarkdownTableCell(value: string, width: number): string[] {
  const wrapped = wrapAnsi(value, Math.max(1, width), { hard: true, trim: false, wordWrap: true }).split("\n");
  return wrapped.length > 0 ? wrapped : [""];
}
