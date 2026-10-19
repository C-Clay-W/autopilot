/** transcript 节点渲染：用户 prompt、通知、完整历史 Turn 与动态等待输入。 */

import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR, TUI_PROMPT_BACKGROUND_COLOR, TUI_WAITING_BACKGROUND_COLOR } from "../design-tokens.js";
import { splitTuiFileMentionSegments } from "./input/file-mention.js";
import { renderTimeline } from "./timeline/static-timeline.js";
import type { CliTuiPendingInput, CliTuiTranscriptItem } from "./types.js";

/** 渲染一个用户 prompt；当前 Turn 会暂留在动态区，避免历史区固化时机丢失。@文件 片段用强调色加粗。 */
export function TuiPromptLine(props: { content: string; useColor: boolean; columns: number; keyValue?: string }): ReactNode {
  const segments = splitTuiFileMentionSegments(props.content);
  return (
    <Box key={props.keyValue} width={props.columns} paddingX={1} backgroundColor={props.useColor ? TUI_PROMPT_BACKGROUND_COLOR : undefined}>
      <Text color={props.useColor ? TUI_ACCENT_COLOR : undefined}>
        {segments.map(function renderPromptSegment(segment, index) {
          if (!segment.isMention) return <Text key={index}>{segment.text}</Text>;
          return <Text key={index} bold={props.useColor}>{segment.text}</Text>;
        })}
      </Text>
    </Box>
  );
}

/** 渲染已经完成的 prompt、notice 或完整 Turn。 */
export function TuiTranscriptItem(props: { item: CliTuiTranscriptItem; useColor: boolean; columns: number; screenReader?: boolean }): ReactNode {
  const item = props.item;
  if (item.kind === "prompt") {
    return <TuiPromptLine key={item.key} content={item.content} useColor={props.useColor} columns={props.columns} keyValue={item.key} />;
  }
  if (item.kind === "notice") {
    return <Text key={item.key} dimColor={props.useColor}>info: {item.message}</Text>;
  }
  return (
    <Box key={item.key} flexDirection="column">
      {renderTimeline(item.events, props.useColor, item, Math.max(1, props.columns - 2), props.screenReader ?? false)}
    </Box>
  );
}

/** 历史节点保持引用稳定；回答流动时只重新计算当前 Turn。 */
export const MemoizedTuiTranscriptItem = memo(TuiTranscriptItem);

/** queue 在等待区显示原文；steer 正文已按提交位置留在所属轮。 */
export function TuiPendingInputItem(props: { item: CliTuiPendingInput; useColor: boolean }): ReactNode {
  const label = props.item.delivery === "queue" ? "[排队]" : "[引导]";
  return (
    <Box key={props.item.key} flexDirection="column" backgroundColor={props.useColor ? TUI_WAITING_BACKGROUND_COLOR : undefined}>
      {props.item.delivery === "queue" ? <Text>{props.item.content}</Text> : null}
      <Text dimColor={props.useColor}>↳ {label} 等待当前步骤结束</Text>
    </Box>
  );
}
