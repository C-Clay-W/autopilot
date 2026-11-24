/** 编排工作区只保留唯一可控制的完整AP CLI；历史选择与人类交互各有入口，底部只读展示实际进度。 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { pendingRunApprovals } from "./orchestration-interactions";
import { LayoutDivider } from "./LayoutView";
import { runStatus, displayTurnStatus } from "./orchestration-presentation";
import { RunApprovals } from "./OrchestrationActions";
import { ManagedControllerTerminal, ManagedTerminalStatus } from "./ManagedControllerTerminal";
import { OrchestrationTerminals } from "./OrchestrationTerminals";
import type { ManagedWorkspaceLayout } from "./workspace";
import type { OrchestrationRunView, OrchestrationUiCommand } from "./orchestration-contract";
import { Button } from "./components/ui/button";
import { locateManagedSession } from "./orchestration-layout";
import { RunProgress, currentProgressStep, progressSteps } from "./RunProgress";
import { DesktopConfirmation } from "./components/ui/notifications";

type TaskSelection = Extract<OrchestrationUiCommand, { type: "newTask" | "selectRun" }>;

/** 扩员确认沿用工作台确认浮层，提交完整展示清单对应的当前 Run、版本和摘要。 */
export function OrchestrationBatchConfirmation({ run, batch, command }: { run: OrchestrationRunView; batch: OrchestrationRunView["batches"][number]; command: (value: OrchestrationUiCommand) => Promise<boolean> }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  /** 同一弹窗只提交一次决定，拒绝或关闭只取消这一批。 */
  async function decide(approve: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await command({ type: "batch", workspaceId: run.workspaceId, runId: run.id, revision: run.revision, planVersion: batch.planVersion, digest: batch.digest, approve }); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const purposes = { initial: "初次委派", repair: "返工", reassign: "重新委派" };
  return <DesktopConfirmation group="confirmation" lifecycle="user" id={`batch:${run.id}:${batch.planVersion}:${batch.digest}`} title={`确认 ${batch.tasks.length} 个执行者的派工计划`} busy={busy} onDismiss={function cancel() { void decide(false); }} content={<>
    <p className="text-sm text-muted">{run.goal || "当前任务"} · 计划 v{batch.planVersion} · 最多同时运行 {batch.maxConcurrent} 个执行者 · 同一目录按租约串行</p>
    <ul className="mt-3 max-h-72 space-y-3 overflow-auto pr-1 text-sm">
      <li className="whitespace-pre-wrap break-words">{batch.reason ? `拆分理由 · ${batch.reason}` : "主控未单列拆分理由。"}</li>
      {batch.tasks.map(function task(item) { return <li key={item.id} className="space-y-1 break-words rounded-md border border-border p-2">
        <p className="font-semibold">{item.id} · Step {item.stepId} · {item.stepGoal}</p>
        <p className="whitespace-pre-wrap">{item.content}</p>
        <p>任务范围与安排 · {item.scope || "计划未单列任务范围"} · {purposes[item.purpose]}</p>
        <p>先完成 · {item.dependencies.join("、") || "无前置 Step"}</p>
        <p>交付物 · {item.deliverables.join("、") || "未指定文件交付物"}</p>
        <p>目标目录 · {item.checkout} · {item.access === "write" ? "申请读写" : "申请只读"}</p>
      </li>; })}
    </ul>
    <div className="mt-4 flex justify-end gap-2">
      <Button autoFocus variant="outline" disabled={busy} onClick={function cancel() { void decide(false); }}>取消派工</Button>
      <Button disabled={busy} onClick={function approve() { void decide(true); }}>确认整批派工</Button>
    </div>
  </>} />;
}
/** CLI持续承载目标、追加、审批和恢复，原Run进度可展开核对。 */
export function OrchestrationPanel({ workspaceId, run, runs = [], command, layout, changeLayout, browserResizing = false }: { workspaceId?: string; run?: OrchestrationRunView; runs?: OrchestrationRunView[]; command: (command: OrchestrationUiCommand) => Promise<boolean>; layout?: ManagedWorkspaceLayout; changeLayout: (run: OrchestrationRunView, update: (previous: ManagedWorkspaceLayout) => ManagedWorkspaceLayout) => void; browserResizing?: boolean }) {
  const [ratio, setRatio] = useState(0.65);
  const [resizing, setResizing] = useState(false);
  const [selection, setSelection] = useState<{ target: TaskSelection; phase: "switching" | "applied" | "failed" }>();
  const selecting = useRef(false);
  const approvalRegionId = useId();
  const transition = selection && (selection.phase === "switching" || (selection.target.type === "newTask" ? run?.id === selection.target.runId : run?.id !== selection.target.runId)) ? selection : undefined;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const terminalPane = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const seen = useRef({ runId: run?.id, approvals: new Set<string>() });
  const reveal = useRef<string | undefined>(undefined);
  const steps = run && !transition ? progressSteps(run, layout) : [];
  const currentStep = currentProgressStep(steps);
  /** 只定位本 Run 仍匹配的终端；已关闭的位置由明确的重开按钮恢复。 */
  function locateStepTerminal(session: ManagedWorkspaceLayout["sessions"][number]) {
    if (!run || transition) return;
    changeLayout(run, function locate(previous) {
      const target = previous.sessions.find(function same(s) { return s.id === session.id && s.sessionId === session.sessionId && s.number === session.number; });
      if (!target || target.closed && !session.closed) return previous;
      return locateManagedSession(previous, target.id);
    });
  }
  const approvalKeys = JSON.stringify(run && !transition ? pendingRunApprovals(run).map(function key(item) { return item.key; }) : []);

  /** 进入另一 Run 重新判断其当前卡片；同一 Run 的轮询和短暂失联不会重复展开旧卡。 */
  function observeApprovals() {
    const changedRun = seen.current.runId !== run?.id;
    if (changedRun) seen.current = { runId: run?.id, approvals: new Set() };
    const keys: string[] = JSON.parse(approvalKeys);
    const firstNew = keys.find(function unseen(key) { return !seen.current.approvals.has(key); });
    for (const key of keys) seen.current.approvals.add(key);
    if (firstNew) { reveal.current = approvalRegionId + firstNew; setExpanded(true); }
    else if (changedRun) { reveal.current = undefined; setExpanded(false); }
  }
  useLayoutEffect(observeApprovals, [run?.id, approvalKeys, approvalRegionId]);

  /** 只调整下方容器的滚动位置，新卡自动出现时保留 CLI 的键盘焦点。 */
  function revealApproval() {
    if (!expanded || !reveal.current || !details.current) return;
    const card = document.getElementById(reveal.current);
    if (card) details.current.scrollTop += card.getBoundingClientRect().top - details.current.getBoundingClientRect().top;
    reveal.current = undefined;
  }
  useLayoutEffect(revealApproval, [expanded, approvalKeys, run?.id]);
  /** 开始新任务和历史选择都立即收起旧 PTY，等新目标投影后附着。 */
  async function switchTask(target: TaskSelection) {
    if (selecting.current) return;
    selecting.current = true;
    setSelection({ target, phase: "switching" });
    try {
      const selected = await command(target);
      setSelection({ target, phase: selected ? "applied" : "failed" });
    } catch { setSelection({ target, phase: "failed" }); }
    finally { selecting.current = false; }
  }
  /** 拖动只预览本地分屏比例，松手沿用原尺寸提交。 */
  function previewRatio(value: number) { terminalPane.current?.style.setProperty("--pane-basis", value * 100 + "%"); }
  /** 比例变化才同步 CSS，普通轮询不干扰拖动中的预览。 */
  function syncRatio() { previewRatio(ratio); }
  useLayoutEffect(syncRatio, [ratio, expanded]);
  /** 主动定位审批时先展开，再将焦点移入同一图形审批区。 */
  function locateApprovals() {
    setExpanded(true);
    requestAnimationFrame(function focusRegion() {
      const region = document.getElementById(approvalRegionId);
      if (details.current) details.current.scrollTop = 0;
      region?.focus({ preventScroll: true });
    });
  }
  /** 上下区域保持稳定DOM；下方展开只滚动详情，不参与终端高度分配。 */
  function renderTerminal() {
    if (transition) return <ManagedTerminalStatus message={transition.phase === "failed" ? "主控终端切换失败。" : "正在切换主控终端…"} retry={transition.phase === "failed" ? function retry() { void switchTask(transition.target); } : undefined} />;
    if (run && layout) return <OrchestrationTerminals key={run.id} run={run} layout={layout} changeLayout={function update(edit) { changeLayout(run, edit); }} command={command} approvalRegionId={approvalRegionId} onLocateApprovals={locateApprovals} resizing={resizing || browserResizing} />;
    return workspaceId ? <ManagedControllerTerminal key={workspaceId} workspaceId={workspaceId} resizing={resizing || browserResizing} /> : <p>请先选择工作区。</p>;
  }
  return <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
    {workspaceId && <div className="flex shrink-0 items-center gap-2">
      <Button size="sm" disabled={!!transition} onClick={function newTask() { void switchTask({ type: "newTask", workspaceId, runId: run?.id }); }}>开始新任务</Button>
      {runs.length > 0 && <select aria-label="当前任务历史" aria-busy={!!transition && transition.phase !== "failed"} disabled={!!transition && transition.phase !== "failed"} className="min-w-0 max-w-96 rounded-md border border-border bg-surface p-2 text-sm" value={transition?.target.runId ?? run?.id ?? ""} onChange={function select(event) { void switchTask({ type: "selectRun", workspaceId, runId: event.target.value }); }}>{runs.map(function option(r) { return <option key={r.id} value={r.id}>{r.goal || "新任务"} · {runStatus(r)}</option>; })}</select>}
    </div>}
    {workspaceId && !run && <p className="shrink-0 text-xs text-muted">等待目标 · 连接状态由主控 CLI 显示</p>}
    {run && <p className="shrink-0 text-xs text-muted">连接：{run.connected ? "已连接" : "未连接 / 待核查"} · 业务：{run.accepted ? "已验收" : "未验收"} · 状态：{runStatus(run)} · 主控 Turn：{displayTurnStatus(run)} · 主控 Job：{run.controllerJobs === "active" ? "仍活动" : run.controllerJobs === "inactive" ? "无活动" : "待核查"}</p>}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={terminalPane} className={expanded ? "min-h-0 shrink-0 basis-(--pane-basis) overflow-hidden" : "min-h-0 flex-1 overflow-hidden"}>{renderTerminal()}</div>
      {expanded ? <LayoutDivider row={false} ratio={ratio} label="调整任务进度区高度" onPreview={previewRatio} onRatio={setRatio} onResizing={setResizing} /> : <div className="h-px shrink-0 bg-divider" />}
      <button type="button" aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded ? "收起任务进度" : "展开任务进度"} onClick={function toggle() { setExpanded(!expanded); }}
        className="flex w-full shrink-0 items-center gap-3 rounded-sm px-2 py-1 text-left text-xs text-muted hover:bg-muted/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <span className="shrink-0 font-medium text-ink">任务进度</span>
        {currentStep && <><span className="min-w-0 truncate" title={currentStep.step.goal}>{currentStep.step.goal}</span><span className="min-w-0 truncate">{currentStep.status}</span>{currentStep.session && <span className="shrink-0 tabular-nums">终端 {currentStep.session.number}</span>}</>}
        {expanded ? <ChevronDown className="ml-auto shrink-0" size={14} /> : <ChevronUp className="ml-auto shrink-0" size={14} />}
      </button>
      <div ref={details} id={detailsId} hidden={!expanded} aria-label="任务详情滚动区" className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pt-2">
        {run && !transition && <RunApprovals key={run.id} run={run} id={approvalRegionId} command={command} />}
        {run && !transition && <RunProgress key={"progress:" + run.id} run={run} rows={steps} expanded={expanded} onLocate={locateStepTerminal} />}
      </div>
    </div>

  </div>;
}
