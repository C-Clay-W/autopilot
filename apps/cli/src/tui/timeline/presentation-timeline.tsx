/** 基于共享 Presentation selector 的 CLI 时间线；不读取旧工具 summary、detail 或审批 preview。 */

import { getPresentationCopy, getToolPresentationProfile, isSandboxUnavailableErrorCode, selectToolCalls, type AgentPresentationState, type TimelineItem } from "@autopilot-agent/presentation";
import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_BG_COLOR, TUI_ACCENT_COLOR, TUI_CHIP_TEXT_COLOR, TUI_TOOL_ERROR_BG_COLOR, TUI_TOOL_ERROR_TEXT_COLOR } from "../../design-tokens.js";
import { TUI_AGENT_LABEL } from "../constants.js";
import { TuiDiffStats } from "../diff-stats.js";
import { getTuiDiffStats } from "../format.js";
import { TuiDiffBlock } from "../markdown/diff.js";
import { TuiMarkdown } from "../markdown/markdown.js";
import { TuiPromptLine } from "../transcript.js";
import { TuiTodoList } from "../todo-list.js";
import type { CliTuiTimelineEvent } from "../types.js";
import { getTuiTurnItems } from "./turn-items.js";

/** 详情视图参数：expanded 驱动 Todo 卡展开，toolGroupsExpanded 驱动工具分组展开；screen reader 恒展开全部明细。 */
type TuiDetailView = { expanded: boolean; screenReader: boolean; rowLimit?: number; showToggleHint?: boolean; toolGroupsExpanded?: boolean };

/** 工具 callId 到真实节点的索引，供展开分组时按 id 取回组内调用。 */
type TuiToolCallIndex = Map<string, Extract<TimelineItem, { kind: "tool_call" }>>;

/** 取得 ToolCall 的纯文本状态标志，不依赖颜色表达执行结果。 */
function getToolStateGlyph(state: Extract<TimelineItem, { kind: "tool_call" }> ["state"]): string {
  if (state === "completed") return "•";
  if (state === "denied") return "×";
  if (state === "cancelled" || state === "timeout") return "⚠";
  if (state === "failed") return "×";
  return "✢";
}

/** 取得拒绝、取消与超时文字；执行失败由叉号和错误详情表达。沙箱不可用类拒绝是环境阻塞而非用户拒绝，文案必须区分。 */
function getToolStateText(state: Extract<TimelineItem, { kind: "tool_call" }> ["state"], errorCode?: string): string | undefined {
  if (state === "denied") return isSandboxUnavailableErrorCode(errorCode) ? "沙箱不可用，命令未启动" : "已拒绝";
  if (state === "cancelled") return "已取消";
  if (state === "timeout") return "已超时";
  return undefined;
}

/** 判断工具是否处于失败类终态；失败步骤文字使用错误红并保留文字标签。 */
function isFailedToolState(state: Extract<TimelineItem, { kind: "tool_call" }>["state"]): boolean {
  return state === "failed" || state === "denied" || state === "cancelled" || state === "timeout";
}

/** 取得 Turn 的纯文本终态标志，不把失败、取消和上限混为成功。 */
function getTurnStateGlyph(state: Extract<TimelineItem, { kind: "turn_summary" }> ["state"]): string {
  return state === "completed" ? "✓" : state === "interrupted" || state === "paused" ? "⚠" : "×";
}

/** 从 Core 冻结的 Web 明细生成 TUI 安全文案，不读取 query、URL 路径或网页正文。 */
function getWebToolDetailText(item: Extract<TimelineItem, { kind: "tool_call" }>): string | undefined {
  if (item.detail?.kind === "web_search") {
    const summary = item.detail.sourceCount === 0 ? "搜索服务未返回结构化引用" : `找到 ${item.detail.sourceCount} 个公开来源`;
    return `${summary}${item.detail.truncated ? " · 结果已截断" : ""}`;
  }
  if (item.detail?.kind === "web_fetch") {
    return `${item.detail.host} · ${item.detail.contentType}${item.detail.truncated ? " · 内容已截断" : ""}`;
  }
  return undefined;
}

/** 将一个共享 selector 节点渲染为 Ink 视图，Tool 节点的 React key 始终绑定 callId。 */
function renderPresentationItem(item: TimelineItem, useColor: boolean, maximumWidth: number, detailView: TuiDetailView, toolCallIndex?: TuiToolCallIndex): ReactNode {
  if (item.kind === "todo") return <Box key={item.id} flexDirection="column"><TuiTodoList item={item} expanded={detailView.expanded || detailView.screenReader} useColor={useColor} screenReader={detailView.screenReader} columns={maximumWidth + 2} rowLimit={detailView.rowLimit} showToggleHint={detailView.showToggleHint} /></Box>;
  if (item.kind === "thinking") return <Text key={item.id} dimColor={useColor}>✢ {item.summary}</Text>;
  if (item.kind === "tool_group") {
    const summary = (
      <Text key={item.id}>
        <Text dimColor={useColor}>• Exploring codebase · </Text>
        <Text color={useColor ? TUI_ACCENT_COLOR : undefined}>{item.toolCallIds.length}</Text>
        <Text dimColor={useColor}> operations</Text>
      </Text>
    );
    // 分组默认只显示摘要；Ctrl+O 详情态或 screen reader 下展开渲染组内各调用。
    if (!detailView.toolGroupsExpanded && !detailView.screenReader) return summary;
    const children = item.toolCallIds
      .map(function findGroupChild(callId) { return toolCallIndex?.get(callId); })
      .filter(function isKnownCall(child) { return child !== undefined; });
    return (
      <Box key={item.id} flexDirection="column">
        {summary}
        {children.map(function renderGroupChild(child) { return <Box key={child.callId} paddingLeft={2}>{renderPresentationItem(child, useColor, maximumWidth, detailView, toolCallIndex)}</Box>; })}
      </Box>
    );
  }
  if (item.kind === "tool_call") {
    const title = getPresentationCopy(item.state === "failed" ? getToolPresentationProfile(item.toolName).completedTitleKey : item.titleKey);
    const jobProgramLabel = item.job?.action === "start" ? item.job.programLabel?.toUpperCase() : undefined;
    const diffStats = getTuiDiffStats(item.diff);
    const detail = getWebToolDetailText(item) ?? [jobProgramLabel ? undefined : item.target, item.resultSummary].filter(Boolean).join(" · ");
    const glyph = getToolStateGlyph(item.state);
    // 失败沿用完成态工具名称，仅徽标使用错误红；前缀符号独立显示。
    const stateText = getToolStateText(item.state, item.errorCode);
    const head = isFailedToolState(item.state)
      ? <Text><Text color={useColor ? TUI_TOOL_ERROR_BG_COLOR : undefined}>{glyph} </Text><Text backgroundColor={useColor ? TUI_TOOL_ERROR_BG_COLOR : undefined} color={useColor ? TUI_TOOL_ERROR_TEXT_COLOR : undefined} bold={useColor || undefined}>[{title}]{stateText ? ` · ${stateText}` : ""}</Text></Text>
      : <Text><Text dimColor={useColor}>{glyph} </Text><Text backgroundColor={useColor ? TUI_ACCENT_BG_COLOR : undefined} color={useColor ? TUI_CHIP_TEXT_COLOR : undefined} bold={useColor || undefined}>[{title}]</Text></Text>;
    return <Box key={item.callId} flexDirection="column">
      {head}
      {jobProgramLabel ? <Text>  └─ <Text bold color={useColor ? TUI_ACCENT_COLOR : undefined}>{jobProgramLabel}</Text>{detail ? <Text dimColor={useColor}> · {detail}</Text> : null}</Text> : detail || diffStats ? <Text>  └─ {detail ? <Text dimColor={useColor}>{detail} </Text> : null}{diffStats ? <TuiDiffStats {...diffStats} useColor={useColor} /> : null}</Text> : null}
      {item.errorCode ? <Text dimColor={useColor}>  └─ {item.errorCode}</Text> : null}
      {item.executionMode === "unisolated" ? <Text color={useColor ? TUI_TOOL_ERROR_TEXT_COLOR : undefined}>  └─ 未隔离：宿主直接执行</Text> : null}
      {item.diagnostics?.length ? <Text dimColor={useColor}>  └─ 诊断：{item.diagnostics.join("；")}</Text> : null}
      {item.job?.action === "start" && (item.job.observedStatus === "starting" || item.job.observedStatus === "running") ? <Text dimColor={useColor}>  /jobs 查看后台任务</Text> : null}
      {item.diff?.text ? <TuiDiffBlock diff={item.diff.text} keyPrefix={item.callId} useColor={useColor} /> : null}
    </Box>;
  }
  if (item.kind === "approval") {
    const detail = item.display?.actionPreview ?? item.display?.operation ?? "需要确认";
    // 历史行与待审卡共用 constraint 判定，普通批准与无沙箱批准不得混淆。
    const noSandbox = item.constraint === "no-sandbox-exec:v1" ? " · 无沙箱直接执行" : "";
    return <Text key={item.id} dimColor={useColor}>⚠ {detail}{noSandbox}{item.state === "resolved" ? " · 已处理" : ""}</Text>;
  }
  if (item.kind === "user_question") return <Text key={item.id} dimColor={useColor}>请在支持结构化回答的 Web 中处理</Text>;
  if (item.kind === "assistant_answer") {
    if (item.channel === "process") return <TuiMarkdown key={item.id} content={item.content} keyPrefix={item.id} useColor={useColor} maximumWidth={maximumWidth} />;
    return <Box key={item.id} flexDirection="column"><Text bold color={useColor ? TUI_ACCENT_COLOR : undefined}>• {TUI_AGENT_LABEL}</Text><TuiMarkdown content={item.content} keyPrefix={item.id} useColor={useColor} maximumWidth={maximumWidth} /></Box>;
  }
  if (item.kind === "context_notice") return <Text key={item.id} dimColor={useColor}>{item.state === "compacted" ? "Context organized" : `Context ${item.state}`}</Text>;
  if (item.kind === "undo") {
    const isPartial = item.state === "failed" && (item.restoredPaths.length > 0 || item.compensatedPaths.length > 0);
    const title = item.state === "completed" ? "Undo completed" : isPartial ? "Undo incomplete" : "Undo failed";
    return <Box key={item.id} flexDirection="column">
      <Text dimColor={useColor}>{item.state === "completed" ? "✓" : "⚠"} {title}</Text>
      {item.restoredPaths.length > 0 ? <Text dimColor={useColor}>  restored: {item.restoredPaths.join(", ")}</Text> : null}
      {item.compensatedPaths.length > 0 ? <Text dimColor={useColor}>  compensated: {item.compensatedPaths.join(", ")}</Text> : null}
      {item.conflicts.length > 0 ? <Text dimColor={useColor}>  conflicts (not overwritten): {item.conflicts.join(", ")}</Text> : null}
    </Box>;
  }
  if (item.kind === "input_notice") return <Text key={item.id} dimColor={useColor}>{item.delivery === "steer" ? "[引导] " : item.delivery === "queue" ? "[排队] " : ""}Input {item.state}</Text>;
  if (item.kind === "turn_summary") return <Text key={item.id} dimColor={useColor}>{getTurnStateGlyph(item.state)} {getPresentationCopy(`turn.${item.state}`)} · {item.toolCount} tools</Text>;
  if (item.kind === "job") {
    if (item.state === "interrupted") return <Box key={item.id} flexDirection="column"><Text dimColor={useColor}>⚠ Job interrupted</Text><Text dimColor={useColor}>  Process cannot be reattached after restart.</Text></Box>;
    return <Text key={item.id} dimColor={useColor}>Job {item.state}{item.summary ? ` · ${item.summary}` : ""}</Text>;
  }
  if (item.kind === "capability_notice") return <Text key={item.id} dimColor={useColor}>{item.summary ?? item.state}</Text>;
  return null;
}

/** 渲染指定 Turn 的共享 Presentation 时间线；无匹配节点时由调用方回退兼容旧事件。 */
export function renderTuiPresentationTimeline(presentation: AgentPresentationState, turnId: string, useColor: boolean, maximumWidth: number, detailView: TuiDetailView, events: CliTuiTimelineEvent[] = []): ReactNode[] {
  // 构建 callId 索引供展开分组取回组内调用；分组只按 callId 引用，不携带子节点事实。
  const toolCallIndex: TuiToolCallIndex = new Map(selectToolCalls(presentation, turnId).map(function indexToolCall(call) { return [call.callId, call]; }));
  return getTuiTurnItems(presentation, turnId, events).map(function renderSharedTimelineItem(item): ReactNode {
    if ("type" in item) return <Box key={`input:${item.inputId}`} flexDirection="column"><TuiPromptLine content={item.content} useColor={useColor} columns={maximumWidth + 2} /><Text dimColor={useColor}>{item.delivery === "queue" ? "[排队]" : "[引导]"} {item.cancelled ? "已取消" : item.consumed === false ? "等待当前步骤结束" : "已插入当前 turn"}</Text></Box>;
    return renderPresentationItem(item, useColor, maximumWidth, detailView, toolCallIndex);
  });
}
