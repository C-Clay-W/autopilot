/** `/` 触发的命令目录，按终端可用行数展示选中项所在的候选窗口。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliSlashCommand } from "../../types.js";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** 保证每条候选占一行；边框、引导和计数也从同一行数预算扣除。 */
export function getTuiSlashMenuLayout(commandCount: number, availableRows: number, columns: number) {
  const framed = availableRows >= 7 && columns >= 24;
  const inlineCount = availableRows <= 1;
  const chromeRows = framed ? 6 : inlineCount ? 0 : 1;
  const visibleRows = Math.max(1, Math.min(commandCount, availableRows - chromeRows));
  return { framed, inlineCount, visibleRows, height: visibleRows + chromeRows, columns };
}

/** 展示选中项所在的窗口，仍按整个候选目录编号。 */
export function TuiSlashCommandMenu(props: { commands: CliSlashCommand[]; selectedIndex: number; layout: ReturnType<typeof getTuiSlashMenuLayout>; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, props.commands.length - 1));
  const { framed, inlineCount, visibleRows, columns } = props.layout;
  const start = Math.max(0, selectedIndex - visibleRows + 1);
  const count = `${selectedIndex + 1}/${props.commands.length}`;
  return (
    <Box marginTop={framed ? 1 : 0} borderStyle={framed ? "single" : undefined} borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={framed ? 1 : 0} flexDirection="column" aria-role="listbox">
      {framed ? <>
        <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Commands</Text>
        <Text wrap="truncate-end" dimColor={props.useColor}>{columns >= 55 ? "↑↓ select · Tab complete · Enter choose · Esc close" : "↑↓ · Tab/Enter · Esc"}</Text>
      </> : null}
      {props.commands.slice(start, start + visibleRows).map(function renderSlashCommand(command, offset) {
        const selected = start + offset === selectedIndex;
        const label = !inlineCount ? command.usage : command.name.length + count.length + 3 <= columns
          ? `${command.name} ${count}`
          : `${count} ${command.name}`;
        return (
          <Text key={command.name} wrap="truncate-end" bold={selected} color={selected && props.useColor ? TUI_ACCENT_COLOR : undefined}>
            {selected ? "› " : "  "}{label}  <Text dimColor={props.useColor}>{command.description}</Text>
          </Text>
        );
      })}
      {inlineCount ? null : <Text wrap="truncate-end" dimColor={props.useColor}>{count} commands{props.screenReader ? " · command selector" : ""}</Text>}
    </Box>
  );
}
