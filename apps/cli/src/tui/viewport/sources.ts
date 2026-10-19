/** 备用屏时间线来源：把安全事件转为可裁剪的纯文本视觉行来源。 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { WEB_SEARCH_DATA_FLOW_NOTICE, getPresentationCopy, getToolPresentationProfile, isSandboxUnavailableErrorCode, selectToolCalls, type AgentPresentationState, type TimelineItem } from "@autopilot-agent/presentation";
import type { TimelineLineSource } from "../../timeline-lines.js";
import type { CliStatusView, CliTurnStatus } from "../../types.js";
import { createAutopilotStaticWordRows } from "../brand/pixel.js";
import { AUTOPILOT_VERSION, TUI_AGENT_LABEL } from "../constants.js";
import {
  cleanTuiToolSummary,
  formatTuiDiffStats,
  formatTuiDuration,
  formatTuiInputConsumed,
  formatTuiToolLine,
  getTuiDiffStats,
  getTuiStatusLabel,
  getTuiToolLabel,
  getTuiTurnFailureReason,
  getTuiTerminationSummary,
} from "../format.js";
import {
  getTuiMarkdownTableColumnWidths,
  isLooseMarkdownTable,
  isMarkdownTableDivider,
  normalizeMarkdownTableCells,
  splitMarkdownTableRow,
} from "../markdown/table.js";
import type { CliTuiSnapshot, CliTuiTimelineEvent, CliTuiTranscriptItem } from "../types.js";
import { getTuiTurnItems, getTuiTurnTodo } from "../timeline/turn-items.js";
import { getTuiTodoDisplay, getTuiTodoStatusLabel } from "../todo-list.js";

/** 将对用户安全公开的时间线事件转换为备用屏内的纯文本行。 */
function formatTuiViewportEvent(event: CliTuiTimelineEvent): string | undefined {
  if (event.type === "answer_delta") return undefined;
  if (event.type === "tui_input_consumed") return formatTuiInputConsumed(event);
  if (event.type === "tui_approval_submitted") return `Approval submitted · ${event.decision}`;
  if (event.type === "todo_updated") return undefined;
  if (event.type === "turn_started" || event.type === "reasoning_hidden" || event.type === "answer_reset" || event.type === "input_joined" || event.type === "input_consumed" || event.type === "active_skills") return undefined;
  if (event.type === "reasoning_summary") return `Reasoning · ${event.summary}`;
  if (event.type === "tool_started") {
    const detail = cleanTuiToolSummary(event.toolName, event.summary).trim();
    return `├─ [${getTuiToolLabel(event.toolName)}]${detail ? ` [${detail}]` : ""}`;
  }
  if (event.type === "tool_result") {
    const diffStats = formatTuiDiffStats(event.diff ? { text: event.diff } : undefined);
    return `└─ ${formatTuiToolLine(event.toolName, event.summary, event.status, event.errorCode)}${diffStats ? ` ${diffStats}` : ""}`;
  }
  if (event.type === "approval_required") return `Approval required · ${event.toolName}: ${event.reason}`;
  if (event.type === "input_queued") return "Additional instruction queued; waiting for the current step";
  if (event.type === "model_recovery") return `Recovering · ${event.reason} (${event.attempt}/${event.maxAttempts})`;
  if (event.type === "context_overflow") return "Context limit reached; organizing before continuing";
  if (event.type === "context_compact_started") return "Context compact started";
  if (event.type === "context_compacted") return `Context compacted: ${event.preTokens} -> ${event.postTokens}`;
  if (event.type === "context_compact_failed") return "Context compact failed";
  if (event.type === "context_compact_circuit_open") return "Context compact circuit open";
  if (event.type === "status") return `Status · ${getTuiStatusLabel(event.status)}${event.code ? ` (${event.code})` : ""}${event.status === "failed" && event.reason ? ` · 原因：${event.reason}` : ""}`;
  return undefined;
}

/** 将 Markdown 表格预先限制在备用屏内容列内，避免后续视口硬换行打断边框。 */
export function formatTuiViewportMarkdown(content: string, maximumWidth: number): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  function padDisplayWidth(value: string, width: number): string {
    return value + " ".repeat(Math.max(0, width - stringWidth(value)));
  }
  function fitTableColumnWidths(widths: number[]): number[] {
    const minimumWidth = 3;
    const availableCellWidth = Math.max(widths.length, maximumWidth - widths.length * 3 - 1);
    const fitted = widths.map(function keepMinimumWidth(width): number { return Math.max(minimumWidth, width); });
    let excess = fitted.reduce(function sumWidths(total, width): number { return total + width; }, 0) - availableCellWidth;
    while (excess > 0) {
      const widestIndex = fitted.reduce(function findWidest(currentIndex, width, index): number {
        return width > (fitted[currentIndex] ?? 0) ? index : currentIndex;
      }, 0);
      if ((fitted[widestIndex] ?? minimumWidth) <= minimumWidth) break;
      fitted[widestIndex] = (fitted[widestIndex] ?? minimumWidth) - 1;
      excess -= 1;
    }
    return fitted;
  }
  function createTableRows(cells: string[], widths: number[]): string[] {
    const wrappedCells = cells.map(function wrapCell(cell, columnIndex): string[] {
      const width = widths[columnIndex] ?? 3;
      const wrapped = wrapAnsi(cell, width, { hard: true, trim: false, wordWrap: true }).split("\n");
      return wrapped.length > 0 ? wrapped : [""];
    });
    const height = Math.max(...wrappedCells.map(function getCellHeight(cellLines): number { return cellLines.length; }));
    return Array.from({ length: height }, function createTableLine(_value, lineIndex): string {
      return `│ ${wrappedCells.map(function formatCell(cellLines, columnIndex): string { return padDisplayWidth(cellLines[lineIndex] ?? "", widths[columnIndex] ?? 3); }).join(" │ ")} │`;
    });
  }
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const header = splitMarkdownTableRow(line);
    const strictDivider = line.includes("|") && isMarkdownTableDivider(lines[index + 1] ?? "");
    const looseRows = isLooseMarkdownTable(lines, index);
    if (strictDivider || looseRows) {
      const rows: string[][] = [];
      let rowIndex = index + (strictDivider ? 2 : 1);
      while (rowIndex < lines.length) {
        const row = normalizeMarkdownTableCells(lines[rowIndex] ?? "", header.length);
        if (!row) break;
        rows.push(row);
        rowIndex += 1;
      }
      if (rows.length > 0) {
        const widths = fitTableColumnWidths(getTuiMarkdownTableColumnWidths([header, ...rows]));
        const border = function createBorder(left: string, join: string, right: string): string {
          return left + widths.map(function createColumn(width): string { return "─".repeat(width + 2); }).join(join) + right;
        };
        output.push(border("┌", "┬", "┐"), ...createTableRows(header, widths), border("├", "┼", "┤"));
        for (const row of rows) output.push(...createTableRows(row, widths));
        output.push(border("└", "┴", "┘"));
        index = rowIndex;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return output.join("\n");
}

/** 为单色语义行生成覆盖全文的样式范围。 */
function createTuiViewportTextSpans(text: string, style: string | undefined): TimelineLineSource["spans"] {
  return style && text ? [{ start: 0, end: text.length, style }] : undefined;
}

/** 在备用屏纯文本中定位 edit diff 统计，并为正负数字附加既有语义色。 */
function createTuiViewportDiffStatsSpans(text: string, stats: { added: number; removed: number } | undefined): NonNullable<TimelineLineSource["spans"]> {
  if (!stats) return [];
  const statistics = `(+${stats.added}, -${stats.removed})`;
  const start = text.lastIndexOf(statistics);
  if (start < 0) return [];
  const addedStart = start + 1;
  const removedStart = start + statistics.indexOf("-");
  return [
    { start: addedStart, end: addedStart + String(stats.added).length + 1, style: "diff-added" },
    { start: removedStart, end: removedStart + String(stats.removed).length + 1, style: "diff-removed" },
  ];
}

/** 将历史版本的 unified diff 直角卡片转换为备用屏可裁剪的文字源，并保留边框与逐行语义颜色。 */
export function createTuiViewportDiffSource(itemId: string, diff: string, contentWidth: number): TimelineLineSource {
  const maximumInnerWidth = Math.max(1, contentWidth - 4);
  const chunks = diff.replace(/\r\n?/g, "\n").split("\n").flatMap(function wrapDiffLine(line): string[] {
    const wrapped = wrapAnsi(line || " ", maximumInnerWidth, { hard: true, trim: false, wordWrap: true }).split("\n");
    return wrapped.length > 0 ? wrapped : [" "];
  });
  const innerWidth = Math.min(maximumInnerWidth, Math.max(1, stringWidth("diff"), ...chunks.map(function getChunkWidth(line): number { return stringWidth(line); })));
  const output: string[] = [];
  const spans: NonNullable<TimelineLineSource["spans"]> = [];
  let sourceOffset = 0;
  /** 追加一行备用屏文本，并把相对样式范围换算为整段源文本偏移。 */
  function appendLine(line: string, lineSpans: TimelineLineSource["spans"] = []): void {
    output.push(line);
    for (const span of lineSpans ?? []) spans.push({ ...span, start: span.start + sourceOffset, end: span.end + sourceOffset });
    sourceOffset += line.length + 1;
  }
  /** 按终端显示宽度补齐 diff 卡片内层，避免右边框错位。 */
  function padDiffLine(line: string): string {
    return line + " ".repeat(Math.max(0, innerWidth - stringWidth(line)));
  }
  /** 追加橙色直角边框行，复用历史 TuiDiffBlock 的 single-border 语义。 */
  function appendBorder(): void {
    const border = `┌${"─".repeat(innerWidth + 2)}┐`;
    appendLine(border, [{ start: 0, end: border.length, style: "diff-border" }]);
  }
  /** 追加 diff 卡片内容行，只给真实 diff 文本着色并保留边框颜色。 */
  function appendDiffContent(line: string, style?: string): void {
    const content = padDiffLine(line);
    const rendered = `│ ${content} │`;
    const lineSpans: NonNullable<TimelineLineSource["spans"]> = [
      { start: 0, end: 2, style: "diff-border" },
      { start: rendered.length - 2, end: rendered.length, style: "diff-border" },
    ];
    if (style && line) lineSpans.push({ start: 2, end: 2 + line.length, style });
    appendLine(rendered, lineSpans);
  }
  appendBorder();
  appendDiffContent("diff", "accent");
  for (const line of chunks) {
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    const isRemoved = line.startsWith("-") && !line.startsWith("---");
    const isMeta = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@");
    appendDiffContent(line, isAdded ? "diff-added" : isRemoved ? "diff-removed" : isMeta ? "diff-meta" : undefined);
  }
  const border = `└${"─".repeat(innerWidth + 2)}┘`;
  appendLine(border, [{ start: 0, end: border.length, style: "diff-border" }]);
  return { itemId, text: output.join("\n"), spans };
}

/** 为备用屏构造与原 Header 相同间距和品牌 token 的静态品牌行。 */
function createTuiViewportBrandSource(statusView?: CliStatusView): TimelineLineSource {
  const word = createAutopilotStaticWordRows().join("\n");
  const model = statusView?.model ?? "runtime default";
  const effort = statusView?.effort ?? "runtime default";
  const detailPrefix = `${word}\n\n  `;
  const versionLabel = "Autopilot";
  const version = `v${AUTOPILOT_VERSION}`;
  const modelLine = `Model ${model}`;
  const thinkingLine = `Thinking ${effort}`;
  const text = `${detailPrefix}${versionLabel} ${version}\n  ${modelLine}\n  ${thinkingLine}\n  ${WEB_SEARCH_DATA_FLOW_NOTICE}`;
  const detailStart = detailPrefix.length;
  const modelStart = detailStart + versionLabel.length + 1 + version.length + 3;
  const thinkingStart = modelStart + modelLine.length + 3;
  return {
    itemId: "brand",
    text,
    spans: [
      { start: 0, end: word.length, style: "brand-blue" },
      { start: detailStart, end: detailStart + versionLabel.length, style: "brand-blue" },
      { start: detailStart + versionLabel.length + 1, end: detailStart + versionLabel.length + 1 + version.length, style: "brand-ink" },
      { start: modelStart, end: modelStart + modelLine.length, style: "brand-muted" },
      { start: thinkingStart, end: thinkingStart + thinkingLine.length, style: "brand-muted" },
    ],
  };
}

/** 将共享 Presentation selector 转成备用屏文本源，与 inline TUI 复用同一事实和顺序。 */
function createTuiPresentationViewportSources(presentation: AgentPresentationState, turnId: string, itemId: string, contentWidth: number, toolGroupsExpanded: boolean, events: CliTuiTimelineEvent[], live: boolean, rowLimit = 10): TimelineLineSource[] {
  const sources: TimelineLineSource[] = [];
  // 构建 callId 索引供展开分组取回组内调用。
  const callIndex = new Map(selectToolCalls(presentation, turnId).map(function indexToolCall(call) { return [call.callId, call]; }));
  let index = 0;
  for (const item of getTuiTurnItems(presentation, turnId, events)) {
    if ("type" in item) {
      sources.push({ itemId: `${itemId}:input:${item.inputId}`, text: item.content, spans: createTuiViewportTextSpans(item.content, "accent") });
      sources.push({ itemId: `${itemId}:input:${item.inputId}:state`, text: item.cancelled ? "[引导] 已取消" : item.consumed === false ? "[引导] 等待当前步骤结束" : formatTuiInputConsumed(item) });
      continue;
    }
    if (item.kind !== "capability_notice" && (!("turnId" in item) || item.turnId !== turnId)) continue;
    const sourceId = `${itemId}:presentation:${String(index++)}`;
    if (item.kind === "todo") { sources.push(...createTuiTodoSources(item, sourceId, contentWidth, live ? toolGroupsExpanded : true, live, rowLimit)); continue; }
    if (item.kind === "thinking") sources.push({ itemId: sourceId, text: `✢ ${item.summary}`, spans: createTuiViewportTextSpans(`✢ ${item.summary}`, "muted") });
    else if (item.kind === "tool_group") {
      const text = `• Exploring codebase · ${item.toolCallIds.length} operations`;
      const numberStart = "• Exploring codebase · ".length;
      sources.push({ itemId: sourceId, text, spans: [{ start: numberStart, end: numberStart + String(item.toolCallIds.length).length, style: "accent" }, ...createTuiViewportTextSpans(text, "muted") ?? []] });
      // 分组默认收起；Ctrl+O 详情态展开组内各调用，缩进两格并保留徽标 chip 语义。
      if (!toolGroupsExpanded) continue;
      for (const callId of item.toolCallIds) {
        const child = callIndex.get(callId);
        if (!child) continue;
        const childTitle = getPresentationCopy(child.titleKey);
        const childDetail = [child.target, child.resultSummary].filter(Boolean).join(" · ");
        const childText = `  ├─ [${childTitle}]${childDetail ? ` · ${childDetail}` : ""}`;
        const childBadgeStart = 5;
        sources.push({ itemId: `${sourceId}:${callId}`, text: childText, spans: [{ start: childBadgeStart, end: childBadgeStart + childTitle.length + 2, style: "chip-active" }] });
      }
    }
    else if (item.kind === "tool_call") {
      const jobProgramLabel = item.job?.action === "start" ? item.job.programLabel?.toUpperCase() : undefined;
      const diffStats = getTuiDiffStats(item.diff);
      const diffStatsText = formatTuiDiffStats(item.diff);
      const detail = `${[jobProgramLabel ? undefined : item.target, item.resultSummary].filter(Boolean).join(" · ")}${diffStatsText ? ` ${diffStatsText}` : ""}`;
      const detailLine = jobProgramLabel ? `\n  └─ ${jobProgramLabel}${detail ? ` · ${detail}` : ""}` : detail ? `\n  └─ ${detail}` : "";
      const jobHint = item.job?.action === "start" && (item.job.observedStatus === "starting" || item.job.observedStatus === "running") ? "\n  /jobs 查看后台任务" : "";
      const title = getPresentationCopy(item.state === "failed" ? getToolPresentationProfile(item.toolName).completedTitleKey : item.titleKey);
      // 2.5：沙箱不可用类拒绝是环境阻塞而非用户拒绝，文案必须区分。
      const stateText = item.state === "denied" ? (isSandboxUnavailableErrorCode(item.errorCode) ? "沙箱不可用，命令未启动" : "已拒绝") : item.state === "cancelled" ? "已取消" : item.state === "timeout" ? "已超时" : undefined;
      const badgeText = `[${title}]${stateText ? ` · ${stateText}` : ""}`;
      const text = `${item.state === "failed" ? "×" : "•"} ${badgeText}${detailLine}${item.errorCode ? `\n  └─ ${item.errorCode}` : ""}${jobHint}`;
      const programStart = jobProgramLabel ? text.indexOf(jobProgramLabel) : -1;
      const hintStart = jobHint ? text.length - jobHint.trimStart().length : -1;
      const badgeStart = 2;
      const badgeEnd = badgeStart + badgeText.length;
      const spans: NonNullable<TimelineLineSource["spans"]> = createTuiViewportDiffStatsSpans(text, diffStats);
      if (programStart >= 0 && jobProgramLabel) spans.push({ start: programStart, end: programStart + jobProgramLabel.length, style: "accent" });
      if (item.state === "running" || item.state === "awaiting_approval") {
        spans.push({ start: badgeStart, end: badgeEnd, style: "chip-active" });
        spans.push({ start: 0, end: text.length, style: "muted" });
      } else if (item.state === "completed") {
        spans.push({ start: badgeStart, end: badgeEnd, style: "chip-active" });
      } else {
        spans.push({ start: badgeStart, end: badgeEnd, style: "chip-error" });
      }
      if (hintStart >= 0) spans.push({ start: hintStart, end: text.length, style: "muted" });
      sources.push({ itemId: sourceId, text, spans });
      if (item.diff?.text) sources.push(createTuiViewportDiffSource(`${sourceId}:diff`, item.diff.text, contentWidth));
    } else if (item.kind === "assistant_answer") {
      if (item.channel === "process") {
        sources.push({ itemId: sourceId, text: formatTuiViewportMarkdown(item.content, contentWidth) });
      } else {
        const label = TUI_AGENT_LABEL;
        const text = `• ${label}\n${formatTuiViewportMarkdown(item.content, contentWidth)}`;
        sources.push({ itemId: sourceId, text, spans: [{ start: 0, end: `• ${label}`.length, style: "accent" }] });
      }
    } else if (item.kind === "approval") {
      const text = `⚠ ${item.display?.actionPreview ?? item.display?.operation ?? "需要确认"}${item.state === "resolved" ? " · 已处理" : ""}`;
      sources.push({ itemId: sourceId, text, spans: createTuiViewportTextSpans(text, "accent") });
    } else if (item.kind === "input_notice") {
      const text = `${item.delivery === "steer" ? "[引导] " : item.delivery === "queue" ? "[排队] " : ""}Input ${item.state}`;
      sources.push({ itemId: sourceId, text, spans: createTuiViewportTextSpans(text, "muted") });
    } else if (item.kind === "context_notice") sources.push({ itemId: sourceId, text: item.state === "compacted" ? "Context organized" : `Context ${item.state}` });
    else if (item.kind === "undo") sources.push({ itemId: sourceId, text: `Undo ${item.state}` });
    else if (item.kind === "turn_summary") sources.push({ itemId: sourceId, text: `${item.state === "completed" ? "✓" : "×"} ${getPresentationCopy(`turn.${item.state}`)} · ${item.toolCount} tools`, spans: createTuiViewportTextSpans(`${item.state === "completed" ? "✓" : "×"} ${getPresentationCopy(`turn.${item.state}`)} · ${item.toolCount} tools`, "muted") });
  }
  return sources;
}

/** Todo 行复用既有紧凑/展开数据；历史不输出失效快捷键。 */
function createTuiTodoSources(item: Extract<TimelineItem, { kind: "todo" }>, itemId: string, contentWidth: number, expanded: boolean, live: boolean, rowLimit = 10): TimelineLineSource[] {
  const display = getTuiTodoDisplay(item, { expanded, screenReader: false, columns: contentWidth + 1, rowLimit });
  if (!display) return [];
  const text = [display.header, ...display.rows.map(function row(row) { return row.hidden ? `+${row.text}` : `[${getTuiTodoStatusLabel(row.status)}] ${row.text}`; }), ...(live ? [`Ctrl+O ${expanded ? "收起" : "展开"}`] : [])].join("\n");
  return [{ itemId, text }];
}

type TuiViewportEventTiming = {
  todoRowLimit?: number;
  thoughtDurationMs?: number;
  totalDurationMs?: number;
  presentation?: AgentPresentationState;
  turnId?: string;
  /** 生成该组 source 时的 Turn 生命周期状态；终态文案只在此状态为真实结束时解释。 */
  status?: CliTurnStatus;
};

/** 将一个历史或 live Turn 的安全事件转换为可缓存的备用屏 source 列表。 */
function createTuiViewportEventSources(itemId: string, events: CliTuiTimelineEvent[], contentWidth: number, timing?: TuiViewportEventTiming, toolGroupsExpanded = false): TimelineLineSource[] {
  const sources: TimelineLineSource[] = [];
  if (timing?.presentation && timing.turnId && timing.presentation.items.some(function belongsToTurn(item): boolean { return item.kind === "capability_notice" || ("turnId" in item && item.turnId === timing.turnId); })) {
    sources.push(...createTuiPresentationViewportSources(timing.presentation, timing.turnId, itemId, contentWidth, toolGroupsExpanded, events, timing.status === "running" || timing.status === "waiting_approval", timing.todoRowLimit));
    const failureReason = getTuiTurnFailureReason(events);
    const terminationSummary = getTuiTerminationSummary(events, timing?.status);
    if (terminationSummary) {
      const text = `终态：${terminationSummary}`;
      sources.push({ itemId: `${itemId}:termination`, text, spans: createTuiViewportTextSpans(text, "accent") });
    } else if (failureReason) {
      const text = `原因：${failureReason}`;
      sources.push({ itemId: `${itemId}:failure-reason`, text, spans: createTuiViewportTextSpans(text, "accent") });
    }
    if (timing.totalDurationMs !== undefined) {
      const text = `* Cogitated for ${formatTuiDuration(timing.totalDurationMs)}`;
      sources.push({ itemId: `${itemId}:total-duration`, text, spans: createTuiViewportTextSpans(text, "muted") });
    }
    return sources;
  }
  let answer = "";
  let answerCount = 0;
  let lastAnswerSource: { answerIndex: number; thoughtIndex?: number } | undefined;
  let progressSourceIndex: number | undefined;
  /** 将当前连续 answer 分片收束为一个可裁剪 source。 */
  function flushAnswer(): void {
    if (!answer) return;
    let thoughtIndex: number | undefined;
    if (answerCount === 0 && timing?.thoughtDurationMs !== undefined) {
      const text = `Thought for ${formatTuiDuration(timing.thoughtDurationMs)}`;
      sources.push({ itemId: `${itemId}:thought`, text, spans: createTuiViewportTextSpans(text, "muted") });
      thoughtIndex = sources.length - 1;
    }
    const answerText = `• ${TUI_AGENT_LABEL}\n${formatTuiViewportMarkdown(answer, contentWidth)}`;
    sources.push({ itemId: `${itemId}:answer:${String(answerCount++)}`, text: answerText, spans: [{ start: 0, end: `• ${TUI_AGENT_LABEL}`.length, style: "accent" }] });
    lastAnswerSource = { answerIndex: sources.length - 1, thoughtIndex };
    answer = "";
  }
  /** 收到 Core reset/discard 后撤销当前采样的暂定回答及其思考计时。 */
  function discardAnswer(): void {
    answer = "";
    if (!lastAnswerSource) return;
    sources.splice(lastAnswerSource.answerIndex, 1);
    if (lastAnswerSource.thoughtIndex !== undefined) sources.splice(lastAnswerSource.thoughtIndex, 1);
    answerCount = Math.max(0, answerCount - 1);
    lastAnswerSource = undefined;
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
    if (event.type === "tool_progress") {
      const text = "正在执行：" + event.tail;
      const spans = createTuiViewportTextSpans(text, "muted");
      if (progressSourceIndex === undefined) {
        sources.push({ itemId: itemId + ":progress", text, spans });
        progressSourceIndex = sources.length - 1;
      } else {
        sources[progressSourceIndex] = { itemId: itemId + ":progress", text, spans };
      }
      continue;
    }
    flushAnswer();
    if (event.type === "tui_input_consumed") {
      sources.push({ itemId: `${itemId}:input:${event.inputId}`, text: event.content, spans: createTuiViewportTextSpans(event.content, "accent") });
      sources.push({ itemId: `${itemId}:input:${event.inputId}:state`, text: event.cancelled ? "[引导] 已取消" : event.consumed === false ? "[引导] 等待当前步骤结束" : formatTuiInputConsumed(event) });
      continue;
    }
    if (event.type === "status") continue;
    const text = formatTuiViewportEvent(event);
    const style = event.type === "tool_started" || event.type === "reasoning_summary" ? "muted" : undefined;
    if (text) {
      const spans = event.type === "tool_result"
        ? createTuiViewportDiffStatsSpans(text, getTuiDiffStats(event.diff ? { text: event.diff } : undefined))
        : createTuiViewportTextSpans(text, style);
      sources.push({ itemId: `${itemId}:${event.seq}`, text, spans });
    }
    if (event.type === "tool_result" && event.diff) sources.push(createTuiViewportDiffSource(`${itemId}:${event.seq}:diff`, event.diff, contentWidth));
    // 终态到达后移除覆盖式进度行，避免与结果行重复。
    if (event.type === "tool_result" && progressSourceIndex !== undefined) {
      sources.splice(progressSourceIndex, 1);
      progressSourceIndex = undefined;
    }
  }
  flushAnswer();
  const todo = getTuiTurnTodo(events, timing?.turnId ?? events[0]?.turnId ?? "");
  const live = timing?.status === "running" || timing?.status === "waiting_approval";
  if (todo) sources.push(...createTuiTodoSources(todo, `${itemId}:todo`, contentWidth, live ? toolGroupsExpanded : true, live, timing?.todoRowLimit));
  const terminationSummary = getTuiTerminationSummary(events, timing?.status);
  if (terminationSummary) sources.push({ itemId: `${itemId}:termination`, text: `终态：${terminationSummary}` });
  else if (getTuiTurnFailureReason(events)) sources.push({ itemId: `${itemId}:failure-reason`, text: `原因：${getTuiTurnFailureReason(events)}` });
  if (timing?.totalDurationMs !== undefined) {
    const text = `* Cogitated for ${formatTuiDuration(timing.totalDurationMs)}`;
    sources.push({ itemId: `${itemId}:total-duration`, text, spans: createTuiViewportTextSpans(text, "muted") });
  }
  return sources;
}

/** 将已完成与当前动态时间线统一变为可裁剪的视觉行来源。 */
export function createTuiViewportSources(snapshot: CliTuiSnapshot, statusView: CliStatusView | undefined, approvalSelectedIndex: number, contentWidth: number, toolGroupsExpanded = false, decorativeGrid = false, todoRowLimit = 10): TimelineLineSource[] {
  const sources: TimelineLineSource[] = [];
  sources.push(createTuiViewportBrandSource(statusView));

  function appendEventGroup(itemId: string, events: CliTuiTimelineEvent[], timing?: TuiViewportEventTiming, expandGroups = false): void {
    sources.push(...createTuiViewportEventSources(itemId, events, contentWidth, timing, expandGroups));
  }
  let renderedActivePrompt = false;
  for (const item of snapshot.transcript) {
    if (item.kind === "prompt") {
      sources.push({ itemId: item.key, text: item.content, spans: createTuiViewportTextSpans(item.content, "accent") });
      if (item.key === snapshot.activePrompt?.key) renderedActivePrompt = true;
    } else if (item.kind === "turn" && item.turnId !== snapshot.liveTurnId) {
      appendEventGroup(item.key, item.events, item);
    }
  }
  if (snapshot.activePrompt && !renderedActivePrompt) sources.push({ itemId: snapshot.activePrompt.key, text: snapshot.activePrompt.content, spans: createTuiViewportTextSpans(snapshot.activePrompt.content, "accent") });
  const liveCompletedAt = snapshot.liveMetrics?.completedAt;
  appendEventGroup(snapshot.liveTurnId ?? "live", snapshot.liveEvents, {
    todoRowLimit,
    thoughtDurationMs: snapshot.liveMetrics?.firstAnswerAt === undefined ? undefined : Math.max(0, snapshot.liveMetrics?.firstAnswerAt - snapshot.liveMetrics!.startedAt),
    totalDurationMs: liveCompletedAt === undefined ? undefined : Math.max(0, liveCompletedAt - snapshot.liveMetrics!.startedAt),
    presentation: snapshot.livePresentation,
    turnId: snapshot.liveTurnId,
    status: snapshot.status,
  }, toolGroupsExpanded);
  for (const item of snapshot.pendingInputs.filter(function queue(item) { return item.delivery === "queue"; })) sources.push({ itemId: item.key, text: `${item.delivery === "queue" ? item.content + "\n[排队]" : "[引导]"} 等待当前步骤结束` });
  return sources;
}

/** 备用屏 source 缓存计数，区分历史命中与 live tail 重建。 */
export interface TuiViewportSourceCacheStats {
  brandBuilds: number;
  historyBuilds: number;
  historyHits: number;
  liveBuilds: number;
  liveHits: number;
  pendingBuilds: number;
  pendingHits: number;
  widthInvalidations: number;
}

/** 按 transcript item 与 live tail 增量生成备用屏 source 的内部接口。 */
export interface TuiViewportSourceCache {
  getSources(snapshot: CliTuiSnapshot, statusView: CliStatusView | undefined, approvalSelectedIndex: number, contentWidth: number, toolGroupsExpanded?: boolean, decorativeGrid?: boolean, todoRowLimit?: number): TimelineLineSource[];
  getStats(): TuiViewportSourceCacheStats;
  clear(): void;
}

type CachedHistorySource = { item: CliTuiTranscriptItem; width: number; decorativeGrid: boolean; sources: TimelineLineSource[] };
type CachedPromptSource = { key: string; content: string; sources: TimelineLineSource[] };
type CachedPendingSource = { key: string; content: string; delivery: "steer" | "queue"; sources: TimelineLineSource[] };

/** 创建备用屏 source 增量缓存；历史 item 不变时只复用其 source，live tail 单独更新。 */
export function createTuiViewportSourceCache(): TuiViewportSourceCache {
  const history = new Map<string, CachedHistorySource>();
  const pending = new Map<string, CachedPendingSource>();
  let activePrompt: CachedPromptSource | undefined;
  let brand: { statusView?: CliStatusView; source: TimelineLineSource } | undefined;
  let live: { turnId?: string; events: CliTuiTimelineEvent[]; presentation?: AgentPresentationState; metrics?: CliTuiSnapshot["liveMetrics"]; width: number; toolGroupsExpanded: boolean; todoRowLimit: number; sources: TimelineLineSource[] } | undefined;
  let width: number | undefined;
  const stats: TuiViewportSourceCacheStats = { brandBuilds: 0, historyBuilds: 0, historyHits: 0, liveBuilds: 0, liveHits: 0, pendingBuilds: 0, pendingHits: 0, widthInvalidations: 0 };

  /** 终端宽度变化时清除依赖内容宽度的 source，但保留计数供测试审计。 */
  function invalidateWidth(nextWidth: number): void {
    if (width !== undefined && width !== nextWidth) {
      history.clear();
      pending.clear();
      activePrompt = undefined;
      live = undefined;
      brand = undefined;
      stats.widthInvalidations += 1;
    }
    width = nextWidth;
  }

  /** 获取按 item 引用与宽度缓存的历史 source。 */
  function getHistorySources(item: CliTuiTranscriptItem, contentWidth: number, decorativeGrid: boolean): TimelineLineSource[] {
    const previous = history.get(item.key);
    if (previous && previous.item === item && previous.width === contentWidth && previous.decorativeGrid === decorativeGrid) {
      stats.historyHits += 1;
      return previous.sources;
    }
    const sources = item.kind === "prompt"
      ? [{ itemId: item.key, text: item.content, spans: createTuiViewportTextSpans(item.content, "accent") }]
      : item.kind === "turn"
        ? createTuiViewportEventSources(item.key, item.events, contentWidth, item)
        : [];
    history.set(item.key, { item, width: contentWidth, decorativeGrid, sources });
    stats.historyBuilds += 1;
    return sources;
  }

  /** 获取未出现在 transcript 中的当前 prompt source。 */
  function getActivePromptSource(prompt: NonNullable<CliTuiSnapshot["activePrompt"]>): TimelineLineSource[] {
    if (activePrompt && activePrompt.key === prompt.key && activePrompt.content === prompt.content) return activePrompt.sources;
    const sources = [{ itemId: prompt.key, text: prompt.content, spans: createTuiViewportTextSpans(prompt.content, "accent") }];
    activePrompt = { key: prompt.key, content: prompt.content, sources };
    return sources;
  }

  /** 获取按 pending input key 缓存的等待输入 source。 */
  function getPendingSource(item: CliTuiSnapshot["pendingInputs"][number]): TimelineLineSource[] {
    const previous = pending.get(item.key);
    if (previous && previous.content === item.content && previous.delivery === item.delivery) {
      stats.pendingHits += 1;
      return previous.sources;
    }
    const sources = [{ itemId: item.key, text: `${item.delivery === "queue" ? item.content + "\n[排队]" : "[引导]"} 等待当前步骤结束` }];
    pending.set(item.key, { key: item.key, content: item.content, delivery: item.delivery, sources });
    stats.pendingBuilds += 1;
    return sources;
  }

  /** 获取当前 live tail source；历史 transcript 不参与本次重建。 */
  function getLiveSources(snapshot: CliTuiSnapshot, contentWidth: number, toolGroupsExpanded: boolean, todoRowLimit: number): TimelineLineSource[] {
    const liveTurnId = snapshot.liveTurnId;
    const metrics = snapshot.liveMetrics;
    if (live && live.turnId === liveTurnId && live.events === snapshot.liveEvents && live.presentation === snapshot.livePresentation && live.metrics === metrics && live.width === contentWidth && live.toolGroupsExpanded === toolGroupsExpanded && live.todoRowLimit === todoRowLimit) {
      stats.liveHits += 1;
      return live.sources;
    }
    const liveCompletedAt = metrics?.completedAt;
    const timing: TuiViewportEventTiming = {
          todoRowLimit,
          thoughtDurationMs: metrics?.firstAnswerAt === undefined ? undefined : Math.max(0, metrics?.firstAnswerAt - metrics!.startedAt),
          totalDurationMs: liveCompletedAt === undefined ? undefined : Math.max(0, liveCompletedAt - metrics!.startedAt),
          presentation: snapshot.livePresentation,
          turnId: liveTurnId,
          status: snapshot.status,
        };
    const sources = createTuiViewportEventSources(liveTurnId ?? "live", snapshot.liveEvents, contentWidth, timing, toolGroupsExpanded);
    live = { turnId: liveTurnId, events: snapshot.liveEvents, presentation: snapshot.livePresentation, metrics, width: contentWidth, toolGroupsExpanded, todoRowLimit, sources };
    stats.liveBuilds += 1;
    return sources;
  }

  /** 返回按稳定历史、live tail 和 pending 输入拼接的当前 source 顺序。 */
  function getSources(snapshot: CliTuiSnapshot, statusView: CliStatusView | undefined, _approvalSelectedIndex: number, contentWidth: number, toolGroupsExpanded = false, decorativeGrid = false, todoRowLimit = 10): TimelineLineSource[] {
    invalidateWidth(contentWidth);
    if (!brand || brand.statusView !== statusView) {
      brand = { statusView, source: createTuiViewportBrandSource(statusView) };
      stats.brandBuilds += 1;
    }
    const sources: TimelineLineSource[] = [brand.source];
    let renderedActivePrompt = false;
    for (const item of snapshot.transcript) {
      if (item.kind === "prompt") {
        sources.push(...getHistorySources(item, contentWidth, decorativeGrid));
        if (item.key === snapshot.activePrompt?.key) renderedActivePrompt = true;
      } else if (item.kind === "turn" && item.turnId !== snapshot.liveTurnId) {
        sources.push(...getHistorySources(item, contentWidth, decorativeGrid));
      }
    }
    if (snapshot.activePrompt && !renderedActivePrompt) sources.push(...getActivePromptSource(snapshot.activePrompt));
    sources.push(...getLiveSources(snapshot, contentWidth, toolGroupsExpanded, todoRowLimit));
    for (const item of snapshot.pendingInputs.filter(function queue(item) { return item.delivery === "queue"; })) sources.push(...getPendingSource(item));
    return sources;
  }

  /** 返回当前缓存统计快照，不暴露内部 Map 或 source 数组。 */
  function getStats(): TuiViewportSourceCacheStats {
    return { ...stats };
  }

  /** 清空全部 source 缓存并重置统计，供生命周期切换和测试隔离使用。 */
  function clear(): void {
    history.clear();
    pending.clear();
    activePrompt = undefined;
    brand = undefined;
    live = undefined;
    width = undefined;
    for (const key of Object.keys(stats) as Array<keyof TuiViewportSourceCacheStats>) stats[key] = 0;
  }

  return { getSources, getStats, clear };
}
