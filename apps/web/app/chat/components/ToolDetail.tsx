/**
 * 工具专用明细：只按 Core 生成的 ToolDisplayDetail.kind 渲染紧凑结果体。
 *
 * 不建立通用 JSON viewer，不接收 unknown output，不重新解释 raw result；
 * 正文、匹配文本与绝对路径在进入本组件之前就已被 Core projector 丢弃。
 */
"use client";

import { useState } from "react";
import type { ToolDisplayDetail } from "@autopilot-agent/core";

const PATH_PREVIEW_LIMIT = 5;
const LINE_NUMBER_PREVIEW_LIMIT = 8;
const FILE_PREVIEW_LIMIT = 5;

/** 二级展开按钮：只折叠 detail 中真实存在的条目，精确显示剩余数量；展开后按钮即消失，故恒为 false。 */
function MoreToggle({ label, remaining, onToggle }: { label: string; remaining: number; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={false} aria-label={`展开其余 ${remaining} 项`} className="mt-0.5 border-b border-dotted border-ink/40 text-[10px] text-accent hover:bg-ink/10">
      {label} {remaining} 项
    </button>
  );
}

/** 等宽相对路径行；长路径允许横向滚动，不撑破对话宽度。 */
function PathLine({ value }: { value: string }) {
  return <li className="overflow-x-auto whitespace-nowrap text-[11px] leading-5 text-ink" title={value}>{value}</li>;
}

/** 分别展示工具执行与 Core display 的截断事实，避免把任一层遗漏伪装成完整结果。 */
function TruncationNotices({ executionTruncated, displayTruncated, paginationText }: { executionTruncated: boolean; displayTruncated?: true; paginationText?: string }) {
  return (
    <>
      {displayTruncated && <p className="mt-1 text-[10px] text-muted">展示明细已截断，请缩小搜索范围</p>}
      {executionTruncated && <p className="mt-1 text-[10px] text-muted">结果已截断，请缩小搜索范围</p>}
      {paginationText && <p className="mt-1 text-[10px] text-muted">{paginationText}</p>}
    </>
  );
}

/** 将 Core 已证明的分页总数转换为不误称“执行截断”的提示文案。 */
function getPaginationText(shownCount: number, totalCount: number | undefined, unit: string): string | undefined {
  if (totalCount === undefined || totalCount <= shownCount) return undefined;
  return `当前显示 ${shownCount}/${totalCount} ${unit}，其余结果请缩小搜索范围`;
}

/** glob_files 与 grep_paths 的有界路径列表；未知总数和 Core display 截断均不伪造剩余数量。 */
function PathListDetail({ paths, totalCount, paginationUnit, executionTruncated, displayTruncated }: { paths: string[]; totalCount?: number; paginationUnit: string; executionTruncated: boolean; displayTruncated?: true }) {
  const [showAll, setShowAll] = useState(false);
  const paginationText = getPaginationText(paths.length, totalCount, paginationUnit);
  if (paths.length === 0) {
    return <><p className="text-[10px] text-muted">未发现文件</p><TruncationNotices executionTruncated={executionTruncated} displayTruncated={displayTruncated} paginationText={paginationText} /></>;
  }
  const visible = showAll ? paths : paths.slice(0, PATH_PREVIEW_LIMIT);

  return (
    <>
      <ul className="mt-1 list-none space-y-0.5">
        {visible.map(function renderPath(value) {
          return <PathLine key={value} value={value} />;
        })}
      </ul>
      {!showAll && paths.length > PATH_PREVIEW_LIMIT && <MoreToggle label="其余" remaining={paths.length - PATH_PREVIEW_LIMIT} onToggle={function showRest() { setShowAll(true); }} />}
      <TruncationNotices executionTruncated={executionTruncated} displayTruncated={displayTruncated} paginationText={paginationText} />
    </>
  );
}

/** read_file 的实际行范围；endLine 为 null 时收敛为空范围文案，不生成非法数字。 */
function ReadDetail({ detail }: { detail: Extract<ToolDisplayDetail, { kind: "read_file" }> }) {
  const hasLines = detail.endLine !== null && detail.returnedLines > 0;
  return (
    <div className="mt-1 border-l-2 border-ink/20 pl-2">
      <p className="overflow-x-auto whitespace-nowrap text-[11px] leading-5 text-ink" title={detail.path}>{detail.path}</p>
      <p className="mt-0.5 text-[10px] text-muted">
        {hasLines
          ? <>已读取第 <span className="text-ink">{detail.startLine}–{detail.endLine}</span> 行 · 共 <span className="text-ink">{detail.totalLines}</span> 行</>
          : <>未读取到内容 · 共 <span className="text-ink">{detail.totalLines}</span> 行</>}
        {detail.truncated && <span className="text-accent"> · 已截断</span>}
      </p>
    </div>
  );
}

/** 按文件显示命中行号；行号升序去重由 Core 冻结，组件不重新解释原始匹配文本。 */
function GrepContentDetail({ detail }: { detail: Extract<ToolDisplayDetail, { kind: "grep_content" }> }) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const visibleFiles = showAllFiles ? detail.files : detail.files.slice(0, FILE_PREVIEW_LIMIT);
  const paginationText = getPaginationText(detail.shownMatchedLineCount, detail.totalMatchedLineCount, "行");
  return (
    <div className="mt-1 border-l-2 border-ink/20 pl-2">
      {detail.files.length === 0 && <p className="text-[10px] text-muted">未找到匹配</p>}
      <ul className="space-y-1">
        {visibleFiles.map(function renderFile(file) {
          return <GrepFile key={file.path} file={file} />;
        })}
      </ul>
      {!showAllFiles && detail.files.length > FILE_PREVIEW_LIMIT && <MoreToggle label="其余" remaining={detail.files.length - FILE_PREVIEW_LIMIT} onToggle={function showRest() { setShowAllFiles(true); }} />}
      <TruncationNotices executionTruncated={detail.executionTruncated} displayTruncated={detail.displayTruncated} paginationText={paginationText} />
    </div>
  );
}

/** 单个文件的命中行分组；行号过多时先折叠，剩余数量只基于该文件真实行号计算。 */
function GrepFile({ file }: { file: { path: string; matchedLineCount: number; lineNumbers: number[] } }) {
  const [showAllLines, setShowAllLines] = useState(false);
  const visibleLines = showAllLines ? file.lineNumbers : file.lineNumbers.slice(0, LINE_NUMBER_PREVIEW_LIMIT);
  return (
    <li>
      <p className="overflow-x-auto whitespace-nowrap text-[11px] leading-5 text-ink" title={file.path}>
        {file.path} <span className="text-accent">{file.matchedLineCount} 处</span>
      </p>
      <p className="flex flex-wrap gap-x-1.5 text-[10px] leading-4 text-muted">
        行 {visibleLines.map(function renderLineNumber(line) { return <span key={line}>{line}</span>; })}
        {!showAllLines && file.lineNumbers.length > LINE_NUMBER_PREVIEW_LIMIT && <MoreToggle label="其余" remaining={file.lineNumbers.length - LINE_NUMBER_PREVIEW_LIMIT} onToggle={function showRest() { setShowAllLines(true); }} />}
      </p>
    </li>
  );
}

/** grep count 模式的每文件 submatch 计数；不伪造行号。 */
function GrepCountsDetail({ detail }: { detail: Extract<ToolDisplayDetail, { kind: "grep_counts" }> }) {
  const [showAll, setShowAll] = useState(false);
  const paginationText = getPaginationText(detail.shownFileCount, detail.totalFileCount, "个文件");
  if (detail.files.length === 0) {
    return <><p className="text-[10px] text-muted">未找到匹配</p><TruncationNotices executionTruncated={detail.executionTruncated} displayTruncated={detail.displayTruncated} paginationText={paginationText} /></>;
  }
  const visible = showAll ? detail.files : detail.files.slice(0, FILE_PREVIEW_LIMIT);
  return (
    <div className="mt-1 border-l-2 border-ink/20 pl-2">
      <ul className="space-y-0.5">
        {visible.map(function renderCount(file) {
          return (
            <li key={file.path} className="overflow-x-auto whitespace-nowrap text-[11px] leading-5 text-ink" title={file.path}>
              {file.path} <span className="text-accent">{file.count} 次命中</span>
            </li>
          );
        })}
      </ul>
      {!showAll && detail.files.length > FILE_PREVIEW_LIMIT && <MoreToggle label="其余" remaining={detail.files.length - FILE_PREVIEW_LIMIT} onToggle={function showRest() { setShowAll(true); }} />}
      <TruncationNotices executionTruncated={detail.executionTruncated} displayTruncated={detail.displayTruncated} paginationText={paginationText} />
    </div>
  );
}

/** web_search 只展示 Core 冻结的来源数量与截断事实，不接触 query、标题、摘要或 URL。 */
function WebSearchDetail({ detail }: { detail: Extract<ToolDisplayDetail, { kind: "web_search" }> }) {
  return (
    <div className="mt-1 border-l-2 border-ink/20 pl-2">
      <p className="text-[11px] leading-5 text-ink">{detail.sourceCount === 0 ? "搜索服务未返回结构化引用" : `找到 ${detail.sourceCount} 个公开来源`}</p>
      {detail.sourceCount === 0 && <p className="mt-1 text-[10px] leading-5 text-muted">回答中的链接可点击查看目标地址，再确认打开。</p>}
      {detail.truncated && <p className="mt-1 text-[10px] text-muted">结果已截断</p>}
    </div>
  );
}

/** web_fetch 只展示最终域名、内容类型与截断事实，不接触路径、query 或网页正文。 */
function WebFetchDetail({ detail }: { detail: Extract<ToolDisplayDetail, { kind: "web_fetch" }> }) {
  return (
    <div className="mt-1 border-l-2 border-ink/20 pl-2">
      <p className="overflow-x-auto whitespace-nowrap text-[11px] leading-5 text-ink" title={detail.host}>{detail.host}</p>
      <p className="mt-0.5 text-[10px] text-muted">{detail.contentType}{detail.truncated && <span className="text-accent"> · 内容已截断</span>}</p>
    </div>
  );
}

/** 只按判别 kind 路由专用结果体；未知或缺失明细时保持通用回退，不显示虚假展开入口。 */
export default function ToolDetail({ detail }: { detail?: ToolDisplayDetail }) {
  if (!detail) return null;
  if (detail.kind === "read_file") return <ReadDetail detail={detail} />;
  if (detail.kind === "glob_files") return <PathListDetail paths={detail.paths} totalCount={detail.totalCount} paginationUnit="个路径" executionTruncated={detail.executionTruncated} displayTruncated={detail.displayTruncated} />;
  if (detail.kind === "grep_content") return <GrepContentDetail detail={detail} />;
  if (detail.kind === "grep_paths") return <PathListDetail paths={detail.paths} totalCount={detail.totalCount} paginationUnit="个文件" executionTruncated={detail.executionTruncated} displayTruncated={detail.displayTruncated} />;
  if (detail.kind === "grep_counts") return <GrepCountsDetail detail={detail} />;
  if (detail.kind === "web_search") return <WebSearchDetail detail={detail} />;
  if (detail.kind === "web_fetch") return <WebFetchDetail detail={detail} />;
  return null;
}
