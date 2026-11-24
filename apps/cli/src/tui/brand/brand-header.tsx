/** 顶部品牌头：静态像素图形与 Autopilot 版本。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { CLI_TUI_COLORS } from "../../design-tokens.js";
import { AUTOPILOT_VERSION } from "../constants.js";
import type { CliTuiTranscriptItem } from "../types.js";
import { createAutopilotStaticWordRows, renderAutopilotColoredRows } from "./pixel.js";
import { createAgentLogoRows } from "./logo.js";

/** 内联历史项标记：用于把品牌头和 transcript 放入同一棵可重排的渲染树。 */
export const TUI_BRAND_HISTORY_ITEM = { kind: "brand" as const, key: "brand" };
/** 内联历史项：品牌头或 transcript 节点。 */
export type TuiInlineHistoryItem = typeof TUI_BRAND_HISTORY_ITEM | CliTuiTranscriptItem;

/** 将 Logo 与原尺寸字标并排输出，让各终端共用同一横幅。 */
function renderAutopilotStaticWord(useColor: boolean, columns: number): ReactNode {
  const logo = createAgentLogoRows(14, 7);
  const rows = createAutopilotStaticWordRows().map(function addLogo(row, index) { return `${logo[index]}  ${row}`; });
  return renderAutopilotColoredRows(rows, function colorStaticWord(char): string | undefined {
    return useColor && char !== " " ? CLI_TUI_COLORS.copilotBlue : undefined;
  }, columns);
}

/** 渲染顶部品牌头。 */
export function TuiBrandHeader(props: { columns: number; useColor: boolean; screenReader: boolean; reducedMotion: boolean; animationActive: boolean }): ReactNode {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={props.columns}>
      {props.screenReader ? <Text>Autopilot</Text> : renderAutopilotStaticWord(props.useColor, props.columns)}
      <Box marginTop={1} marginLeft={2} flexDirection="column" alignItems="flex-start">
        <Text bold color={props.useColor ? CLI_TUI_COLORS.copilotBlue : undefined}>Autopilot <Text color={props.useColor ? CLI_TUI_COLORS.copilotInk : undefined}>v{AUTOPILOT_VERSION}</Text></Text>
      </Box>
    </Box>
  );
}
