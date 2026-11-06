/** 状态栏与信息行：消费安全状态视图，渲染状态、模型、权限、context 与 workspace。 */

import { resolveCliActivityView } from "../activity-animation.js";
import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { formatTuiContextStatus, formatTuiTurnUsageStatus } from "../context-report.js";
import type { CliStatusView } from "../types.js";
import { CLI_TUI_COLORS, TUI_ACCENT_COLOR } from "../design-tokens.js";
import { getTuiPermissionModeLabel, getTuiStatusLabel } from "./format.js";
import type { CliTuiSnapshot } from "./types.js";

/** 渲染当前状态栏；配置行只消费安全状态视图，不读取 Runtime 或 checkpoint。 */
export const TuiStatusLine = memo(function TuiStatusLine(props: { snapshot: CliTuiSnapshot; statusView?: CliStatusView; sessionTitle?: string; interactionLabel?: string; useColor: boolean; screenReader: boolean; selectionCharacters?: number; escapeClosesPanel?: boolean }): ReactNode {
  const suffix = `${props.screenReader ? " · screen reader" : ""}${props.selectionCharacters ? ` · ${props.selectionCharacters} chars selected` : ""}`;
  const runningHint = props.escapeClosesPanel ? " · Esc关闭侧栏 · Ctrl+T选择会话" : props.snapshot.status === "running" ? " · Esc interrupt · Enter 引导 · /queue <prompt> 排队" : "";
  // 底部状态与活动行消费相同结构化事实，不能在真实等待时仍笼统显示Working。
  const waitingLabel = props.snapshot.status === "running" && props.snapshot.threadWait ? resolveCliActivityView({ activity: props.snapshot.activity, status: props.snapshot.status, now: Date.now(), threadWait: props.snapshot.threadWait })?.label : undefined;
  let statusLabel = props.interactionLabel ?? waitingLabel ?? getTuiStatusLabel(props.snapshot.status);
  if (props.snapshot.cancellationRequested) statusLabel = "Stopping · press Ctrl+C again to exit";
  const statusColor = props.snapshot.status === "idle" ? undefined : props.useColor ? TUI_ACCENT_COLOR : undefined;
  const view = props.statusView;
  const nextPermissionLabel = view?.nextPermissionMode;
  const permissionLabel = view ? getTuiPermissionModeLabel(view.permissionMode) : undefined;
  const nextPermissionModeLabel = nextPermissionLabel ? getTuiPermissionModeLabel(nextPermissionLabel) : undefined;
  const sessionLine = props.sessionTitle ? <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>会话：{props.sessionTitle}</Text> : null;
  if (!view) {
    const hint = props.snapshot.status === "idle" ? " · /exit to quit" : runningHint;
    return <Box flexDirection="column"><Text wrap={props.screenReader ? "wrap" : "truncate"} bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{hint}</Text>{sessionLine}</Box>;
  }
  const permissionColor = props.useColor && view.permissionMode === "full_access" ? CLI_TUI_COLORS.permissionFullAccess : undefined;
  const nextPermissionColor = props.useColor && nextPermissionLabel === "full_access" ? CLI_TUI_COLORS.permissionFullAccess : undefined;
  // 无数据/无 Session 统一显示 unknown，不猜测窗口或输出伪 0%。
  const contextLabel = formatTuiContextStatus(view.contextUsage ?? null);
  // 累计用量行与 context 行同节奏刷新；无 checkpoint 时显示 unknown，不伪造 0。
  const turnUsageLabel = formatTuiTurnUsageStatus(view.turnUsage);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{runningHint}</Text>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>
        model: {view.model} · effort: {view.effort} · <Text wrap={props.screenReader ? "wrap" : "truncate"} color={permissionColor} bold dimColor={false}>permission: {permissionLabel} ({view.permissionMode})</Text>
        {view.nextModel ? <> · next model: {view.nextModel}</> : null}
        {view.nextEffort ? <> · next effort: {view.nextEffort}</> : null}
        {nextPermissionLabel ? <> · next permission: <Text wrap={props.screenReader ? "wrap" : "truncate"} color={nextPermissionColor} bold dimColor={false}>{nextPermissionModeLabel} ({nextPermissionLabel})</Text></> : null}
      </Text>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>context: {contextLabel}</Text>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>tokens: {turnUsageLabel}</Text>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>workspace: {view.workspaceRoot ?? "unavailable"}</Text>
      {sessionLine}
    </Box>
  );
});

/** 将最近的控制台信息固定在输入框上方，避免混入会话时间线或占用回答区域。 */
export const TuiInfoLines = memo(function TuiInfoLines(props: { messages: string[]; useColor: boolean }): ReactNode {
  if (props.messages.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.messages.map(function renderInfo(message, index): ReactNode {
        return <Text wrap="truncate" key={`${index}:${message}`} color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>info: {message}</Text>;
      })}
    </Box>
  );
});
