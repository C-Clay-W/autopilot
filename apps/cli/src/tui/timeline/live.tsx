/** 动态时间线的增量缓存与渲染：只更新尾部事件或当前回答块，避免重扫全部事件。 */

import { memo, useRef, type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";
import type { CliTurnStatus } from "../../types.js";
import { TUI_AGENT_LABEL } from "../constants.js";
import { formatTuiDuration, formatTuiInputConsumed, getTuiApprovalDecisionLabel, isTerminalStatus } from "../format.js";
import { TuiMarkdown } from "../markdown/markdown.js";
import { TuiPromptLine } from "../transcript.js";
import type { CliTuiTimelineEvent, CliTuiTurnMetrics } from "../types.js";
import { renderTuiToolTreeEvent } from "./tool-tree.js";

interface CliTuiTimelineAnswerBlock {
  kind: "answer";
  key: string;
  answer: string;
}

interface CliTuiTimelineEventBlock {
  kind: "event";
  key: string;
  event: CliTuiTimelineEvent;
  hidden?: boolean;
}

type CliTuiTimelineBlock = CliTuiTimelineAnswerBlock | CliTuiTimelineEventBlock;

interface CliTuiTimelineCache {
  eventCount: number;
  lastEvent?: CliTuiTimelineEvent;
  hostInputs: CliTuiTimelineEvent[];
  blocks: CliTuiTimelineBlock[];
}

/** 为增量时间线生成稳定键，避免 answer delta 到达时重建历史节点。 */
function getCliTuiTimelineEventKey(event: CliTuiTimelineEvent): string {
  const inputId = "inputId" in event ? event.inputId : "";
  const approvalId = "approvalId" in event ? event.approvalId : "";
  return `${event.type}:${event.seq}:${event.turnId}:${inputId}:${approvalId}`;
}

/** 判断新事件列表是否只是同一 Turn 的尾部追加。 */
function isCliTuiTimelineAppendOnly(cache: CliTuiTimelineCache, events: CliTuiTimelineEvent[]): boolean {
  if (cache.eventCount === 0) return true;
  const hostInputs = events.filter(function host(event) { return event.type === "tui_input_consumed"; });
  if (hostInputs.length !== cache.hostInputs.length || hostInputs.some(function changed(event, index) { return event !== cache.hostInputs[index]; })) return false;
  return events.length >= cache.eventCount && events[cache.eventCount - 1] === cache.lastEvent;
}

/** 应用一条时间线事件，只修改新增尾部或当前回答块。 */
function appendCliTuiTimelineEvent(cache: CliTuiTimelineCache, event: CliTuiTimelineEvent): void {
  if (event.type === "answer_delta") {
    if (!event.delta) return;
    const lastBlock = cache.blocks[cache.blocks.length - 1];
    if (lastBlock?.kind === "answer") {
      lastBlock.answer += event.delta;
      return;
    }
    cache.blocks.push({ kind: "answer", key: "answer:" + String(event.seq), answer: event.delta });
    return;
  }
  if (event.type === "answer_reset") {
    for (let index = cache.blocks.length - 1; index >= 0; index -= 1) {
      if (cache.blocks[index]?.kind === "answer") {
        cache.blocks.splice(index, 1);
        break;
      }
    }
  }
  if (event.type === "tui_approval_submitted") {
    for (const block of cache.blocks) {
      if (block.kind === "event" && block.event.type === "approval_required" && block.event.approvalId === event.approvalId) block.hidden = true;
    }
  }
  cache.blocks.push({ kind: "event", key: getCliTuiTimelineEventKey(event), event });
}

/** 首次或 Turn 切换时完整归约时间线；后续更新走尾部增量路径。 */
function createCliTuiTimelineCache(events: CliTuiTimelineEvent[]): CliTuiTimelineCache {
  const cache: CliTuiTimelineCache = { eventCount: 0, blocks: [], hostInputs: events.filter(function host(event) { return event.type === "tui_input_consumed"; }) };
  for (const event of events) appendCliTuiTimelineEvent(cache, event);
  cache.eventCount = events.length;
  cache.lastEvent = events[events.length - 1];
  return cache;
}

/** 为当前 live Turn 复用已归约的时间线块，避免每个输入字符重扫全部事件。 */
function useCliTuiTimelineBlocks(events: CliTuiTimelineEvent[]): CliTuiTimelineBlock[] {
  const cacheRef = useRef<CliTuiTimelineCache | undefined>(undefined);
  let cache = cacheRef.current;
  if (!cache || !isCliTuiTimelineAppendOnly(cache, events)) {
    cache = createCliTuiTimelineCache(events);
  } else {
    for (let index = cache.eventCount; index < events.length; index += 1) {
      const event = events[index];
      if (event) appendCliTuiTimelineEvent(cache, event);
    }
    cache.eventCount = events.length;
    cache.lastEvent = events[events.length - 1];
  }
  cacheRef.current = cache;
  return cache.blocks;
}

/** 渲染一个不再随连续 answer delta 改变的安全事件节点。 */
function TuiLiveEventBlock(props: { event: Exclude<CliTuiTimelineEvent, { type: "answer_delta" }>; useColor: boolean; maximumWidth: number }): ReactNode {
  const event = props.event;
  if (event.type === "tui_input_consumed") {
    return <Box flexDirection="column"><TuiPromptLine content={event.content} useColor={props.useColor} columns={props.maximumWidth + 2} /><Text dimColor={props.useColor}>{event.cancelled ? "[引导] 已取消" : event.consumed === false ? "[引导] 等待当前步骤结束" : formatTuiInputConsumed(event)}</Text></Box>;
  }
  if (event.type === "tui_approval_submitted") {
    return <Text dimColor={props.useColor}>Approval submitted · {getTuiApprovalDecisionLabel(event.decision)}</Text>;
  }
  if (event.type === "turn_started" || event.type === "reasoning_summary" || event.type === "reasoning_hidden" || event.type === "answer_reset" || event.type === "input_joined" || event.type === "input_consumed" || event.type === "active_skills") return null;
  if (event.type === "tool_started" || event.type === "tool_result") return renderTuiToolTreeEvent(event, props.useColor);
  if (event.type === "approval_required") return null;
  if (event.type === "input_queued") return <Text dimColor={props.useColor}>Additional instruction queued; waiting for the current step</Text>;
  if (event.type === "todo_updated") return null;
  if (event.type === "model_recovery") return <Text dimColor={props.useColor}>Recovering · {event.reason}</Text>;
  if (event.type === "context_overflow") return <Text>Context limit reached; organizing before continuing</Text>;
  if (event.type === "context_compact_started") return <Text dimColor={props.useColor}>Organizing context</Text>;
  if (event.type === "context_compacted") return <Text>Context organized</Text>;
  if (event.type === "context_compact_failed") return <Text>Context organization failed</Text>;
  if (event.type === "context_compact_circuit_open") return <Text>Context organization temporarily unavailable</Text>;
  if (event.type === "status") return null;
  return null;
}

/** 对历史事件节点启用 memo，使新增 answer delta 不重新执行工具/diff/审批渲染。 */
const MemoizedTuiLiveEventBlock = memo(TuiLiveEventBlock);

/** 渲染当前累计回答块；只有最后一个连续回答块会随 delta 更新。 */
function TuiLiveAnswerBlock(props: { answer: string; keyPrefix: string; useColor: boolean; renderMarkdown: boolean; maximumWidth: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>• {TUI_AGENT_LABEL}</Text>
      {props.renderMarkdown
        ? <TuiMarkdown content={props.answer} keyPrefix={props.keyPrefix} useColor={props.useColor} maximumWidth={props.maximumWidth} />
        : <Text wrap="wrap">{props.answer}</Text>}
    </Box>
  );
}

/** 对回答块启用 memo，保持长时间线中已经完成的 Markdown 节点不变。 */
const MemoizedTuiLiveAnswerBlock = memo(TuiLiveAnswerBlock);

/** 增量渲染当前 Turn 的时间线块；完整 transcript 由历史树使用 renderTimeline。 */
function renderTuiLiveTimelineBlock(block: CliTuiTimelineBlock, useColor: boolean, renderMarkdown: boolean, maximumWidth: number): ReactNode {
  if (block.kind === "answer") {
    return <MemoizedTuiLiveAnswerBlock answer={block.answer} keyPrefix={block.key} useColor={useColor} renderMarkdown={renderMarkdown} maximumWidth={maximumWidth} />;
  }
  if (block.hidden) return null;
  if (block.event.type === "answer_delta") return null;
  return <MemoizedTuiLiveEventBlock event={block.event} useColor={useColor} maximumWidth={maximumWidth} />;
}

/**
 * Ink 在动态区超过一屏后会清空终端并从顶部重绘；把已经确定的块交给
 * 历史树后，动态区最多只保留当前回答或未决审批，避免活动期间
 * 的每个事件都把 Windows Terminal 的原生滚动视口拉回顶部。
 */
export const TuiLiveTimeline = memo(function TuiLiveTimeline(props: { turnId: string; events: CliTuiTimelineEvent[]; status: CliTurnStatus; useColor: boolean; maximumWidth: number; metrics?: CliTuiTurnMetrics }): ReactNode {
  const blocks = useCliTuiTimelineBlocks(props.events);
  const firstAnswerKey = blocks.find(function findFirstAnswer(block): boolean { return block.kind === "answer"; })?.key;
  function renderBlock(block: CliTuiTimelineBlock): ReactNode {
    return (
      <Box key={block.key} flexDirection="column">
        {block.key === firstAnswerKey && props.metrics?.firstAnswerAt !== undefined ? <Text dimColor={props.useColor}>Thought for {formatTuiDuration(Math.max(0, props.metrics.firstAnswerAt - props.metrics.startedAt))}</Text> : null}
        {renderTuiLiveTimelineBlock(block, props.useColor, isTerminalStatus(props.status), props.maximumWidth)}
      </Box>
    );
  }
  return (
    <>
      {blocks.map(function renderDynamicTimelineBlock(block): ReactNode {
        return renderBlock(block);
      })}
    </>
  );
});
