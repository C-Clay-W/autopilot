/** 三态权限 picker；只展示 Core 允许的模式和安全说明。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliPermissionOption } from "../../types.js";
import { CLI_TUI_COLORS, TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** 渲染三态权限 picker；只展示 Core 允许的模式和安全说明。 */
export function TuiPermissionPicker(props: { options: CliPermissionOption[]; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.options.length - 1)));
  const selectedOption = props.options[selectedIndex];
  return (
    <Box marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column" aria-role="listbox">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Permissions</Text>
      <Text dimColor={props.useColor}>↑↓ select · Space on/off · Enter save · Esc cancel</Text>
      {props.options.map(function renderPermission(option, index) {
        const focused = index === selectedIndex;
        const checkboxColor = option.mode === "full_access" && option.selected && props.useColor ? CLI_TUI_COLORS.permissionFullAccess : undefined;
        return <Text key={option.mode} bold={focused} color={focused && props.useColor ? TUI_ACCENT_COLOR : undefined}>{focused ? "› " : "  "}<Text color={checkboxColor} dimColor={false}>[{option.selected ? "on" : "off"}]</Text> {option.label} ({option.mode})</Text>;
      })}
      {selectedOption ? <Text dimColor={props.useColor}>  {selectedOption.description}</Text> : null}
      <Text dimColor={props.useColor}>{selectedOption?.selected ? "已选择；Enter 保存为下一个 Turn 默认" : "Space 选择此权限模式"}{props.screenReader ? " · permission selector" : ""}</Text>
    </Box>
  );
}
