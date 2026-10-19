/**
 * Agent 工具调用卡片：只消费共享 Presentation 的安全展示事实，并按 callId 保持唯一节点。
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getPresentationCopy, isSandboxUnavailableErrorCode, type ToolCallItem } from "@autopilot-agent/presentation";
import ToolDetail from "./ToolDetail";

interface ToolCardProps {
  tool: ToolCallItem;
  content?: string;
  /** 当前过程摘要关联的工具名，用于只在 UI 展示副本中合并重复名称。 */
  toolNames?: string[];
}

/** 将正则特殊字符转义，供展示层匹配安全工具名称。 */
function escapeToolNameForRegExp(toolName: string): string {
  return toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 仅在 UI 展示副本中合并相邻重复工具标记，不改变 Runtime 或 Presentation 数据。 */
export function collapseRepeatedToolNames(content: string | undefined, toolNames: string[]): string | undefined {
  if (!content) return content;
  let collapsed = content;
  for (const toolName of [...new Set(toolNames)].filter(Boolean)) {
    const escapedName = escapeToolNameForRegExp(toolName);
    const repeatedNamePattern = new RegExp(`${escapedName}(?:(?:\\s*(?:、|,|，|\\||·|/|和|及)\\s*|\\s+)${escapedName})+`, "g");
    collapsed = collapsed.replace(repeatedNamePattern, function mergeRepeatedName(match: string): string {
      const count = match.match(new RegExp(escapedName, "g"))?.length ?? 1;
      return `${toolName} ×${count}`;
    });
  }
  return collapsed;
}

/** 将共享工具状态转换为稳定的无障碍说明；沙箱不可用类拒绝是环境阻塞，不得显示为用户拒绝。 */
function getToolStatusLabel(state: ToolCallItem["state"], errorCode?: string): string {
  if (state === "running") return "正在执行";
  if (state === "awaiting_approval") return "等待授权";
  if (state === "completed") return "已完成";
  if (state === "denied") return isSandboxUnavailableErrorCode(errorCode) ? "沙箱不可用，命令未启动" : "已拒绝";
  if (state === "cancelled") return "已取消";
  if (state === "timeout") return "已超时";
  return "执行失败";
}

/** 将工具状态映射为紧凑的单字符状态标识，避免占用过程行宽度。 */
function getToolStatusGlyph(state: ToolCallItem["state"]): string {
  if (state === "running") return "·";
  if (state === "completed") return "✓";
  if (state === "awaiting_approval") return "!";
  return "×";
}

/** 判断工具终态是否应使用错误反馈色，避免将成功和失败混为同一弱化颜色。 */
function isFailedToolState(state: ToolCallItem["state"]): boolean {
  return state === "failed" || state === "denied" || state === "cancelled" || state === "timeout";
}

/** 读取 edit diff 的新增/删除行数，兼容旧历史中缺少统计字段的安全文本。 */
export function getDiffStats(diff: ToolCallItem["diff"]): { added: number; removed: number } | undefined {
  if (!diff) return undefined;
  const lines = diff.text?.replace(/\r\n?/g, "\n").split("\n");
  const added = diff.added ?? lines?.filter(function countAdded(line) { return line.startsWith("+") && !line.startsWith("+++"); }).length;
  const removed = diff.removed ?? lines?.filter(function countRemoved(line) { return line.startsWith("-") && !line.startsWith("---"); }).length;
  if (added === undefined && removed === undefined) return undefined;
  return { added: added ?? 0, removed: removed ?? 0 };
}

/** 渲染带正负号的 diff 统计，新增复用成功绿、删除复用错误红。 */
export function DiffStatsLabel({ statistics }: { statistics: { added: number; removed: number } }) {
  return <>(<span className="text-success">+{statistics.added}</span>, <span className="text-error">-{statistics.removed}</span>)</>;
}

/** 将 diff 统计格式化为 title 与无障碍文本使用的稳定纯文本。 */
function formatDiffStats(statistics: { added: number; removed: number } | undefined): string | undefined {
  return statistics ? `(+${statistics.added}, -${statistics.removed})` : undefined;
}

/** 将阶段总结、受控目标和安全结果摘要合并为一条可扫描的过程说明。 */
function getToolDisplayText(tool: ToolCallItem, content: string | undefined, toolNames: string[]): string {
  const primary = content || tool.resultSummary || tool.target || getPresentationCopy(tool.titleKey);
  const combined = !content || !tool.target || content === tool.target ? primary : `${content} · ${tool.target}`;
  return collapseRepeatedToolNames(combined, toolNames) ?? combined;
}

/** 在安全展示文本内强调工具名；摘要未携带名称时补出稳定的强调色名称。 */
export function ToolNameLabel({ text, toolNames, appendMissing = false }: { text: string; toolNames: string[]; appendMissing?: boolean }) {
  const names = [...new Set(toolNames)].filter(Boolean);
  const visibleText = collapseRepeatedToolNames(text, names) ?? text;
  let cursor = 0;
  let previousWasToolName = false;
  const matchedNames = new Set<string>();
  const content: ReactNode[] = [];

  while (cursor < visibleText.length) {
    const matches = names.map(function findToolName(name) { return { name, index: visibleText.indexOf(name, cursor) }; }).filter(function hasMatch(match) { return match.index >= 0; }).sort(function compareMatch(left, right) { return left.index - right.index; });
    const match = matches[0];
    if (!match) {
      content.push(visibleText.slice(cursor));
      break;
    }
    if (match.index > cursor) {
      content.push(visibleText.slice(cursor, match.index));
      previousWasToolName = false;
    } else if (previousWasToolName) {
      content.push("、");
    }
    content.push(<span key={`${match.index}-${match.name}`} className="text-accent">{match.name}</span>);
    matchedNames.add(match.name);
    cursor = match.index + match.name.length;
    previousWasToolName = true;
  }

  if (appendMissing) {
    names.filter(function findMissingName(name) { return !matchedNames.has(name); }).forEach(function appendMissingName(name, index) {
      content.push(index === 0 ? (content.length > 0 ? " · " : "") : "、");
      content.push(<span key={`missing-${name}`} className="text-accent">{name}</span>);
    });
  }

  return <>{content}</>;
}

/** 根据工具类别绘制紧凑的语义 SVG 图标，不依赖外部图标资源。 */
function ToolIcon({ tool }: ToolCardProps) {
  let content: ReactNode;
  if (tool.category === "read") content = <><path d="M5 3.5h7l3 3V20.5H5z" /><path d="M12 3.5v3h3M8 11h4M8 14h4M8 17h3" /></>;
  else if (tool.category === "search") content = <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>;
  else if (tool.category === "edit") content = <><path d="M5 4.5h9v5M5 4.5v15h14V10" /><path d="m10 16.5-1 .5.5-1L16 9.5l1.5 1.5Z" /></>;
  else if (tool.category === "write") content = <><path d="M5 3.5h9l3 3v14H5z" /><path d="M14 3.5v3h3M8 12h6M8 16h5" /><path d="m16 12 2 2" /></>;
  else if (tool.category === "command") content = <><path d="m5 7 4 4-4 4M11.5 16H19" /><rect x="3" y="4" width="18" height="16" /></>;
  else if (tool.category === "process") content = <><circle cx="6" cy="6" r="1.5" /><circle cx="18" cy="6" r="1.5" /><circle cx="12" cy="18" r="1.5" /><path d="M7.5 6h9M6 7.5v5l6 4.5 6-4.5v-5" /></>;
  else if (tool.category === "external") content = <><path d="M13 5h6v6M19 5l-8 8" /><path d="M19 14v5H5V5h5" /></>;
  else content = <><circle cx="12" cy="12" r="7" /><path d="M9 12h6M12 9v6" /></>;

  return <svg className="h-4 w-4 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">{content}</svg>;
}

/** 为安全的 unified diff 行提供最小视觉区分，不解析或执行任何内容。 */
export function getDiffLineClass(line: string): string {
  if (line.startsWith("+")) return "block bg-accent/15 text-accent";
  if (line.startsWith("-")) return "block bg-ink/10 text-muted";
  if (line.startsWith("@@")) return "block text-muted";
  return "block text-ink";
}

/** 渲染 Core 已脱敏并截断的 edit_file diff，保持长行可横向查看。 */
function ToolDiff({ tool }: ToolCardProps) {
  const text = tool.diff?.text;
  if (!text) return null;
  const diffStats = getDiffStats(tool.diff);
  const fileStatistics = tool.diff.files ? `${tool.diff.files} 个文件` : undefined;

  return (
    <div className="mt-1 max-h-80 overflow-auto border border-ink bg-bg p-2">
      <p className="mb-1 text-[10px] text-muted">{fileStatistics}{fileStatistics && diffStats ? " · " : null}{diffStats ? <DiffStatsLabel statistics={diffStats} /> : null}{tool.diff?.truncated ? `${fileStatistics || diffStats ? " · " : ""}已截断` : ""}</p>
      <pre className="overflow-x-auto text-[11px] leading-5"><code>{text.split("\n").map(function renderDiffLine(line, index) {
        return <span key={`${index}-${line}`} className={getDiffLineClass(line)}>{line || " "}</span>;
      })}</code></pre>
    </div>
  );
}

/** 渲染单次 Agent 工具调用的 Harness 式单行 disclosure，不展示重复工具标签。 */
export default function ToolCard({ tool, content, toolNames: providedToolNames }: ToolCardProps) {
  const isRunning = tool.state === "running";
  const [expanded, setExpanded] = useState(Boolean(tool.diff?.text));
  const contentId = `tool-body-${tool.callId}`;
  const toolNames = providedToolNames?.length ? [...new Set(providedToolNames)].filter(Boolean) : [tool.toolName];
  // 编辑 diff 与工具专用明细共用同一个局部展开状态；没有安全结果体时不显示虚假展开入口。
  const canExpand = Boolean(tool.detail || tool.diff?.text);
  const diffStats = getDiffStats(tool.diff);
  const displayText = getToolDisplayText(tool, content, toolNames);
  const diffStatsText = formatDiffStats(diffStats);
  const visibleContent = `${displayText}${diffStatsText ? ` ${diffStatsText}` : ""}`;
  const accessibleLabel = `${tool.toolName}：${visibleContent}，${getToolStatusLabel(tool.state, tool.errorCode)}`;
  const statusClass = isRunning ? "shrink-0 text-accent" : isFailedToolState(tool.state) ? "shrink-0 bg-error px-1 font-bold text-ink" : "shrink-0 text-muted";

  /** 工具完成后首次收到安全 Diff 时默认展开，避免用户错过实际文件修改。 */
  useEffect(function revealFinishedDiff() {
    if (!tool.diff?.text) return;
    const timer = window.setTimeout(function revealDiffAfterCommit() {
      setExpanded(true);
    }, 0);
    return function clearRevealTimer() {
      window.clearTimeout(timer);
    };
  }, [tool.diff?.text]);

  /** 切换编辑 Diff 与工具明细的局部视图，不改变共享事件状态。 */
  function toggleExpanded(): void {
    setExpanded(!expanded);
  }

  return (
    <section className="mt-1 text-xs">
      <button type="button" onClick={toggleExpanded} aria-label={accessibleLabel} aria-expanded={canExpand ? expanded : undefined} aria-controls={canExpand ? contentId : undefined} disabled={!canExpand} className="flex w-full items-center gap-2 py-0.5 text-left hover:bg-ink/10 disabled:cursor-default disabled:hover:bg-transparent">
        <ToolIcon tool={tool} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate text-ink" title={`${tool.toolName} · ${visibleContent}`}><ToolNameLabel text={displayText} toolNames={toolNames} appendMissing={toolNames.length === 1} />{diffStats ? <> <DiffStatsLabel statistics={diffStats} /></> : null}</span>
          {canExpand && <span className="shrink-0 text-muted text-[1.3em]" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
        </span>
        <span className={statusClass} title={getToolStatusLabel(tool.state, tool.errorCode)} aria-hidden="true">{getToolStatusGlyph(tool.state)}{isFailedToolState(tool.state) ? ` ${getToolStatusLabel(tool.state, tool.errorCode)}` : ""}</span>
      </button>
      {canExpand && expanded && (
        <div id={contentId} className="ml-6">
          <ToolDiff tool={tool} />
          <ToolDetail detail={tool.detail} />
        </div>
      )}
      {tool.executionMode === "unisolated" && <p className="ml-6 mt-0.5 text-[10px] text-error">未隔离执行：本次命令未经沙箱隔离，由宿主直接运行</p>}
      {tool.diagnostics?.length ? <p className="ml-6 mt-0.5 text-[10px] text-muted">诊断：{tool.diagnostics.join("；")}</p> : null}
    </section>
  );
}
