/** 品牌像素字体与渲染纯函数：静态品牌行生成 + 按字符着色渲染，供 header/intro/viewport 共用。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { AUTOPILOT_BRAND_WORD, AUTOPILOT_LOGO_HEIGHT, AUTOPILOT_WORD_WIDTH } from "../constants.js";

/** Autopilot 品牌像素字体；每个字母 5×7，由 0/1 表示亮灭。 */
export const AUTOPILOT_PIXEL_FONT: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
};

/** 根据字符来源把品牌动画拆成 Copilot-inspired 的蓝、紫、绿三组 token。 */
export function renderAutopilotColoredRows(rows: string[], colorForCell: (char: string, column: number, rowIndex: number) => string | undefined, maximumWidth?: number): ReactNode {
  const width = maximumWidth === undefined ? undefined : Math.max(1, Math.floor(maximumWidth));
  return (
    <Box flexDirection="column" width={width} overflow={width === undefined ? undefined : "hidden"}>
      {rows.map(function renderAutopilotRow(row, rowIndex): ReactNode {
        const visibleRow = width === undefined ? row : row.slice(0, width);
        const segments: Array<{ text: string; color?: string }> = [];
        for (let column = 0; column < visibleRow.length; column += 1) {
          const char = visibleRow[column] ?? " ";
          const color = colorForCell(char, column, rowIndex);
          const previous = segments[segments.length - 1];
          if (previous && previous.color === color) previous.text += char;
          else segments.push({ text: char, color });
        }
        return (
          <Text key={String(rowIndex)} wrap={width === undefined ? undefined : "truncate-end"}>
            {segments.map(function renderAutopilotSegment(segment, segmentIndex): ReactNode {
              return <Text key={String(rowIndex) + ":" + String(segmentIndex)} color={segment.color}>{segment.text}</Text>;
            })}
          </Text>
        );
      })}
    </Box>
  );
}

/** 生成静态品牌的纯文本行，供内联品牌和备用屏时间线共用。 */
export function createAutopilotStaticWordRows(): string[] {
  const rows = Array.from({ length: AUTOPILOT_LOGO_HEIGHT }, function createWordRow(): string[] {
    return Array.from({ length: AUTOPILOT_WORD_WIDTH }, function createWordCell(): string { return " "; });
  });
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let letterIndex = 0; letterIndex < AUTOPILOT_BRAND_WORD.length; letterIndex += 1) {
      const glyph = AUTOPILOT_PIXEL_FONT[AUTOPILOT_BRAND_WORD[letterIndex] ?? ""];
      const glyphRow = glyph?.[rowIndex] ?? "00000";
      for (let pixelIndex = 0; pixelIndex < glyphRow.length; pixelIndex += 1) {
        if (glyphRow[pixelIndex] === "1") rows[rowIndex]![letterIndex * 6 + pixelIndex] = "█";
      }
    }
  }
  return rows.map(function joinWordRow(row): string { return row.join(""); });
}
