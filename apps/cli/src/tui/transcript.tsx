/** transcript 节点渲染：用户 prompt、通知、完整历史 Turn 与动态等待输入。 */

import { stripVTControlCharacters } from "node:util";
import { memo, useContext, type ReactNode } from "react";
import { Box, Text, Transform } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { TUI_ACCENT_COLOR, TUI_MANAGED_PROMPT_BACKGROUND_SGR, TUI_PROMPT_BACKGROUND_COLOR, TUI_WAITING_BACKGROUND_COLOR } from "../design-tokens.js";
import { splitTuiFileMentionSegments } from "./input/file-mention.js";
import { TuiManagedTerminalStyles } from "./render-mode.js";
import { renderTimeline } from "./timeline/static-timeline.js";
import type { CliTuiPendingInput, CliTuiTranscriptItem } from "./types.js";

/** 渲染一个用户 prompt；当前 Turn 会暂留在动态区，避免历史区固化时机丢失。@文件 片段用强调色加粗。 */
export function TuiPromptLine(props: { content: string; useColor: boolean; columns: number; keyValue?: string }): ReactNode {
  const managedBackground = useContext(TuiManagedTerminalStyles);
  if (managedBackground) {
    // 仅清理显示副本，交给 Ink 的控制码只来自固定颜色 token。
    const content = stripVTControlCharacters(props.content).replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "");
    const inset = props.columns > 3 ? " " : "";
    const width = Math.max(1, props.columns - inset.length * 2);
    const lines = wrapAnsi(content, width, { hard: true, trim: false }).split("\n")
      .map(function indent(line) { return inset + line; }).join("\n");
    return <Box key={props.keyValue} width={props.columns}>
      <Transform transform={function shadePromptRow(line) {
        const fill = " ".repeat(Math.max(0, props.columns - stringWidth(line)));
        return TUI_MANAGED_PROMPT_BACKGROUND_SGR + line + fill + "\u001b[49m";
      }}>{lines}</Transform>
    </Box>;
  }
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

/** 历史item生命周期内最多保留四个尺寸/颜色/读屏变体，跨重挂载复用稳定元素。 */
const transcriptRenderCache = new WeakMap<CliTuiTranscriptItem, Map<string, ReactNode>>();

/** 按不可变历史item引用复用元素；不冻结当前Turn或改变输出。 */
export function TuiTranscriptItem(props: { item: CliTuiTranscriptItem; useColor: boolean; columns: number; screenReader?: boolean }): ReactNode {
  const key = `${props.columns}:${props.useColor}:${props.screenReader ?? false}`;
  let variants = transcriptRenderCache.get(props.item);
  if (variants?.has(key)) return variants.get(key);
  const rendered = renderTranscriptItem(props);
  if (!variants) { variants = new Map(); transcriptRenderCache.set(props.item, variants); }
  if (variants.size >= 4) variants.delete(variants.keys().next().value!);
  variants.set(key, rendered);
  return rendered;
}

/** 渲染已经完成的 prompt、notice 或完整 Turn。 */
function renderTranscriptItem(props: { item: CliTuiTranscriptItem; useColor: boolean; columns: number; screenReader?: boolean }): ReactNode {
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
export function TuiPendingInputItem(props: { item: CliTuiPendingInput; useColor: boolean; columns: number }): ReactNode {
  const managedBackground = useContext(TuiManagedTerminalStyles);
  const label = props.item.delivery === "queue" ? "[排队]" : "[引导]";
  return (
    <Box key={props.item.key} flexDirection="column" backgroundColor={props.useColor && !managedBackground ? TUI_WAITING_BACKGROUND_COLOR : undefined}>
      {props.item.delivery === "queue" ? managedBackground
        ? <TuiPromptLine content={props.item.content} useColor={props.useColor} columns={props.columns} />
        : <Text>{props.item.content}</Text> : null}
      <Text dimColor={props.useColor}>↳ {label} 等待当前步骤结束</Text>
    </Box>
  );
}
