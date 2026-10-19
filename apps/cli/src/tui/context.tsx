/** /context 的覆盖视图：渲染 Context Usage 安全报告，并提供底部灰色 Esc 退出提示。 */

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { formatContextReportLines } from "../context-report.js";
import type { ContextUsageView } from "@autopilot-agent/core";

/** 渲染当前 Context 报告覆盖视图；按键由 app.tsx 统一分发，避免创建第二套输入器。 */
export function TuiContextReport(props: { usage: ContextUsageView | null; expanded: boolean; columns: number; useColor: boolean; screenReader: boolean }): ReactNode {
  // screen reader / NO_COLOR 跳过装饰网格但保留完整文本；与原 transcript 视图共用同一格式化函数。
  const decorative = props.useColor && !(props.screenReader ?? false);
  const lines = formatContextReportLines(props.usage, props.expanded, { grid: decorative, columns: props.columns });
  return <Box flexDirection="column" width={props.columns}>
    {lines.map(function renderReportLine(line, index): ReactNode {
      return <Text key={String(index)}>{line}</Text>;
    })}
    <Text dimColor={props.useColor}>Esc 返回聊天{props.screenReader ? " · context report" : ""}</Text>
  </Box>;
}
