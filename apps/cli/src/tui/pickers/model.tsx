/** 模型 picker；目录完全由 Controller 的 settings-filtered capability 投影提供。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliModelOption } from "../../types.js";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** 渲染模型 picker；目录完全由 Controller 的 settings-filtered capability 投影提供。 */
export function TuiModelPicker(props: { options: CliModelOption[]; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.options.length - 1)));
  const selectedOption = props.options[selectedIndex];
  return (
    <Box marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column" aria-role="listbox">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Models</Text>
      <Text dimColor={props.useColor}>↑↓ select · Space on/off · Enter save · Esc cancel</Text>
      {props.options.map(function renderModel(option, index) {
        const focused = index === selectedIndex;
        return <Text key={`${option.provider}/${option.modelId}`} bold={focused} color={focused && props.useColor ? TUI_ACCENT_COLOR : undefined}>{focused ? "› " : "  "}[{option.selected ? "on" : "off"}] {option.provider}/{option.modelId}</Text>;
      })}
      <Text dimColor={props.useColor}>{selectedOption?.selected ? "已选择；Enter 保存为下一个 Turn 默认" : "Space 选择此模型"}{props.screenReader ? " · model selector" : ""}</Text>
    </Box>
  );
}
