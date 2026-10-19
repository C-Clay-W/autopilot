/** unified diff 的逐行着色渲染；保持与 Web 的 edit_file 展示语义一致。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR, TUI_DIFF_ADDED_COLOR, TUI_DIFF_REMOVED_COLOR } from "../../design-tokens.js";

/** 将 Core 提供的最终 unified diff 逐行着色，保持与 Web 的 edit_file 展示语义一致。 */
export function TuiDiffBlock(props: { diff: string; keyPrefix: string; useColor: boolean }): ReactNode {
  return (
    <Box marginLeft={2} marginTop={1} flexDirection="column" borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1}>
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>diff</Text>
      {props.diff.split("\n").map(function renderDiffLine(line, index) {
        const isAdded = line.startsWith("+") && !line.startsWith("+++");
        const isRemoved = line.startsWith("-") && !line.startsWith("---");
        const isMeta = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@");
        const color = isAdded
          ? TUI_DIFF_ADDED_COLOR
          : isRemoved
            ? TUI_DIFF_REMOVED_COLOR
            : isMeta
              ? TUI_ACCENT_COLOR
              : undefined;
        return <Text key={props.keyPrefix + ":line:" + String(index)} color={props.useColor ? color : undefined} dimColor={props.useColor && isMeta}>{line || " "}</Text>;
      })}
    </Box>
  );
}
