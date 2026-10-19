/** 备用屏视口：按应用层视口裁剪时间线并渲染自绘滚动条。 */

import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ScrollViewportState } from "../../scroll-viewport.js";
import type { TimelineVisualLine } from "../../timeline-lines.js";
import { CLI_TUI_COLORS, TUI_ACCENT_BG_COLOR, TUI_ACCENT_COLOR, TUI_CHIP_TEXT_COLOR, TUI_DIFF_ADDED_COLOR, TUI_DIFF_REMOVED_COLOR, TUI_TOOL_ERROR_BG_COLOR, TUI_TOOL_ERROR_COLOR, TUI_TOOL_ERROR_TEXT_COLOR } from "../../design-tokens.js";
import { getTuiVisualLineSelectionRange, type TuiTextSelection } from "./selection.js";

/** 将备用屏时间线的品牌样式映射回 Design.md 规定的 ANSI token。 */
function getTuiViewportSpanColor(style: string | undefined, useColor: boolean): string | undefined {
  if (!useColor) return undefined;
  if (style === "accent") return CLI_TUI_COLORS.accent;
  if (style === "brand-blue") return CLI_TUI_COLORS.copilotBlue;
  if (style === "brand-ink") return CLI_TUI_COLORS.copilotInk;
  if (style === "brand-muted") return CLI_TUI_COLORS.copilotMuted;
  if (style === "muted") return CLI_TUI_COLORS.copilotMuted;
  if (style === "diff-border" || style === "diff-meta") return TUI_ACCENT_COLOR;
  if (style === "diff-added") return TUI_DIFF_ADDED_COLOR;
  if (style === "diff-removed") return TUI_DIFF_REMOVED_COLOR;
  if (style === "error") return TUI_TOOL_ERROR_COLOR;
  if (style === "chip-active") return TUI_CHIP_TEXT_COLOR;
  if (style === "chip-error") return TUI_TOOL_ERROR_TEXT_COLOR;
  return undefined;
}

/** 取得备用屏 span 的背景与粗体强调；活动工具徽标 chip 使用强调背景 + 深色粗体文字。 */
function getTuiViewportSpanEmphasis(style: string | undefined, useColor: boolean): { backgroundColor?: string; bold?: boolean } {
  if (!useColor) return {};
  if (style === "chip-active") return { backgroundColor: TUI_ACCENT_BG_COLOR, bold: true };
  if (style === "chip-error") return { backgroundColor: TUI_TOOL_ERROR_BG_COLOR, bold: true };
  return {};
}

/** 在视口的已换行文本中保留来源样式，并与鼠标划选反显组合。 */
function renderTuiViewportLine(line: TimelineVisualLine, selection: { start: number; end: number } | undefined, useColor: boolean): ReactNode {
  if (line.text.length === 0) return <Text> </Text>;
  const boundaries = new Set<number>([0, line.text.length]);
  if (selection) {
    boundaries.add(selection.start);
    boundaries.add(selection.end);
  }
  for (const span of line.spans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const offsets = [...boundaries].filter(function keepOffset(offset): boolean { return offset >= 0 && offset <= line.text.length; }).sort(function sortOffset(left, right): number { return left - right; });
  return offsets.slice(0, -1).map(function renderSegment(start, index): ReactNode {
    const end = offsets[index + 1] ?? start;
    const style = line.spans.find(function findStyle(span): boolean { return span.start <= start && span.end >= end; })?.style;
    const selected = selection !== undefined && start >= selection.start && end <= selection.end;
    const emphasis = getTuiViewportSpanEmphasis(style, useColor);
    return <Text key={`${start}:${end}`} color={getTuiViewportSpanColor(style, useColor)} backgroundColor={emphasis.backgroundColor} bold={emphasis.bold} inverse={selected && useColor}>{line.text.slice(start, end) || " "}</Text>;
  });
}

/** 根据当前窗口比例生成一列纯文本滚动条，拇指至少占一行。 */
function createTuiScrollbar(lines: number, state: ScrollViewportState): string[] {
  if (lines <= 0) return [];
  if (state.totalHeight <= state.viewportHeight || state.viewportHeight <= 0) return Array.from({ length: lines }, function emptyScrollbar() { return " "; });
  const thumbLength = Math.max(1, Math.min(lines, Math.round(lines * state.viewportHeight / state.totalHeight)));
  const maximumStart = Math.max(0, lines - thumbLength);
  const maximumTop = Math.max(1, state.totalHeight - state.viewportHeight);
  const thumbStart = Math.min(maximumStart, Math.round(maximumStart * state.scrollTop / maximumTop));
  return Array.from({ length: lines }, function renderScrollbar(_value: unknown, index: number): string {
    return index >= thumbStart && index < thumbStart + thumbLength ? "█" : "░";
  });
}

/** 在备用屏中按应用层视口裁剪时间线，并把最右一列留给自绘滚动条。 */
export const TuiViewportTimeline = memo(function TuiViewportTimeline(props: { lines: TimelineVisualLine[]; state: ScrollViewportState; columns: number; useColor: boolean; selection: TuiTextSelection }): ReactNode {
  const visibleLines = props.lines.slice(props.state.scrollTop, props.state.scrollTop + props.state.viewportHeight);
  const scrollbar = createTuiScrollbar(props.state.viewportHeight, props.state);
  return (
    <Box height={props.state.viewportHeight} width={props.columns} flexDirection="row" overflow="hidden" aria-role="list">
      <Box width={Math.max(1, props.columns - 1)} flexDirection="column" overflow="hidden">
        {visibleLines.map(function renderViewportLine(line, index): ReactNode {
          const range = getTuiVisualLineSelectionRange(props.lines, props.selection, props.state.scrollTop + index);
          return <Box key={`${line.itemId}:${line.sourceStart}:${index}`} width={Math.max(1, props.columns - 1)} flexDirection="row" overflow="hidden">{renderTuiViewportLine(line, range, props.useColor)}</Box>;
        })}
      </Box>
      <Box width={1} flexDirection="column" overflow="hidden">
        {scrollbar.map(function renderScrollbarCell(cell, index): ReactNode {
          return <Text key={index} color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>{cell}</Text>;
        })}
      </Box>
    </Box>
  );
});
