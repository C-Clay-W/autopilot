/** 顶部品牌头：静态像素字标 + Autopilot 版本/模型/推理强度信息。 */

import { WEB_SEARCH_DATA_FLOW_NOTICE } from "@autopilot-agent/presentation";
import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { CLI_TUI_COLORS } from "../../design-tokens.js";
import type { CliStatusView } from "../../types.js";
import { AUTOPILOT_VERSION } from "../constants.js";
import type { CliTuiTranscriptItem } from "../types.js";
import { createAutopilotStaticWordRows, renderAutopilotColoredRows } from "./pixel.js";

/** 内联历史项标记：用于把品牌头和 transcript 放入同一棵可重排的渲染树。 */
export const TUI_BRAND_HISTORY_ITEM = { kind: "brand" as const, key: "brand" };
/** 内联历史项：品牌头或 transcript 节点。 */
export type TuiInlineHistoryItem = typeof TUI_BRAND_HISTORY_ITEM | CliTuiTranscriptItem;

/** 顶部品牌初始化：按当前终端列宽渲染静态像素字母与 Autopilot 品牌 token。 */
function renderAutopilotStaticWord(useColor: boolean, columns: number): ReactNode {
  const rows = createAutopilotStaticWordRows();
  return renderAutopilotColoredRows(rows, function colorStaticWord(char): string | undefined {
    return useColor && char !== " " ? CLI_TUI_COLORS.copilotBlue : undefined;
  }, columns);
}

/** 渲染顶部品牌头。 */
export function TuiBrandHeader(props: { statusView?: CliStatusView; columns: number; useColor: boolean; screenReader: boolean; reducedMotion: boolean; animationActive: boolean }): ReactNode {
  const model = props.statusView?.model ?? "runtime default";
  const effort = props.statusView?.effort ?? "runtime default";
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={props.columns}>
      {renderAutopilotStaticWord(props.useColor, props.columns)}
      <Box marginTop={1} marginLeft={2} flexDirection="column" alignItems="flex-start">
        <Text bold color={props.useColor ? CLI_TUI_COLORS.copilotBlue : undefined}>Autopilot <Text color={props.useColor ? CLI_TUI_COLORS.copilotInk : undefined}>v{AUTOPILOT_VERSION}</Text></Text>
        <Text color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>Model {model}</Text>
        <Text color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>Thinking {effort}</Text>
        <Text color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>{WEB_SEARCH_DATA_FLOW_NOTICE}</Text>
      </Box>
    </Box>
  );
}
