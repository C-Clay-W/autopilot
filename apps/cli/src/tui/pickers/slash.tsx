/** `/` 触发的完整 slash 命令目录；用户只需选择，不必记住命令名。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliSlashCommand } from "../../types.js";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** 渲染 `/` 触发的完整 slash 命令目录；用户只需选择，不必记住命令名。 */
export function TuiSlashCommandMenu(props: { commands: CliSlashCommand[]; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.commands.length - 1)));
  return (
    <Box marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column" aria-role="listbox">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Commands</Text>
      <Text dimColor={props.useColor}>↑↓ select · Tab complete · Enter choose · Esc close</Text>
      {props.commands.map(function renderSlashCommand(command, index) {
        const selected = index === selectedIndex;
        return (
          <Text key={command.name} bold={selected} color={selected && props.useColor ? TUI_ACCENT_COLOR : undefined}>
            {selected ? "› " : "  "}{command.usage}  <Text dimColor={props.useColor}>{command.description}</Text>
          </Text>
        );
      })}
      <Text dimColor={props.useColor}>{selectedIndex + 1}/{props.commands.length} commands{props.screenReader ? " · command selector" : ""}</Text>
    </Box>
  );
}
