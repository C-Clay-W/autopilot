/** Turn Presentation：按 Thinking、Tool、Approval、Answer、Evidence、Turn Summary 分区渲染共享安全状态。 */
"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { WebTurnFailure } from "../../../lib/runtime-host/web-turn-failure";
import type { AgentTerminationView } from "@autopilot-agent/core";
import MarkdownRenderer from "../../components/MarkdownRenderer";
import ActivityIndicator from "./ActivityIndicator";
import TodoListCard from "./TodoListCard";
import ApprovalCard from "./ApprovalCard";
import AskUserQuestionCard, { type UserQuestionAnswerDraft } from "./AskUserQuestionCard";
import ToolCard, { collapseRepeatedToolNames, ToolNameLabel } from "./ToolCard";
import type { WebActivityState } from "../../../lib/runtime-host/web-activity";
import {
  selectTurnTimeline,
  selectToolCalls,
  type AgentPresentationState,
  type ApprovalItem,
  type ThinkingItem,
  type ToolGroupItem,
  type TurnSummaryItem,
  type TimelineItem,
  type UndoItem,
  type UserQuestionItem,
} from "@autopilot-agent/presentation";

type TurnTimelineItem = Extract<TimelineItem, { turnId: string }>;

/** 判断时间线节点是否属于指定 Turn，排除没有 Turn 身份的 Host 通知。 */
function belongsToTurn(item: TimelineItem, turnId: string): item is TurnTimelineItem {
  return "turnId" in item && item.turnId === turnId;
}

interface TurnPresentationProps {
  state: AgentPresentationState;
  turnId: string;
  showThinking: boolean;
  evidence?: ReactNode;
  failure?: WebTurnFailure;
  termination?: AgentTerminationView;
  settingsHref?: string;
  disabled?: boolean;
  readOnly?: boolean;
  productMode?: "chat" | "work";
  ragEvidence?: boolean;
  /** 同一 Turn 从可恢复 checkpoint 继续后，在收到新的终态事件前隐藏上一轮 Summary。 */
  isResuming?: boolean;
  activity?: WebActivityState;
  /** 打开同一 Work Session 中由安全工具事实引用的后台 Job。 */
  onOpenBackgroundJob?: (jobId: string) => void;
  onApprovalDecision: (approval: ApprovalItem, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") => void;
  onUserQuestionSubmit: (question: UserQuestionItem, answers: UserQuestionAnswerDraft[]) => Promise<void>;
  onUserQuestionCancel: () => void;
}

/** 将毫秒耗时转换为紧凑的时分秒摘要，隐藏为零的高位单位。 */
function formatDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined) return undefined;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    ...(hours ? [`${hours} 小时`] : []),
    ...(minutes ? [`${minutes} 分`] : []),
    `${seconds} 秒`,
  ];
  return parts.join(" ");
}

/** 把白名单终态原因、Core 恢复判定与预算数值格式化为短状态行。 */
function formatTermination(termination: AgentTerminationView): string {
  const labels: Record<NonNullable<AgentTerminationView["reason"]>, string> = {
    runtime_budget: "执行时长达到上限",
    token_budget: "Token 预算耗尽",
    repeated_tool_calls: "检测到重复工具调用",
    write_verification: "等待修改文件读回验证",
    stale_lease: "执行租约已过期",
    turn_limit_reached: "达到执行步数上限",
  };
  const reason = termination.reason ? labels[termination.reason] : "任务已停止";
  const canContinue = termination.recoverable ? "可以继续执行" : "不能继续执行";
  const budget = termination.budget
    ? `${termination.budget.used} / ${termination.budget.limit} ${termination.budget.unit}`
    : undefined;
  return [reason, canContinue, budget].filter(Boolean).join(" · ");
}

/** 根据工具组展开状态绘制 12px 文件夹图标，固定 viewBox 防止展开前后基线错位。 */
function ToolGroupIcon({ expanded }: { expanded: boolean }) {
  if (expanded) return <svg className="h-3 w-3 shrink-0 text-accent" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="M1.25 3h3l1.1 1.25h5.4v1.2H1.25z" /><path d="M1.25 5.45h9.5L9.7 10.25H1.25z" /></svg>;
  return <svg className="h-3 w-3 shrink-0 text-accent" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="M1.25 2.25h3l1.1 1.5h5.4v6H1.25z" /><path d="M1.25 3.75h9.5" /></svg>;
}

/** 返回工具组的紧凑过程说明，阶段总结优先且保留组内调用数量。 */
function getToolGroupText(content: string | undefined, callCount: number, toolNames: string[]): string {
  const displayContent = collapseRepeatedToolNames(content, toolNames);
  return displayContent ? `${displayContent} · ${callCount} 项` : `已检查 ${callCount} 项`;
}

/** 取得 Thinking 后连续工具节点的名称，让 UI 摘要能合并首个不可分组工具之后的重复名称。 */
function getFollowingToolNames(timeline: TimelineItem[], state: AgentPresentationState, index: number): string[] {
  const names: string[] = [];
  for (let nextIndex = index + 1; nextIndex < timeline.length; nextIndex += 1) {
    const item = timeline[nextIndex];
    if (item.kind === "tool_call") {
      names.push(item.toolName);
      continue;
    }
    if (item.kind === "tool_group") {
      const calls = selectToolCalls(state, item.turnId).filter(function isGroupedCall(call) { return item.toolCallIds.includes(call.callId); });
      names.push(...calls.map(function getToolName(call) { return call.toolName; }));
      continue;
    }
    if (item.kind === "assistant_answer" && item.channel === "process") continue;
    break;
  }
  return names;
}

/** 渲染同一 Turn 被确定性分组的只读探索工具，展开后才显示子调用。 */
function ToolGroup({ group, state, content }: { group: ToolGroupItem; state: AgentPresentationState; content?: string }) {
  const [expanded, setExpanded] = useState(false);
  const calls = selectToolCalls(state, group.turnId).filter((call) => group.toolCallIds.includes(call.callId));
  const contentId = `tool-group-${group.id}`;

  /** 切换当前确定性工具组的局部明细视图，不改共享 Presentation 语义或顺序。 */
  function toggleExpanded(): void {
    setExpanded(!expanded);
  }

  const title = getToolGroupText(content, calls.length, calls.map(function getToolName(call) { return call.toolName; }));
  return (
    <section className="mt-1 text-xs">
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={title}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 py-0.5 text-left hover:bg-ink/10"
      >
        <ToolGroupIcon expanded={expanded} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate text-ink" title={title}><ToolNameLabel text={title} toolNames={calls.map(function getToolName(call) { return call.toolName; })} appendMissing /></span>
          <span className="shrink-0 text-muted text-[1.3em]" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </span>
        <span className={group.state === "running" ? "shrink-0 text-accent" : "shrink-0 text-muted"} title={group.state === "running" ? "正在执行" : "已完成"} aria-hidden="true">{group.state === "running" ? "·" : "✓"}</span>
      </button>
      <div id={contentId} className="ml-6" hidden={!expanded}>{calls.map((call) => <ToolCard key={call.callId} tool={call} />)}</div>
    </section>
  );
}

/** 绘制无工具动作关联的阶段总结图标，避免将其误解为工具标签。 */
function ThinkingIcon() {
  return <svg className="h-4 w-4 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="M12 3.5a6 6 0 0 0-3.6 10.8c.8.6 1.1 1.4 1.1 2.2h5c0-.8.3-1.6 1.1-2.2A6 6 0 0 0 12 3.5Z" /><path d="M9.5 20.5h5M10 17.5h4" /></svg>;
}

/** 渲染不含模型原始思维链的单条安全 Thinking 摘要。 */
function ThinkingSummary({ item, toolNames }: { item: ThinkingItem; toolNames: string[] }) {
  const summary = collapseRepeatedToolNames(item.summary, toolNames) ?? item.summary;
  return (
    <section className="mt-1 flex items-center gap-2 text-xs text-muted">
      <ThinkingIcon />
      <p className="min-w-0 truncate" title={summary}>{summary}</p>
    </section>
  );
}

/** 将已重置的安全回答按既有正文样式保留在时间线，过程通道只影响数据归属。 */
function ProcessAnswer({ content }: { content: string }) {
  return <section className="mt-3"><MarkdownRenderer content={content} /></section>;
}

/** 渲染共享 reducer 生成的 Turn 结构化结束摘要。 */
function TurnSummary({ summary }: { summary: TurnSummaryItem }) {
  const stateLabel = summary.state === "completed" ? "已完成" : summary.state === "limit_reached" ? "达到步骤上限" : summary.state === "interrupted" ? "用户已取消" : summary.state === "awaiting_approval" ? "等待授权" : summary.state === "paused" ? "已暂停" : "执行失败";
  const details = [`工具 ${summary.toolCount} 次`];
  if (summary.modifiedFileCount) details.push(`修改 ${summary.modifiedFileCount} 个文件`);
  const duration = formatDuration(summary.durationMs);
  if (duration) details.push(duration);
  return <section className="mt-3 border-t-2 border-ink pt-2 text-xs text-muted" role="status" aria-live="polite"><span className="font-semibold text-ink">Turn Summary · {stateLabel}</span><span> · {details.join(" · ")}</span></section>;
}

/** 渲染 Undo 的结构化结果；失败且存在已恢复或补偿路径时明确标示未完全完成，不提供强制覆盖操作。 */
function UndoNotice({ item }: { item: UndoItem }) {
  const partiallyCompleted = item.state === "failed" && (item.restoredPaths.length > 0 || item.compensatedPaths.length > 0);
  const title = item.state === "completed" ? "Undo 已完成" : partiallyCompleted ? "Undo 未完全完成" : "Undo 未完成";
  return (
    <section className="mt-3 border-l-4 border-accent bg-accent/10 px-3 py-2 text-xs" role="status" aria-live={item.state === "failed" ? "polite" : undefined}>
      <p className="font-semibold">{item.state === "failed" ? "⚠ " : "✓ "}{title}</p>
      {item.restoredPaths.length > 0 && <p className="mt-1 text-muted">已恢复：{item.restoredPaths.join("、")}</p>}
      {item.compensatedPaths.length > 0 && <p className="mt-1 text-muted">已补偿：{item.compensatedPaths.join("、")}</p>}
      {item.conflicts.length > 0 && <p className="mt-1 text-muted">检测到冲突，未覆盖：{item.conflicts.join("、")}</p>}
    </section>
  );
}

/** 展示已提交问题的脱敏摘要，不回显 Other 正文或原始答案对象。 */
function UserQuestionAnswerSummary({ item }: { item: UserQuestionItem }) {
  const details = item.answerSummary?.selectedLabels.length ? item.answerSummary.selectedLabels.join("、") : "已提供补充说明";
  return <section className="mt-3 mb-3 border-2 border-ink bg-card px-3 py-2 text-xs shadow-[3px_3px_0_var(--ink)]" role="status"><p className="font-semibold">澄清已提交</p><p className="mt-1 text-muted">{item.answerSummary?.questionCount ?? item.questions.length} 题 · {details}{item.answerSummary?.hasCustom ? " · 含补充说明" : ""}</p></section>;
}

/** 渲染指定 Turn 的完整安全时间线，各分区不混入原始 Runtime 字段。 */
export default function TurnPresentation({ state, turnId, showThinking, evidence, failure, termination, settingsHref = "/settings", disabled, readOnly = false, productMode = "work", ragEvidence = false, isResuming = false, activity, onOpenBackgroundJob, onApprovalDecision, onUserQuestionSubmit, onUserQuestionCancel }: TurnPresentationProps) {
  const timeline = selectTurnTimeline(state, turnId).filter((item): item is TurnTimelineItem => belongsToTurn(item, turnId) && (productMode !== "chat" || !["approval", "user_question", "undo", "todo", "input_notice"].includes(item.kind)));
  const turnSummary = timeline.find((item): item is TurnSummaryItem => item.kind === "turn_summary");
  let backgroundJobId: string | undefined;
  timeline.forEach(function findStartedJob(item) {
    if (item.kind === "tool_call" && item.state === "completed" && item.job?.action === "start" && item.job.jobId) backgroundJobId = item.job.jobId;
  });
  const hasRequiredUserQuestion = timeline.some(function findRequiredUserQuestion(item) {
    return item.kind === "user_question" && item.state === "required";
  });
  const activeOperation = !readOnly && state.turnId === turnId ? state.activeOperation : undefined;
  const activeItem = activeOperation?.kind === "tool" ? state.items.find((item) => item.id === activeOperation.id) : undefined;
  const activeTool = activeItem?.kind === "tool_call" ? activeItem : undefined;
  const turnActivity = activity?.turnId === turnId ? activity : undefined;
  const isRunning = !readOnly && !failure && Boolean(disabled) && state.turnId === turnId && (!turnSummary || isResuming || hasRequiredUserQuestion);
  const hideTurnSummary = isResuming || hasRequiredUserQuestion;
  const startedAt = Date.parse(state.turnStartedAt[turnId] ?? "");

  return (
    <div className="space-y-2">
      {timeline.map(function renderTimelineItem(item, index) {
        const previousItem = timeline[index - 1];
        const nextItem = timeline[index + 1];
        if (item.kind === "todo") return null;
        if (item.kind === "input_notice" && item.content !== undefined) return <section key={item.id} className="mt-3 flex justify-end"><div className="max-w-[80%] border-2 border-ink bg-accent px-4 py-3 text-sm text-ink"><p className="whitespace-pre-wrap">{item.content}</p><p className="mt-1 text-xs">{item.delivery === "queue" ? "排队" : "引导"} · {item.cancelled ? "已取消" : item.state === "queued" ? "等待当前步骤结束" : "已接收"}</p></div></section>;
        if (item.kind === "thinking") {
          if (!showThinking) return null;
          const followingToolNames = getFollowingToolNames(timeline, state, index);
          if (nextItem?.kind === "tool_call") return <ToolCard key={item.id} tool={nextItem} content={item.summary} toolNames={followingToolNames} />;
          if (nextItem?.kind === "tool_group") return <ToolGroup key={item.id} group={nextItem} state={state} content={item.summary} />;
          return <ThinkingSummary key={item.id} item={item} toolNames={followingToolNames} />;
        }
        if (item.kind === "tool_call") return showThinking && previousItem?.kind === "thinking" ? null : <ToolCard key={item.callId} tool={item} />;
        if (item.kind === "tool_group") return showThinking && previousItem?.kind === "thinking" ? null : <ToolGroup key={item.id} group={item} state={state} />;
        if (item.kind === "approval" && readOnly) return <p key={item.id} className="text-xs text-muted">历史审批记录（仅查看）</p>;
        if (item.kind === "approval") return item.state === "required" ? <ApprovalCard key={item.approvalId} approval={item} disabled={disabled} onDecision={(decision) => onApprovalDecision(item, decision)} /> : null;
        if (item.kind === "user_question" && readOnly) return <p key={item.id} className="text-xs text-muted">历史提问记录（仅查看）</p>;
        if (item.kind === "user_question") return item.state === "required" ? <AskUserQuestionCard key={item.id} question={item} disabled={disabled} onSubmit={(answers) => onUserQuestionSubmit(item, answers)} onCancel={onUserQuestionCancel} /> : item.state === "answered" ? <UserQuestionAnswerSummary key={item.id} item={item} /> : null;
        if (item.kind === "undo") return <UndoNotice key={item.transactionId} item={item} />;
        if (item.kind === "assistant_answer") return item.channel === "process"
          ? <ProcessAnswer key={item.id} content={item.content} />
          : <section key={item.id} className="mt-3">
            <MarkdownRenderer content={item.content} ragEvidence={productMode === "chat" && ragEvidence} />
            {productMode === "work" && backgroundJobId && onOpenBackgroundJob && <button type="button" onClick={function openBackgroundJob() { onOpenBackgroundJob(backgroundJobId); }} className="mt-3 border-2 border-ink bg-card px-3 py-1.5 text-xs font-semibold hover:bg-ink hover:text-ink-on-dark">查看后台任务</button>}
          </section>;
        if (item.kind === "turn_summary") return null;
        return null;
      })}
      <ActivityIndicator activeOperation={activeOperation} toolStartedAt={activeTool?.startedAt} activity={turnActivity} running={isRunning} startedAt={Number.isFinite(startedAt) ? startedAt : undefined} />
      {evidence}
      {timeline.filter(function todo(item): item is Extract<TurnTimelineItem, { kind: "todo" }> { return item.kind === "todo"; }).map(function card(item) { return <TodoListCard key={item.id} item={item} />; })}
      {failure && <section role="alert" className="mt-3 border-2 border-error bg-error/10 px-4 py-3 text-sm"><p className="font-semibold text-error">{failure.code === "MISSING_CREDENTIAL" ? "需要配置主模型 API Key" : "任务执行失败"}</p><p className="mt-2 text-ink">{failure.message}</p><Link href={settingsHref} className="mt-3 inline-block border-2 border-ink px-3 py-1.5 font-semibold text-accent hover:bg-ink hover:text-ink-on-dark">前往配置</Link></section>}
      {termination && <p role="status" className="mt-3 border-l-2 border-accent bg-accent/5 px-3 py-2 text-xs text-muted">{formatTermination(termination)}</p>}
      {!hideTurnSummary && turnSummary && <TurnSummary summary={turnSummary} />}
    </div>
  );
}
