/** 历史 Turn 时间线：把安全事件聚合为可读时间线行，连续 answer_delta 只显示为一个回答块。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR, TUI_TOOL_ERROR_TEXT_COLOR } from "../../design-tokens.js";
import { TUI_AGENT_LABEL } from "../constants.js";
import { formatTuiDuration, formatTuiInputConsumed, getTuiApprovalDecisionLabel, getTuiToolLabel, getTuiTerminationSummary, getTuiTurnFailureReason } from "../format.js";
import { TuiMarkdown } from "../markdown/markdown.js";
import type { CliTurnStatus } from "../../types.js";
import type { CliTuiTimelineEvent } from "../types.js";
import { renderTuiToolTreeEvent } from "./tool-tree.js";
import { renderTuiPresentationTimeline } from "./presentation-timeline.js";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import { TuiPromptLine } from "../transcript.js";
import { TuiTodoList } from "../todo-list.js";
import { getTuiTurnTodo } from "./turn-items.js";

/** 将安全事件聚合为可读的时间线行，连续 answer_delta 只显示为一个回答块。 */
export function renderTimeline(events: CliTuiTimelineEvent[], useColor: boolean, timing?: { thoughtDurationMs?: number; totalDurationMs?: number; presentation?: AgentPresentationState; turnId?: string; status?: CliTurnStatus }, maximumWidth = 80, screenReader = false): ReactNode[] {
  // 历史区在 Turn 终态只固化一次最终快照；读屏模式继续输出中文状态，不能退化为 glyph-only。
  if (timing?.presentation && timing.turnId && timing.presentation.items.some(function belongsToTurn(item): boolean { return item.kind === "capability_notice" || ("turnId" in item && item.turnId === timing.turnId); })) {
    const nodes = renderTuiPresentationTimeline(timing.presentation, timing.turnId, useColor, maximumWidth, { expanded: true, screenReader }, events);
    const failureReason = getTuiTurnFailureReason(events);
    const terminationSummary = getTuiTerminationSummary(events, timing?.status);
    if (terminationSummary) nodes.push(<Text key="turn:termination">终态：{terminationSummary}</Text>);
    else if (failureReason) nodes.push(<Text key="turn:failure-reason">原因：{failureReason}</Text>);
    if (timing.totalDurationMs !== undefined) nodes.push(<Text key="turn:total-duration" dimColor={useColor}>* Cogitated for {formatTuiDuration(timing.totalDurationMs)}</Text>);
    return nodes;
  }
  const nodes: Array<ReactNode | undefined> = [];
  let answer = "";
  let answerSeq = 0;
  let lastAnswerNodeIndex: number | undefined;
  const submittedApprovalIds = new Set(events.flatMap(function readSubmittedApproval(event) {
    return event.type === "tui_approval_submitted" ? [event.approvalId] : [];
  }));

  function flushAnswer(): void {
    if (!answer) return;
    const isFirstAnswer = answerSeq === 0;
    nodes.push(
      <Box key={"answer:" + String(answerSeq++)} flexDirection="column">
        {isFirstAnswer && timing?.thoughtDurationMs !== undefined ? <Text dimColor={useColor}>Thought for {formatTuiDuration(timing.thoughtDurationMs)}</Text> : null}
        <Text bold color={useColor ? TUI_ACCENT_COLOR : undefined}>• {TUI_AGENT_LABEL}</Text>
        <TuiMarkdown content={answer} keyPrefix={"answer:" + String(answerSeq)} useColor={useColor} maximumWidth={maximumWidth} />
      </Box>,
    );
    lastAnswerNodeIndex = nodes.length - 1;
    answer = "";
  }

  /** 收到 Core reset/discard 后移除已经固化的暂定回答，避免每个工具步骤都留下重复报告。 */
  function discardAnswer(): void {
    answer = "";
    if (lastAnswerNodeIndex === undefined) return;
    nodes[lastAnswerNodeIndex] = undefined;
    lastAnswerNodeIndex = undefined;
    answerSeq = Math.max(0, answerSeq - 1);
  }

  for (const event of events) {
    if (event.type === "answer_delta") {
      answer += event.delta;
      continue;
    }
    if (event.type === "answer_reset") {
      discardAnswer();
      continue;
    }
    flushAnswer();
    if (event.type === "tui_input_consumed") {
      nodes.push(<Box key={"input:" + event.inputId} flexDirection="column"><TuiPromptLine content={event.content} useColor={useColor} columns={maximumWidth + 2} /><Text dimColor={useColor}>{event.cancelled ? "[引导] 已取消" : event.consumed === false ? "[引导] 等待当前步骤结束" : formatTuiInputConsumed(event)}</Text></Box>);
    } else if (event.type === "tui_approval_submitted") {
      nodes.push(<Text key={String(event.seq) + ":approval:" + event.approvalId} dimColor={useColor}>Approval submitted · {getTuiApprovalDecisionLabel(event.decision)}</Text>);
    } else if (event.type === "turn_started") {
      continue;
    } else if (event.type === "reasoning_summary") {
      continue;
    } else if (event.type === "reasoning_hidden") {
      continue;
    } else if (event.type === "tool_started" || event.type === "tool_result") {
      nodes.push(<Box key={String(event.seq)}>{renderTuiToolTreeEvent(event, useColor)}</Box>);
    } else if (event.type === "approval_required") {
      if (submittedApprovalIds.has(event.approvalId)) continue;
      nodes.push(
        <Box key={String(event.seq)} borderStyle="single" borderColor={useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column">
          <Text bold color={useColor ? TUI_ACCENT_COLOR : undefined}>Approval required</Text>
          <Text>操作：{getTuiToolLabel(event.toolName)}</Text>
          <Text>原因：{event.reason}</Text>
          {event.display?.executionMode === "unisolated" && <Text color={useColor ? TUI_TOOL_ERROR_TEXT_COLOR : undefined}>将在当前用户权限下运行（未启用沙箱隔离）</Text>}
          <Text dimColor={useColor}>[y] 本次  [s] 本次会话  [w] 此工作区  [n] 拒绝</Text>
        </Box>,
      );
    } else if (event.type === "input_queued") {
      nodes.push(<Text key={String(event.seq)} dimColor={useColor}>Additional instruction queued; waiting for the current step</Text>);
    } else if (event.type === "todo_updated") {
      // Todo 展示由共享 Presentation 的单卡负责，事件流本身不产生重复的静态行。
      continue;
    } else if (event.type === "input_joined" || event.type === "input_consumed") {
      continue;
    } else if (event.type === "model_recovery") {
      nodes.push(<Text key={String(event.seq)} dimColor={useColor}>Recovering · {event.reason}</Text>);
    } else if (event.type === "context_overflow") {
      nodes.push(<Text key={String(event.seq)}>Context limit reached; organizing before continuing</Text>);
    } else if (event.type === "context_compact_started") {
      nodes.push(<Text key={String(event.seq)} dimColor={useColor}>Organizing context</Text>);
    } else if (event.type === "context_compacted") {
      nodes.push(<Text key={String(event.seq)}>Context organized</Text>);
    } else if (event.type === "context_compact_failed") {
      nodes.push(<Text key={String(event.seq)}>Context organization failed</Text>);
    } else if (event.type === "context_compact_circuit_open") {
      nodes.push(<Text key={String(event.seq)}>Context organization temporarily unavailable</Text>);
    } else if (event.type === "active_skills") {
      continue;
    } else if (event.type === "status") {
      continue;
    }
  }
  flushAnswer();
  const todo = getTuiTurnTodo(events, timing?.turnId ?? events[0]?.turnId ?? "");
  if (todo) nodes.push(<Box key="turn:todo" flexDirection="column"><TuiTodoList item={todo} expanded useColor={useColor} screenReader={screenReader} columns={maximumWidth + 2} /></Box>);
  const terminationSummary = getTuiTerminationSummary(events, timing?.status);
  if (terminationSummary) nodes.push(<Text key="turn:termination">终态：{terminationSummary}</Text>);
  else if (getTuiTurnFailureReason(events)) nodes.push(<Text key="turn:failure-reason">原因：{getTuiTurnFailureReason(events)}</Text>);
  if (timing?.totalDurationMs !== undefined) nodes.push(<Text key="turn:total-duration" dimColor={useColor}>* Cogitated for {formatTuiDuration(timing.totalDurationMs)}</Text>);
  return nodes.filter(function isVisibleTimelineNode(node): node is ReactNode { return node !== undefined; });
}
