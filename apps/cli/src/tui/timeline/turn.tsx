/** 渲染当前 Turn；它会随安全事件更新，完成后整体进入历史树。 */

import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliProjection, CliTurnStatus } from "../../types.js";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import { TuiApprovalPrompt } from "../approval.js";
import { formatTuiDuration, getTuiTerminationSummary, getTuiTurnFailureReason } from "../format.js";
import type { CliTuiTimelineEvent, CliTuiTurnMetrics } from "../types.js";
import { TuiLiveTimeline } from "./live.js";
import { renderTuiPresentationTimeline } from "./presentation-timeline.js";
import { TuiTodoList } from "../todo-list.js";
import { getTuiTurnTodo } from "./turn-items.js";

/** 渲染当前 Turn；memo 保证输入光标更新不会触发 live timeline 组件执行。 */
export const TuiLiveTurn = memo(function TuiLiveTurn(props: { turnId?: string; events: CliTuiTimelineEvent[]; presentation?: AgentPresentationState; pendingApproval?: CliProjection["pendingApproval"]; approvalSelectedIndex: number; status: CliTurnStatus; metrics?: CliTuiTurnMetrics; useColor: boolean; screenReader: boolean; todoExpanded: boolean; todoRowLimit?: number; maximumWidth: number }): ReactNode {
  if (!props.turnId || props.events.length === 0) return null;
  const hasPresentation = props.presentation?.items.some(function belongsToTurn(item): boolean { return item.kind === "capability_notice" || ("turnId" in item && item.turnId === props.turnId); }) ?? false;
  const failureReason = getTuiTurnFailureReason(props.events);
  const terminationSummary = getTuiTerminationSummary(props.events, props.status);
  return (
    <Box flexDirection="column">
      {props.presentation && hasPresentation
        ? renderTuiPresentationTimeline(props.presentation, props.turnId, props.useColor, props.maximumWidth, { expanded: props.todoExpanded, screenReader: props.screenReader, rowLimit: props.todoRowLimit, showToggleHint: true, toolGroupsExpanded: props.todoExpanded }, props.events)
        : <><TuiLiveTimeline turnId={props.turnId} events={props.events} status={props.status} metrics={props.metrics} useColor={props.useColor} maximumWidth={props.maximumWidth} />{getTuiTurnTodo(props.events, props.turnId) ? <TuiTodoList item={getTuiTurnTodo(props.events, props.turnId)!} expanded={props.todoExpanded || props.screenReader} screenReader={props.screenReader} useColor={props.useColor} columns={props.maximumWidth + 2} rowLimit={props.todoRowLimit} showToggleHint /> : null}</>}
      {terminationSummary ? <Text>终态：{terminationSummary}</Text> : hasPresentation && failureReason ? <Text>原因：{failureReason}</Text> : null}
      {props.pendingApproval ? <TuiApprovalPrompt pendingApproval={props.pendingApproval} selectedIndex={props.approvalSelectedIndex} useColor={props.useColor} screenReader={props.screenReader} /> : null}
      {props.metrics?.completedAt !== undefined ? <Text dimColor={props.useColor}>* Cogitated for {formatTuiDuration(Math.max(0, props.metrics.completedAt - props.metrics.startedAt))}</Text> : null}
    </Box>
  );
});
