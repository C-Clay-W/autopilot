/**
 * Diff 侧边栏面板：把共享 Presentation 的安全 edit diff 事实呈现为按 Turn 分区的文件修改视图。
 * 数据由 diff-sidebar-model 派生，行级渲染与统计复用 ToolCard 导出，不读取 raw 工具输出。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentPresentationItem } from "@autopilot-agent/presentation";
import { selectDiffSections, type DiffFileEntry } from "./diff-sidebar-model";
import { useNotice } from "./Notice";
import { DiffStatsLabel, getDiffLineClass } from "./ToolCard";

interface DiffSidebarProps {
  /** 面板开关状态由 chat-page-content 持有；关闭时不渲染任何 DOM。 */
  open: boolean;
  onClose: () => void;
  /** 桌面端面板宽度（px），由 chat-page-content 持有并经分隔条拖动调整；窄屏 overlay 不消费该值。 */
  width: number;
  /** 共享 Presentation 的安全展示事实（只读消费）。 */
  items: AgentPresentationItem[];
  /** 在途 Turn 的 id；存在时作为"本轮"范围，否则回退到最后一个含 diff 的 Turn。 */
  activeTurnId?: string;
}

/** 解析"本轮"范围：在途 Turn 优先，否则取最后一个携带安全 diff 文本的 Turn（Plan 第七节 UI 行为契约）。 */
function resolveLatestTurnId(items: AgentPresentationItem[], activeTurnId: string | undefined): string | undefined {
  if (activeTurnId) return activeTurnId;
  let latest: string | undefined;
  for (const item of items) {
    if (item.kind === "tool_call" && item.state === "completed" && item.diff?.text) latest = item.turnId;
  }
  return latest;
}

/** 渲染侧边栏面板：头部（标题/总统计/范围切换/一键展开收起/关闭）+ Turn 分区 + 可折叠文件行 + 空态。 */
export default function DiffSidebar({ open, onClose, width, items, activeTurnId }: DiffSidebarProps) {
  const [scope, setScope] = useState<"turn" | "all">("turn");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [copyStatus, setCopyStatus] = useState<{ key: string; ok: boolean } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const notice = useNotice();

  const latestTurnId = useMemo(function resolveLatest() {
    return resolveLatestTurnId(items, activeTurnId);
  }, [items, activeTurnId]);
  const sections = useMemo(function deriveSections() {
    return selectDiffSections(items, scope, latestTurnId);
  }, [items, scope, latestTurnId]);

  /** 面板打开时把焦点交给头部，键盘用户无需 Tab 穿越整页。 */
  useEffect(function focusHeaderOnOpen() {
    if (!open) return;
    headerRef.current?.focus();
  }, [open]);

  /** Esc 关闭面板；监听独立于移动侧栏，避免双 overlay 抢占（Plan 风险表缓解项）。 */
  useEffect(function bindEscapeToClose() {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return function unbindEscape() {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  /** 复制文件完整相对路径（D4）；通知统一走全局 Notice，按钮同步短暂文字反馈，成功失败均不静默。 */
  async function handleCopyPath(entry: DiffFileEntry): Promise<void> {
    let ok = false;
    try {
      if (!navigator.clipboard) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(entry.filePath);
      ok = true;
    } catch {
      ok = false;
    }
    setCopyStatus({ key: entry.key, ok });
    if (ok) {
      notice.success("文件路径已复制");
    } else {
      notice.error("复制失败，请检查浏览器剪贴板权限");
    }
    window.setTimeout(function clearCopyStatus() {
      setCopyStatus((current) => (current?.key === entry.key ? null : current));
    }, 1600);
  }

  /** 切换单个文件行折叠；缺失 key 视为展开（新文件行默认展开）。 */
  function toggleFile(key: string): void {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  }

  /** 一键展开/收起：一次性写入当前范围全部文件行 key。 */
  function setAllCollapsed(value: boolean): void {
    const next: Record<string, boolean> = {};
    for (const section of sections) {
      for (const file of section.files) next[file.key] = value;
    }
    setCollapsed(next);
  }

  if (!open) return null;

  const totals = sections.reduce(function sumTotals(acc, section) {
    return { added: acc.added + section.added, removed: acc.removed + section.removed };
  }, { added: 0, removed: 0 });

  return (
    <aside id="diff-sidebar" aria-label="Diff 侧边栏" style={{ "--diff-sidebar-width": `${width}px` } as CSSProperties} className="fixed inset-0 z-40 flex flex-col bg-bg md:static md:z-auto md:h-full md:w-[var(--diff-sidebar-width,400px)] md:shrink-0 md:border-l-2 md:border-ink">
      <div ref={headerRef} tabIndex={-1} className="border-b-2 border-ink px-4 py-3 focus:outline-none">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-accent">Review</p>
            <h2 className="mt-1 text-sm font-bold text-ink">文件修改</h2>
          </div>
          <div className="flex items-center gap-2">
            {sections.length > 0 && <span className="text-xs"><DiffStatsLabel statistics={totals} /></span>}
            <button type="button" onClick={onClose} aria-label="关闭 Diff 侧边栏" className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">关闭</button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <select aria-label="Diff 范围" value={scope} onChange={(event) => setScope(event.target.value === "all" ? "all" : "turn")} className="border-2 border-ink bg-bg px-1 py-0.5 text-xs text-ink">
            <option value="turn">本轮</option>
            <option value="all">全部</option>
          </select>
          {sections.length > 0 && (
            <>
              <button type="button" onClick={() => setAllCollapsed(false)} className="border-2 border-ink px-2 py-0.5 text-xs hover:bg-ink hover:text-ink-on-dark">全部展开</button>
              <button type="button" onClick={() => setAllCollapsed(true)} className="border-2 border-ink px-2 py-0.5 text-xs hover:bg-ink hover:text-ink-on-dark">全部收起</button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {sections.length === 0 ? (
          <p className="text-xs text-muted">暂无文件编辑记录。</p>
        ) : (
          sections.map(function renderSection(section, sectionIndex) {
            return (
              <section key={section.turnId} className={sectionIndex > 0 ? "mt-4 border-t-2 border-ink pt-3" : undefined}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[10px] font-semibold tracking-widest text-muted">{scope === "turn" ? "本轮" : `第 ${sectionIndex + 1} 轮`}</h3>
                  <span className="text-[10px]"><DiffStatsLabel statistics={section} /></span>
                </div>
                <ul className="mt-1 space-y-2">
                  {section.files.map(function renderFileRow(file, fileIndex) {
                    const isCollapsed = Boolean(collapsed[file.key]);
                    const bodyId = `diff-file-body-${sectionIndex}-${fileIndex}`;
                    return (
                      <li key={file.key} className="border-2 border-ink bg-card">
                        <div className="flex items-center gap-1 px-2 py-1.5">
                          <button type="button" onClick={() => toggleFile(file.key)} aria-expanded={!isCollapsed} aria-controls={bodyId} title={file.filePath} className="min-w-0 flex-1 text-left hover:bg-ink/10">
                            <span className="mr-1 text-muted" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                            <span className="break-all text-xs text-ink">{file.filePath}</span>
                          </button>
                          <span className="shrink-0 text-[10px]"><DiffStatsLabel statistics={file} /></span>
                          <button type="button" onClick={() => void handleCopyPath(file)} aria-label="复制文件路径" title="复制文件路径" className="shrink-0 border-2 border-ink px-1 py-0.5 text-[10px] hover:bg-ink hover:text-ink-on-dark">
                            {copyStatus?.key === file.key ? (copyStatus.ok ? "已复制" : "复制失败") : "复制"}
                          </button>
                        </div>
                        {!isCollapsed && (
                          <div id={bodyId} className="border-t-2 border-ink bg-bg p-2">
                            {file.truncated && <p className="mb-1 text-[10px] text-muted">已截断</p>}
                            <pre className="overflow-x-auto text-[11px] leading-5"><code>{file.diffText.split("\n").map(function renderDiffLine(line, index) {
                              return <span key={`${index}-${line}`} className={getDiffLineClass(line)}>{line || " "}</span>;
                            })}</code></pre>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
