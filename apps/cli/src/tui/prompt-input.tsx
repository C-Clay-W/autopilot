/** 带可视光标的多行输入；prompt 按 @mention 分段上色，所有文本放进同一个 Text 避免兄弟节点分别换行。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR } from "../design-tokens.js";
import { TUI_CURSOR_CHARACTER, TUI_PROMPT_PREFIX } from "./constants.js";
import { splitTuiFileMentionSegments, type TuiFileMentionSegment } from "./input/file-mention.js";
import { createTuiPromptLayout } from "./input/prompt-layout.js";

/** 渲染单个 mention/普通片段；mention 片段用强调色加粗，普通片段保持默认样式。 */
function renderSegment(segment: TuiFileMentionSegment, key: string, useColor: boolean): ReactNode {
  if (segment.isMention && useColor) {
    return <Text key={key} color={TUI_ACCENT_COLOR} bold>{segment.text}</Text>;
  }
  return <Text key={key}>{segment.text}</Text>;
}

/** 把一行文本按 mention 分段渲染，并将可视光标插入所属段的正确位置。 */
function renderLineWithCursor(lineText: string, cursorOffset: number, useColor: boolean, lineKey: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = splitTuiFileMentionSegments(lineText);
  let offset = 0;
  let cursorRendered = cursorOffset < 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const start = offset;
    const end = offset + segment.text.length;
    offset = end;
    if (cursorRendered || cursorOffset < start || cursorOffset > end) {
      nodes.push(renderSegment(segment, `seg-${lineKey}-${index}`, useColor));
      continue;
    }
    // 光标落在本段内：拆成 前/光标/后 三段，光标保持既有强调色。
    const local = cursorOffset - start;
    const color = segment.isMention && useColor ? TUI_ACCENT_COLOR : undefined;
    const before = segment.text.slice(0, local);
    const after = segment.text.slice(local);
    if (before) nodes.push(<Text key={`seg-${lineKey}-${index}-b`} color={color} bold={segment.isMention && useColor}>{before}</Text>);
    nodes.push(<Text key={`prompt-cursor-${lineKey}`} color={useColor ? TUI_ACCENT_COLOR : undefined}>{TUI_CURSOR_CHARACTER}</Text>);
    if (after) nodes.push(<Text key={`seg-${lineKey}-${index}-a`} color={color} bold={segment.isMention && useColor}>{after}</Text>);
    cursorRendered = true;
  }
  if (!cursorRendered) {
    // 空行或段切分为空时仍需渲染光标，保持占位行为不变。
    nodes.push(<Text key={`prompt-cursor-${lineKey}`} color={useColor ? TUI_ACCENT_COLOR : undefined}>{TUI_CURSOR_CHARACTER}</Text>);
  }
  return nodes;
}

/** 渲染带可视光标的多行输入；所有 prompt 文本放进同一个 Text，避免兄弟节点分别换行。 */
export function TuiPromptInput(props: { input: string; cursorIndex: number; columns: number; useColor: boolean; screenReader: boolean; busy: boolean }): ReactNode {
  const layout = createTuiPromptLayout(props.input, props.cursorIndex, Math.max(1, props.columns - 4));
  const nodes: ReactNode[] = [];
  const placeholder = props.screenReader && !props.input ? "prompt" : "";

  for (let index = 0; index < layout.lines.length; index += 1) {
    const line = layout.lines[index];
    if (!line) continue;
    if (index > 0) nodes.push("\n");

    const isCursorLine = index === layout.cursorLine;
    let lineText = line.text;
    let cursorOffset = isCursorLine
      ? Math.max(0, Math.min(line.text.length, layout.cursorOffset - line.start))
      : -1;
    if (index === 0 && lineText.startsWith(TUI_PROMPT_PREFIX)) {
      nodes.push(<Text key={`prompt-prefix-${index}`} color={props.useColor ? TUI_ACCENT_COLOR : undefined}>{TUI_PROMPT_PREFIX}</Text>);
      lineText = lineText.slice(TUI_PROMPT_PREFIX.length);
      cursorOffset = Math.max(0, cursorOffset - TUI_PROMPT_PREFIX.length);
    }
    nodes.push(...renderLineWithCursor(lineText, cursorOffset, props.useColor, index));
    if (isCursorLine && placeholder) nodes.push(placeholder);
  }

  return (
    <Box aria-role="textbox" aria-state={{ busy: props.busy, multiline: true }} width={props.columns} marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1}>
      <Text wrap="wrap">{nodes}</Text>
    </Box>
  );
}
