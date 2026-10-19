/** WorkJobs.tsx — Work Session 后台任务入口、列表与安全日志详情弹层。 */
"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JobView } from "@autopilot-agent/core";
import { createWorkJobController, type WorkJobController, type WorkJobSnapshot } from "../work-job-controller";

interface WorkJobsProps {
  workspaceId: string;
  sessionId: string;
  active: boolean;
  turnRunning: boolean;
  requestedJobId?: string;
  onRequestedJobHandled?: () => void;
}

interface WorkJobsPanelProps {
  snapshot: WorkJobSnapshot;
  onRefresh(): void;
  onLoadMore(): void;
  onOpen(jobId: string): void;
  onClose(): void;
  onStop(jobId: string): void;
}

/** 将 Job 状态投影为稳定中文，不依赖颜色表达执行结果。 */
function getStatusLabel(status: JobView["status"]): string {
  if (status === "starting") return "正在启动";
  if (status === "running") return "运行中";
  if (status === "stopping") return "正在停止";
  if (status === "completed") return "已完成";
  if (status === "failed") return "执行失败";
  if (status === "stopped") return "已停止";
  return "执行状态已中断";
}

/** 使用安全 ID 生成通用标题，不从命令、参数、路径或日志推导名称。 */
function getJobTitle(job: JobView): string {
  return `后台任务 ${job.jobId.slice(0, 8)}`;
}

/** 绘制纯视图面板，便于定向验证空态、状态文字和窄屏布局。 */
export function WorkJobsPanel({ snapshot, onRefresh, onLoadMore, onOpen, onClose, onStop }: WorkJobsPanelProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stdoutRef = useRef<HTMLPreElement>(null);
  const stderrRef = useRef<HTMLPreElement>(null);
  const activeCount = snapshot.activeCount ?? snapshot.jobs.filter(function isActive(job) { return job.status === "starting" || job.status === "running" || job.status === "stopping"; }).length;
  const totalCount = snapshot.totalCount ?? snapshot.jobs.length;
  const selectedSummary = snapshot.jobs.find(function selectedJob(job) { return job.jobId === snapshot.selectedJobId; });
  const selected = snapshot.selected?.job ?? selectedSummary;
  const open = Boolean(snapshot.selectedJobId);
  const showEntry = snapshot.jobs.length > 0 || snapshot.state === "error" || open;

  /** 弹层打开后把焦点移入并在关闭时恢复入口；入口卸载时安全忽略。 */
  useEffect(function manageDialogFocus() {
    if (!open) return;
    const trigger = triggerRef.current ?? document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return function restoreTrigger() { if (trigger?.isConnected) trigger.focus(); };
  }, [open]);

  if (!showEntry) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={function openFirstJob() {
          const first = snapshot.jobs[0];
          if (first) onOpen(first.jobId);
          else onRefresh();
        }}
        className="inline-flex shrink-0 items-center gap-1.5 border-2 border-ink bg-card px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {activeCount > 0 && <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin border-2 border-current border-t-transparent motion-reduce:animate-none" />}
        后台任务 · {activeCount} 个运行中 / 共 {totalCount} 个
      </button>
      {snapshot.terminalNotice && <span className="sr-only" role="status" aria-live="polite">{snapshot.terminalNotice}</span>}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-3 sm:p-6"
          onMouseDown={onClose}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="后台任务"
            className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden border-[3px] border-ink bg-card shadow-[4px_4px_0_var(--ink)]"
            onMouseDown={function keepDialogOpen(event) { event.stopPropagation(); }}
            onKeyDown={function handleDialogKey(event) {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
              if (event.key !== "Tab") return;
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              if (!buttons.length) return;
              if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
              if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
            }}
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b-2 border-ink px-3 py-2">
              <div><h2 className="font-bold">后台任务</h2><p className="text-[10px] text-muted">关闭窗口不会停止任务</p></div>
              <div className="flex gap-2">
                <button type="button" onClick={onRefresh} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">刷新</button>
                <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">关闭</button>
              </div>
            </header>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
              <section className="max-h-48 overflow-y-auto border-b-2 border-ink p-2 md:max-h-none md:border-r-2 md:border-b-0" aria-label="后台任务列表">
                {snapshot.state === "error" && <p role="alert" className="border-2 border-error bg-error/10 p-2 text-xs text-error">{snapshot.error}</p>}
                {snapshot.jobs.length === 0 && snapshot.state !== "error" && <p className="p-2 text-xs text-muted">没有后台任务记录</p>}
                {snapshot.jobs.map(function renderJob(job) {
                  const selectedRow = job.jobId === snapshot.selectedJobId;
                  return (
                    <button
                      key={job.jobId}
                      type="button"
                      onClick={function selectJob() { onOpen(job.jobId); }}
                      className={`mb-2 block w-full border-2 px-2 py-2 text-left text-xs ${selectedRow ? "border-ink bg-accent/15" : "border-ink bg-bg hover:bg-ink/10"}`}
                      aria-pressed={selectedRow}
                    >
                      <span className="block truncate font-semibold">{getJobTitle(job)}</span>
                      <span className={job.status === "failed" || job.status === "interrupted" ? "text-error" : "text-muted"}>{getStatusLabel(job.status)}</span>
                    </button>
                  );
                })}
                {snapshot.nextPageCursor && <button type="button" onClick={onLoadMore} className="w-full border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">加载更多</button>}
              </section>
              <section className="min-h-0 min-w-0 overflow-y-auto p-3" aria-label="后台任务详情">
                {!selected && !snapshot.detailError && <p className="text-xs text-muted">正在读取任务详情…</p>}
                {snapshot.detailError && <div role="alert" className="mb-3 border-2 border-error bg-error/10 p-2 text-xs text-error"><p>{snapshot.detailError}</p><button type="button" onClick={function retryDetail() { if (snapshot.selectedJobId) onOpen(snapshot.selectedJobId); }} className="mt-2 border-2 border-ink px-2 py-1 text-ink hover:bg-ink hover:text-ink-on-dark">重试</button></div>}
                {selected && (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-ink pb-3">
                      <div><h3 className="font-bold">{getJobTitle(selected)}</h3><p className="text-xs text-muted">{getStatusLabel(selected.status)}{selected.exitCode !== undefined ? ` · 退出码 ${selected.exitCode}` : ""} · 耗时 {Math.max(0, Math.floor(((selected.finishedAt ?? selected.updatedAt) - selected.startedAt) / 1000))} 秒</p></div>
                      {selected.canStop && <button type="button" disabled={snapshot.stoppingJobId === selected.jobId} onClick={function stopSelected() { onStop(selected.jobId); }} className="border-2 border-ink bg-accent px-3 py-1 text-xs font-semibold text-ink-on-dark hover:bg-ink disabled:cursor-not-allowed disabled:opacity-50">{snapshot.stoppingJobId === selected.jobId ? "正在停止…" : "停止任务"}</button>}
                    </div>
                    {selected.controlState === "foreign_owner" && <p className="mt-3 border-l-4 border-accent bg-accent/10 p-2 text-xs">任务由其他运行实例持有，当前仅可查看。</p>}
                    {selected.controlState === "owner_unknown" && <p className="mt-3 border-l-4 border-error bg-error/10 p-2 text-xs">任务所有权无法确认，当前不能停止。</p>}
                    {snapshot.selected?.job.outputTruncated && <p className="mt-3 text-xs text-muted">日志已按安全窗口截断，仅显示可用内容。</p>}
                    {snapshot.selected?.output.stdout.resetRequired || snapshot.selected?.output.stderr.resetRequired ? <p className="mt-3 text-xs text-muted">日志游标已重置，已切换到当前安全窗口。</p> : null}
                    {snapshot.selected?.output.stdout.gap || snapshot.selected?.output.stderr.gap ? <p className="mt-3 text-xs text-muted">较早输出不可用，日志存在缺口。</p> : null}
                    <button type="button" className="mt-2 border-2 border-ink px-2 py-1 text-xs" onClick={function scrollToLatest() { for (const element of [stdoutRef.current, stderrRef.current]) { if (element) element.scrollTop = element.scrollHeight; } }}>回到最新</button>
                    <div className="mt-3 grid min-w-0 gap-3">
                      <div><h4 className="mb-1 text-xs font-semibold">标准输出</h4><pre ref={stdoutRef} className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words border-2 border-ink bg-bg p-2 text-[11px]">{snapshot.selected?.output.stdout.text || "暂无输出"}</pre></div>
                      <div><h4 className="mb-1 text-xs font-semibold">错误输出</h4><pre ref={stderrRef} className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words border-2 border-ink bg-bg p-2 text-[11px]">{snapshot.selected?.output.stderr.text || "暂无输出"}</pre></div>
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 绑定一个 Work Session 控制器；只有当前可见实例会发起轮询。 */
export default function WorkJobs({ workspaceId, sessionId, active, turnRunning, requestedJobId, onRequestedJobHandled }: WorkJobsProps) {
  const controller = useMemo<WorkJobController>(function createController() {
    return createWorkJobController({ workspaceId, sessionId });
  }, [workspaceId, sessionId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [visible, setVisible] = useState(function initialVisibility() { return typeof document === "undefined" || document.visibilityState !== "hidden"; });

  /** 页面可见性变化只暂停/恢复读取，不影响后台 Job。 */
  useEffect(function watchVisibility() {
    function updateVisibility(): void { setVisible(document.visibilityState !== "hidden"); }
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", updateVisibility);
    return function removeVisibilityListeners() {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateVisibility);
    };
  }, []);

  /** 当前 Work、Turn 和可见性变化时校准轮询策略。 */
  useEffect(function updatePolling() {
    controller.setActive(active, turnRunning, visible);
  }, [active, controller, turnRunning, visible]);

  /** 工具结果中的安全 Job ID 只用于打开 scoped 详情，不绕过列表或 Route 归属。 */
  useEffect(function openRequestedJob() {
    if (!requestedJobId || !active) return;
    let cancelled = false;
    void controller.open(requestedJobId).then(function markRequestedJobHandled() {
      if (!cancelled && controller.getSnapshot().selectedJobId === requestedJobId) onRequestedJobHandled?.();
    });
    return function keepRequestForReplacementInstance() { cancelled = true; };
  }, [active, controller, onRequestedJobHandled, requestedJobId]);

  /** 组件身份切换或卸载时清除本实例请求与 timer。 */
  useEffect(function disposeController() {
    return function dispose() { controller.dispose(); };
  }, [controller]);

  return <WorkJobsPanel snapshot={snapshot} onRefresh={function refresh() { void controller.refresh(); }} onLoadMore={function loadMore() { void controller.loadMore(); }} onOpen={function open(jobId) { void controller.open(jobId); }} onClose={controller.close} onStop={function stop(jobId) { void controller.stop(jobId); }} />;
}
