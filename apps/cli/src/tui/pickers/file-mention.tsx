/** `@` 触发的文件候选菜单：codex 风格两列布局、≤5 行滚动窗口与固定键位提示行。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** @ 菜单一次可见的最大候选行数。 */
export const TUI_FILE_MENTION_VISIBLE_ROWS = 5;

/** 计算 ≤5 行滚动窗口的起点，保证选中项始终可见。 */
function resolveWindowStart(selectedIndex: number, candidateCount: number): number {
  if (candidateCount <= TUI_FILE_MENTION_VISIBLE_ROWS) return 0;
  return Math.max(0, Math.min(selectedIndex - TUI_FILE_MENTION_VISIBLE_ROWS + 1, candidateCount - TUI_FILE_MENTION_VISIBLE_ROWS));
}

/** 渲染 @ 文件候选菜单；目录候选以尾随 `/` 标记并在类型列显示 dir，选中行用 `› ` 标记。 */
export function TuiFileMentionMenu(props: { candidates: string[]; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.candidates.length - 1)));
  const windowStart = resolveWindowStart(selectedIndex, props.candidates.length);
  const visible = props.candidates.slice(windowStart, windowStart + TUI_FILE_MENTION_VISIBLE_ROWS);
  return (
    <Box marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column" aria-role="listbox">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Files</Text>
      <Text dimColor={props.useColor}>enter/tab insert · esc close · ↑/↓ select</Text>
      {visible.map(function renderCandidate(candidate, offset) {
        const absoluteIndex = windowStart + offset;
        const selected = absoluteIndex === selectedIndex;
        return (
          <Text key={candidate} bold={selected} color={selected && props.useColor ? TUI_ACCENT_COLOR : undefined}>
            {selected ? "› " : "  "}{candidate}  <Text dimColor={props.useColor}>{candidate.endsWith("/") ? "dir" : "file"}</Text>
          </Text>
        );
      })}
      <Text dimColor={props.useColor}>{selectedIndex + 1}/{props.candidates.length} files{props.screenReader ? " · file selector" : ""}</Text>
    </Box>
  );
}
