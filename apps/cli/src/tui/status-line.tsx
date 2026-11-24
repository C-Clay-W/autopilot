/** 状态栏与信息行：消费安全状态视图，渲染状态、模型、权限、context 与 workspace。 */

import { resolveCliActivityView } from "../activity-animation.js";
import { stripVTControlCharacters } from "node:util";
import { memo, useContext, type ReactNode } from "react";
import { Box, Text, Transform } from "ink";
import { formatTuiContextStatus } from "../context-report.js";
import type { CliStatusView } from "../types.js";
import { CLI_TUI_COLORS, TUI_ACCENT_COLOR, TUI_MANAGED_FULL_ACCESS_SGR, TUI_MANAGED_MODEL_ACCENT_SGR } from "../design-tokens.js";
import { getTuiPermissionModeLabel, getTuiStatusLabel } from "./format.js";
import { TuiManagedTerminalStyles } from "./render-mode.js";
import type { CliTuiSnapshot } from "./types.js";

/** 渲染当前状态栏；配置行只消费安全状态视图，不读取 Runtime 或 checkpoint。 */
export const TuiStatusLine = memo(function TuiStatusLine(props: { snapshot: CliTuiSnapshot; statusView?: CliStatusView; sessionTitle?: string; interactionLabel?: string; useColor: boolean; screenReader: boolean; selectionCharacters?: number; escapeClosesPanel?: boolean }): ReactNode {
  const managedStyles = useContext(TuiManagedTerminalStyles);
  const suffix = `${props.screenReader ? " · screen reader" : ""}${props.selectionCharacters ? ` · ${props.selectionCharacters} chars selected` : ""}`;
  // 底部状态与活动行消费相同结构化事实，不能在真实等待时仍笼统显示Working。
  const waitingLabel = props.snapshot.status === "running" && props.snapshot.threadWait ? resolveCliActivityView({ activity: props.snapshot.activity, status: props.snapshot.status, now: Date.now(), threadWait: props.snapshot.threadWait })?.label : undefined;
  let statusLabel = props.interactionLabel ?? waitingLabel ?? getTuiStatusLabel(props.snapshot.status);
  if (props.snapshot.cancellationRequested) statusLabel = "Stopping · press Ctrl+C again to exit";
  const working = props.snapshot.status === "running" && !props.snapshot.cancellationRequested && !props.interactionLabel && !waitingLabel;
  const runningHint = props.escapeClosesPanel ? " · Esc关闭侧栏 · Ctrl+T选择会话" : working ? " · Esc interrupt" : "";
  const statusColor = props.snapshot.status === "idle" ? undefined : props.useColor ? TUI_ACCENT_COLOR : undefined;
  const view = props.statusView;
  const nextPermissionLabel = view?.nextPermissionMode;
  const sessionLine = props.sessionTitle ? <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>会话：{props.sessionTitle}</Text> : null;
  if (!view) {
    const hint = props.snapshot.status === "idle" ? " · /exit to quit" : runningHint;
    return <Box flexDirection="column"><Text wrap={props.screenReader ? "wrap" : "truncate"} bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{hint}</Text>{sessionLine}</Box>;
  }
  const model = stripVTControlCharacters(view.model).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  /** 复用受管终端的局部 SGR，只给已清理的模型名上色。 */
  function emphasizeManagedModel(value: string): string {
    return TUI_MANAGED_MODEL_ACCENT_SGR + value + "\u001b[39m";
  }
  /** 受管终端仅为完全访问标签输出局部红色，读屏模式保持纯文本。 */
  function permission(mode: CliStatusView["permissionMode"]): ReactNode {
    const label = `${getTuiPermissionModeLabel(mode)} (${mode})`;
    if (mode === "full_access" && managedStyles && !props.useColor && !props.screenReader) {
      return <Transform transform={function color(value) { return TUI_MANAGED_FULL_ACCESS_SGR + value + "\u001b[39m"; }}>{label}</Transform>;
    }
    return <Text wrap={props.screenReader ? "wrap" : "truncate"} color={props.useColor && mode === "full_access" ? CLI_TUI_COLORS.permissionFullAccess : undefined} bold dimColor={false}>{label}</Text>;
  }
  // 无数据/无 Session 统一显示 unknown，不猜测窗口或输出伪 0%。
  const contextLabel = formatTuiContextStatus(view.contextUsage ?? null);
  const workspaceLabel = `workspace: ${view.workspaceRoot ?? "unavailable"}`;
  const contextText = ` · context: ${contextLabel}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} bold={props.snapshot.status === "waiting_approval"} color={statusColor}>{statusLabel}{suffix}{runningHint}</Text>
      <Text wrap={props.screenReader ? "wrap" : "truncate"} dimColor={props.useColor}>
        {managedStyles && !props.useColor && !props.screenReader
          ? <Transform transform={emphasizeManagedModel}>{model}</Transform>
          : <Text color={props.useColor ? TUI_ACCENT_COLOR : undefined} bold dimColor={false}>{model}</Text>} · {view.effort} · {permission(view.permissionMode)}
        {view.nextModel ? <> · next model: {view.nextModel}</> : null}
        {view.nextEffort ? <> · next effort: {view.nextEffort}</> : null}
        {nextPermissionLabel ? <> · 恢复 / 新回合权限: {permission(nextPermissionLabel)}</> : null}
      </Text>
      {props.screenReader ? <Text dimColor={props.useColor}>{workspaceLabel}{contextText}</Text> : <Box>
        <Box flexShrink={1} minWidth={0}><Text wrap="truncate-middle" dimColor={props.useColor}>{workspaceLabel}</Text></Box>
        <Box flexShrink={0}><Text wrap="truncate-end" dimColor={props.useColor}>{contextText}</Text></Box>
      </Box>}
      {sessionLine}
    </Box>
  );
});

/** 将最近的控制台信息固定在输入框上方，避免混入会话时间线或占用回答区域。 */
export const TuiInfoLines = memo(function TuiInfoLines(props: { messages: string[]; useColor: boolean; columns?: number }): ReactNode {
  if (props.messages.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.messages.map(function renderInfo(message, index): ReactNode {
        return <Text wrap="truncate" key={`${index}:${message}`} color={props.useColor ? CLI_TUI_COLORS.copilotMuted : undefined}>info: {message.length > (props.columns ?? 80) - 6 ? "[Ctrl+G 完整信息] " : ""}{message}</Text>;
      })}
    </Box>
  );
});
