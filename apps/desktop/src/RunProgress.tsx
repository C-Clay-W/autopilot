/** 编排底部只读进度，直接消费宿主快照。 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ManagedWorkspaceLayout } from "./workspace";
import type { OrchestrationRunView } from "./orchestration-contract";
import { runStatus, displayTurnStatus, pendingMessage, receiptStatus, approvalContinuationStatus, currentApproval } from "./orchestration-presentation";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";

const outcomes: Record<string, string> = { delivered: "已交付", partial: "部分完成", failed: "执行失败", blocked: "受阻", cancelled: "已取消" };

type Assignment = OrchestrationRunView["assignments"][number];
type Session = ManagedWorkspaceLayout["sessions"][number];

/** 区分委派生命周期与真实 Turn 状态，未知执行保留待核查。 */
function assignmentStatus(run: OrchestrationRunView, a: Assignment) {
  if (a.state === "planned") return run.batches.some(function pending(b) { return b.state === "pending" && b.assignmentIds.includes(a.id); }) ? "等待派工审核" : "等待派工";
  if (a.state === "submitted") return "启动待确认";
  if (a.state === "cancelled") return "已撤销";
  if (a.state === "released") return "已释放";
  return displayTurnStatus(run, a.id);
}

/** 步骤按宿主已登记的前置关系分层，同层沿用计划内的展示顺序。 */
export function progressSteps(run: OrchestrationRunView, layout?: ManagedWorkspaceLayout) {
  const depths = new Map<string, number>();
  return run.steps.map(function project(step) {
    const depth = step.dependencies.reduce(function depthOf(max, id) { return Math.max(max, (depths.get(id) ?? 0) + 1); }, 0);
    depths.set(step.id, depth);
    const assignments = run.assignments.filter(function belongs(a) { return a.stepId === step.id; });
    const latest = assignments.at(-1);
    const session = latest?.terminalSessionId ? layout?.sessions.find(function same(s) { return s.id === latest.id && s.sessionId === latest.terminalSessionId && layout.tabs.some(function exists(tab) { return tab.id === s.tabId; }); }) : undefined;
    const waiting = step.dependencies.some(function unmet(id) { return !run.steps.find(function dependency(s) { return s.id === id; })?.accepted; });
    const running = !!latest && run.connected && latest.state === "active" && latest.native === "running" && latest.inspection?.execution !== "inactive";
    const status = step.accepted ? "已验收" : running ? "执行中" : waiting && (!latest || latest.state === "planned") ? "等待前置步骤" : latest ? assignmentStatus(run, latest) : "待派工";
    return { step, assignments, latest, session, depth, running, status };
  });
}

type ProgressStep = ReturnType<typeof progressSteps>[number];

/** 优先真实运行步骤，再取已派工或可推进的未验收步骤。 */
export function currentProgressStep(rows: ProgressStep[]) {
  return rows.find(function active(r) { return r.running; })
    ?? rows.find(function dispatched(r) { return !r.step.accepted && (r.latest?.state === "active" || r.latest?.state === "submitted"); })
    ?? rows.find(function ready(r) { return !r.step.accepted && r.status !== "等待前置步骤"; })
    ?? rows.find(function pending(r) { return !r.step.accepted; }) ?? rows.at(-1);
}

/** 时间线只改变所读步骤；终端定位必须由用户单独触发。 */
export function RunProgress({ run, rows = progressSteps(run), expanded = true, onLocate }: { run: OrchestrationRunView; rows?: ProgressStep[]; expanded?: boolean; onLocate?: (session: Session) => void }) {
  const [chosen, setChosen] = useState<string>();
  const selected = rows.find(function chosenStep(r) { return r.step.id === chosen; }) ?? currentProgressStep(rows);
  const rail = useRef<HTMLDivElement>(null);
  const selectedNode = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  /** 只滚动横栏，让默认进行项也可见，保留 CLI 和纵向正文的位置。 */
  function revealStep() {
    const strip = rail.current, node = selectedNode.current;
    if (!expanded || !strip || !node) return;
    const view = strip.getBoundingClientRect(), item = node.getBoundingClientRect();
    if (item.left < view.left) strip.scrollLeft += item.left - view.left;
    else if (item.right > view.right) strip.scrollLeft += item.right - view.right;
  }
  useLayoutEffect(revealStep, [selected?.step.id, expanded]);
  const controllerApproval = currentApproval(run.approvalContinuations, run.controllerId, run.controllerInspection);
  const layers = [...new Set(rows.map(function level(r) { return r.depth; }))].sort(function ascending(a, b) { return a - b; });
  return <section className="min-w-0 space-y-3 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]">
    <h2 className="font-semibold">{run.goal || "当前任务"} <Badge>{runStatus(run)}</Badge></h2>
    {selected && <>
      <div ref={rail} role="group" aria-label="按依赖层级选择步骤" className="flex max-w-full gap-3 overflow-x-auto overscroll-x-contain pb-2">
        {layers.map(function layer(depth) { return <div key={depth} className="shrink-0 border-l border-border pl-2">
          <p className="mb-1 text-xs text-muted">{depth ? `依赖层 ${depth}` : "无前置步骤"}</p>
          <div className="flex gap-1">{rows.filter(function same(r) { return r.depth === depth; }).map(function node(r) {
            const active = r.step.id === selected.step.id;
            return <button key={r.step.id} type="button" ref={active ? selectedNode : undefined} aria-pressed={active} aria-controls={detailId} title={r.step.goal}
              onMouseDown={function keepFocus(event) { event.preventDefault(); }} onClick={function select() { setChosen(r.step.id); }}
              className={`w-40 rounded-md border px-2.5 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${active ? "border-accent bg-accent/10" : "border-border hover:bg-muted/10"}`}>
              <span className="block truncate text-sm font-medium">{r.step.goal}</span>
              <span className="flex items-baseline gap-2 text-xs text-muted"><span className="min-w-0 truncate" title={r.status}>{r.status}</span>{r.session && <span className="ml-auto shrink-0 tabular-nums">终端 {r.session.number}</span>}</span>
            </button>;
          })}</div>
        </div>; })}
      </div>
      <section id={detailId} aria-label="所选步骤详情" className="w-full min-w-0 space-y-2 border-t border-border pt-2 whitespace-pre-wrap">
        <h3 className="font-semibold">{selected.step.goal} · {selected.status}</h3>
        {!!selected.step.dependencies.length && <p>前置步骤 · {selected.step.dependencies.map(function dependency(id) { const s = run.steps.find(function match(step) { return step.id === id; }); return (s?.goal ?? id) + (s?.accepted ? "（已验收）" : "（待验收）"); }).join("、")}</p>}
        {!!selected.step.deliverables.length && <p>交付物 · {selected.step.deliverables.join("、")}</p>}
        {selected.session && onLocate ? <Button onClick={function locate() { if (selected.session) onLocate?.(selected.session); }} className="h-auto rounded px-2 py-1 text-xs font-normal">{selected.session.closed ? "重新打开并定位终端" : "定位终端"} {selected.session.number}</Button> : <p className="text-xs text-muted">暂无可定位的终端</p>}
        {selected.assignments.map(function assignment(a) {
          const receipt = currentApproval(run.approvalContinuations, a.sessionId, a.inspection);
          const status = assignmentStatus(run, a);
          return <article key={a.id} className="space-y-1 text-xs"><p>{a.content} · {status}</p>
            {receipt && status !== approvalContinuationStatus(receipt) && <p>{approvalContinuationStatus(receipt)}</p>}
            {a.local.source === "agent" && a.local.phase && a.local.phase !== "unknown" && <p>执行者进度 · {a.local.phase}</p>}
            {run.pending.filter(function own(i) { return i.assignmentId === a.id; }).map(function pending(i) { return <p key={i.id}>{pendingMessage(i.reason)}</p>; })}
            {a.results.map(function result(r) { return <div key={r.id}><p>{outcomes[r.outcome] ?? "执行报告"} · {r.summary}</p>{r.checks.length > 0 && <p>已核查 · {r.checks.join("、")}</p>}{r.evidence?.map(function evidence(e) { return <p key={e.id}>验证 · {e.artifact} · {e.contentVersion} · {e.method} · {e.result}</p>; })}{r.unresolved.length > 0 && <p>待解决 · {r.unresolved.join("、")}</p>}</div>; })}
            {a.local.obligations.length > 0 && <p>待完成 · {a.local.obligations.join("、")}</p>}
            {a.local.cooperation.length > 0 && <p>等待协作 · {a.local.cooperation.join("、")}</p>}
            {a.controls.filter(function stopping(c) { return c.operation === "cancel" || c.operation === "stop_job"; }).map(function receipt(c) { return <p key={c.requestId}>{receiptStatus(c)}</p>; })}
          </article>;
        })}
      </section>
    </>}
    {run.finishes?.map(function finish(f) { return <div key={f.requestId}><p>{f.completed ? "收尾已确认" : "已停止新派工，正在核查执行者与后台任务"} · {f.text}</p>{f.controllerStops?.map(function receipt(c) { return <p key={c.requestId}>主控 · {receiptStatus(c)}</p>; })}{f.targets.map(function target(t) { return <p key={t.assignmentId}>{t.assignmentId} · {t.state === "cancelled" ? "已撤销" : t.state === "released" ? "已释放" : "资源待核查"}</p>; })}</div>; })}
    {controllerApproval && <p>主控 · {approvalContinuationStatus(controllerApproval)}</p>}
    {run.approvalContinuations?.filter(function prior(item) {
      if (!item.reconciliation?.stopped) return false;
      const a = run.assignments.find(function own(a) { return a.id === item.assignmentId; });
      return item.id !== (a ? currentApproval(run.approvalContinuations, a.sessionId, a.inspection) : controllerApproval)?.id;
    }).map(function blocked(item) { return <p key={item.id}>{item.assignmentId ?? "主控"} · 此前审批 · {approvalContinuationStatus(item)}</p>; })}
    {run.pending.filter(function global(i) { return !i.assignmentId; }).map(function pending(i) { return <p key={i.id}>{pendingMessage(i.reason)}</p>; })}
  </section>;
}
