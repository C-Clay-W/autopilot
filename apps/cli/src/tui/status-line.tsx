/** 状态栏与信息行：消费安全状态视图，渲染状态、模型、权限、context 与 workspace。 */

import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { formatTuiContextStatus } from "../context-report.js";
import type { CliStatusView } from "../types.js";
import { CLI_TUI_COLORS, TUI_ACCENT_COLOR } from "../design-tokens.js";
import { getTuiPermissionModeLabel, getTuiStatusLabel } from "./format.js";
import type { CliTuiSnapshot } from "./types.js";

/** 渲染当前状态栏；配置行只消费安全状态视图，不读取 Runtime 或 checkpoint。 */
export const TuiStatusLine = memo(function TuiStatusLine(props: { snapshot: CliTuiSnapshot; statusView?: CliStatusView; useColor: boolean; screenReader: boolean; selectionCharacters?: number }): ReactNode {
  const suffix = `${props.screenReader ? " · screen reader" : ""}${props.selectionCharacters ? ` · ${props.selectionCharacters} chars selected` : ""}`;
  const runningHint = props.snapshot.status === "running" ? " · Esc interrupt · Enter 引导 · /queue <prompt> 排队" : "";
  let statusLabel = getTuiStatusLabel(props.snapshot.status);
  if (props.snapshot.cancellationRequested) statusLabel = "Stopping · press Ctrl+C again to exit";
  const statusColor = props.snapshot.status === "idle" ? undefined : props.useColor ? TUI_ACCENT_COLOR : undefined;
  const view = props.statusView;
  const nextPermissionLabel = view?.nextPermissionMode;
  const permissionLabel = view ? getTuiPermissionModeLabel(view.permissionMode) : undefined;
  const nextPermissionModeLabel = nextPermissionLabel ? getTuiPermissionModeLabel(nextPermissionLabel) : undefined;
  if (!view) {
    const hint = props.snapshot.status === "idle" ? " · /exit to quit" : runningHint;
    return <Text bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{hint}</Text>;
  }
  const permissionColor = props.useColor && view.permissionMode === "full_access" ? CLI_TUI_COLORS.permissionFullAccess : undefined;
  const nextPermissionColor = props.useColor && nextPermissionLabel === "full_access" ? CLI_TUI_COLORS.permissionFullAccess : undefined;
  // 无数据/无 Session 统一显示 unknown，不猜测窗口或输出伪 0%。
  const contextLabel = formatTuiContextStatus(view.contextUsage ?? null);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{runningHint}</Text>
      <Text dimColor={props.useColor}>
        model: {view.model} · effort: {view.effort} · <Text color={permissionColor} bold dimColor={false}>permission: {permissionLabel} ({view.permissionMode})</Text>
        {view.nextModel ? <> · next model: {view.nextModel}</> : null}
        {view.nextEffort ? <> · next effort: {view.nextEffort}</> : null}
        {nextPermissionLabel ? <> · next permission: <Text color={nextPermissionColor} bold dimColor={false}>{nextPermissionModeLabel} ({nextPermissionLabel})</Text></> : null}
      </Text>
      <Text dimColor={props.useColor}>context: {contextLabel}</Text>
      <Text dimColor={props.useColor}>workspace: {view.workspaceRoot ?? "unavailable"}</Text>
    </Box>
  );
});

/** 将最近的控制台信息固定在输入框上方，避免混入会话时间线或占用回答区域。 */
export const TuiInfoLines = memo(function TuiInfoLines(props: { messages: string[]; useColor: boolean }): ReactNode {
  if (props.messages.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.messages.map(function renderInfo(message, index): ReactNode {
        return <Text key={`${index}:${message}`} color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>info: {message}</Text>;
      })}
    </Box>
  );
});
