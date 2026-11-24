/** 当前 Run 的持久终端布局、会话定位及就地审批。 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hand, CircleHelp, LoaderCircle, Pencil, X } from "lucide-react";
import { leaves, setRatio, type ManagedWorkspaceLayout } from "./workspace";
import { closeManagedSessions, locateManagedSession, managedTabRows, managedTerminalActivity, managedTitle } from "./orchestration-layout";
import { pendingRunApprovals } from "./orchestration-interactions";
import { orchestrationError } from "./orchestration-presentation";
import { LayoutView } from "./LayoutView";
import { ManagedControllerTerminal } from "./ManagedControllerTerminal";
import { OrchestrationActions } from "./OrchestrationActions";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { notifyDesktop } from "./desktop-notifications";
import type { OrchestrationRunView, OrchestrationUiCommand } from "./orchestration-contract";

/** Hand 优先，完整待处理列表仍指出各请求的原窗格。 */
function Attention({ approval, question }: { approval: boolean; question: boolean }) {
  if (approval) return <Hand className="size-4 shrink-0 text-warning" role="img" aria-label="待审批" />;
  if (question) return <CircleHelp className="size-4 shrink-0 text-error" role="img" aria-label="待回答" />;
  return null;
}

/** 所有已打开客户端可在后台启动，只给当前页原焦点窗格键盘焦点。 */
export function OrchestrationTerminals({ run, layout, changeLayout, command, approvalRegionId, onLocateApprovals, resizing }: { run: OrchestrationRunView; layout: ManagedWorkspaceLayout; changeLayout: (update: (previous: ManagedWorkspaceLayout) => ManagedWorkspaceLayout) => void; command: (value: OrchestrationUiCommand) => Promise<boolean>; approvalRegionId: string; onLocateApprovals(): void; resizing: boolean }) {
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [splitResizing, setSplitResizing] = useState(false);
  const [closing, setClosing] = useState(false);
  const closePending = useRef(false);
  const surfaces = useRef(new Map<string, HTMLDivElement>());
  const requests = (run.interactions ?? []).filter(function actionable(i) { return i.state === "pending"; });
  const questions = requests.filter(function answering(i) { return i.kind === "question"; });
  const hasApprovals = pendingRunApprovals(run).length > 0;
  const rows = managedTabRows(run, layout);
  const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

  /** 后台加窗格移动原布局节点时恢复原 DOM 焦点，避免打断正在编辑的终端输入。 */
  function restoreFocus() {
    if (originalFocus?.isConnected && document.activeElement === document.body) originalFocus.focus({ preventScroll: true });
  }
  useLayoutEffect(restoreFocus, [layout]);

  /** 分屏只重新排列占位槽，xterm 与交互草稿保留原 React/DOM 身份。 */
  function surface(id: string): HTMLDivElement {
    let element = surfaces.current.get(id);
    if (!element) {
      element = document.createElement("div");
      element.className = "h-full min-h-0";
      surfaces.current.set(id, element);
    }
    return element;
  }

  /** 手动切换或定位交互时才把焦点移交给指定窗格。 */
  function locate(id: string) {
    changeLayout(function select(previous) { return locateManagedSession(previous, id); });
  }

  /** 关闭在宿主端撤销对应连接，成功后留下可手动重新打开的位置。 */
  async function close(ids: string[]) {
    if (closePending.current || !ids.length) return;
    closePending.current = true;
    setClosing(true);
    try {
      const res = await window.autopilotDesktop.orchestration.terminal(run.workspaceId, "closeView", run.id, ids);
      console.log(res);
      if (res === true) changeLayout(function closed(previous) { return closeManagedSessions(previous, ids); });
    } catch (error) { notifyDesktop("终端视图未关闭", error instanceof Error ? orchestrationError(error.message) : "请核查当前终端后重试。", "error"); }
    finally { closePending.current = false; setClosing(false); }
  }

  /** 手工名称覆盖宿主摘要；空名称恢复摘要。 */
  function rename(tabId: string) {
    changeLayout(function edit(previous) {
      const next = structuredClone(previous);
      const tab = next.tabs.find(function same(t) { return t.id === tabId; });
      if (tab) tab.name = name.trim() || undefined;
      return next;
    });
    setEditing(undefined);
  }

  /** 原生报告摘要优先，初次执行使用任务短句。 */
  function title(id: string) {
    return managedTitle(run, id);
  }

  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-clip">
    {layout.sessions.filter(function open(session) { return !session.closed; }).map(function terminal(session) {
      const id = session.id;
      const item = layout.tabs.find(function same(tab) { return tab.id === session.tabId; });
      if (!item) return null;
      const selected = item.id === layout.activeTab;
      const controller = id === "controller";
      const a = run.assignments.find(function same(assignment) { return assignment.id === id && assignment.terminalSessionId === session.sessionId; });
      const pending = requests.filter(function own(i) { return (i.assignmentId ?? "controller") === id; });
      const interaction = controller ? run.controllerInspection?.interaction : a?.inspection?.interaction;
      const control = controller ? { id, executionToken: run.controllerToken, inspection: run.controllerInspection, takeover: false, state: "active" } : a;
      return createPortal(<div className="flex h-full min-h-0 min-w-0 flex-col gap-1">
        {(!controller || leaves(item.layout).length > 1) && <div className="flex shrink-0 items-center gap-2 px-1 text-xs"><Attention approval={pending.some(function approve(i) { return i.kind === "approval"; })} question={pending.some(function answer(i) { return i.kind === "question"; })} /><span className="mr-auto truncate">{session.number} · {title(id)}</span><Button size="icon" variant="ghost" aria-label={`关闭终端 ${session.number}`} disabled={closing} onClick={function dismiss() { void close([id]); }}><X /></Button></div>}
        {a?.directInputs?.some(function waiting(i) { return ["escalated", "clarifying"].includes(i.state); }) && <div className="flex shrink-0 items-center gap-2 px-1 text-xs text-warning">范围变更待主控处理<Button size="sm" variant="outline" onClick={function controllerTab() { locate("controller"); }}>去主控回答</Button></div>}
        <div className="min-h-0 flex-1">{controller || a ? <ManagedControllerTerminal workspaceId={run.workspaceId} runId={run.id} assignmentId={a?.id} executorIcon={session.icon} activity={managedTerminalActivity(run, id)} number={session.number} visible={selected} focused={selected && item.focused === id} onFocus={function focus() { if (selected && item.focused !== id) locate(id); }} resizing={resizing || splitResizing} /> : <p>原会话身份待核查。</p>}</div>
        {interaction?.state === "pending" && interaction.question && pending.some(function answer(i) { return i.kind === "question" && i.requestId === interaction.question?.requestId; }) && control && <div className="max-h-[45%] shrink-0 overflow-x-hidden overflow-y-auto rounded-md border border-border p-2 text-sm"><OrchestrationActions key={interaction.question.requestId} run={run} command={command} assignment={control} controller={controller} controllerView={controller ? "question" : undefined} /></div>}
      </div>, surface(id), id);
    })}
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto" role="tablist" aria-label="受管终端">
      {layout.tabs.filter(function open(tab) { return !!tab.layout; }).map(function tab(item) {
        const selected = item.id === layout.activeTab;
        const row = rows.find(function same(tab) { return tab.id === item.id; });
        return <div key={item.id} className="flex shrink-0 items-center rounded-md border border-border">
          <Button size="sm" variant="ghost" className="aria-selected:border-selected-border aria-selected:bg-selected aria-selected:text-ink" role="tab" aria-selected={selected} onClick={function choose() { locate(item.focused); }} title={row?.title ?? title(item.id)}>
            <Attention approval={row?.status === "waiting"} question={row?.status === "answering"} /><span className="shrink-0 text-xs text-muted">{leaves(item.layout).length} 终端</span>{item.number} · {row?.title ?? title(item.id)}
          </Button>
          {editing === item.id ? <Input autoFocus value={name} maxLength={80} aria-label="标签名称" className="w-36" onChange={function change(e) { setName(e.target.value); }} onBlur={function save() { rename(item.id); }} onKeyDown={function key(e) { if (e.key === "Enter") e.currentTarget.blur(); }} />
            : <Button size="icon" variant="ghost" aria-label={`重命名标签 ${item.number}`} onClick={function edit() { setName(item.name ?? ""); setEditing(item.id); }}><Pencil /></Button>}
          <Button size="icon" variant="ghost" aria-label={`关闭标签 ${item.number}`} disabled={closing} onClick={function dismiss() { void close(leaves(item.layout)); }}><X /></Button>
        </div>;
      })}
    </div>
    {closing && <p className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-muted" role="status"><LoaderCircle aria-hidden="true" className="size-3 shrink-0 text-accent motion-safe:animate-spin" />正在核查并保存关闭记录…</p>}
    {(hasApprovals || questions.length > 0 || layout.sessions.some(function closed(s) { return s.closed; })) && <div className="flex shrink-0 flex-wrap gap-2" aria-label="终端定位">
      {hasApprovals && <Button size="sm" variant="outline" aria-controls={approvalRegionId} onClick={onLocateApprovals}>查看待审批</Button>}
      {questions.map(function request(i) { return <Button key={i.key} size="sm" variant="outline" onClick={function show() { locate(i.assignmentId ?? "controller"); }}>回答 · {i.assignmentId ? title(i.assignmentId) : "主控"}</Button>; })}
      {layout.sessions.filter(function closed(s) { return s.closed; }).map(function reopen(s) { return <Button key={s.id} size="sm" variant="ghost" onClick={function show() { locate(s.id); }}>打开终端 {s.number}</Button>; })}
    </div>}
    {layout.tabs.map(function tab(item) {
      const selected = item.id === layout.activeTab;
      return item.layout && <div key={item.id} role="tabpanel" className={selected ? "min-h-0 flex-1" : "hidden"}>
        <LayoutView fit layout={item.layout} onResizing={setSplitResizing} onRatio={function ratio(path, value) {
          changeLayout(function resize(previous) {
            const next = structuredClone(previous);
            const tab = next.tabs.find(function same(t) { return t.id === item.id; });
            if (tab) tab.layout = setRatio(tab.layout, path, value);
            return next;
          });
        }} renderPane={function pane(id) {
          return <div className="h-full min-h-0" ref={function attach(slot) {
            const element = surface(id);
            if (slot && slot.firstChild !== element) slot.replaceChildren(element);
          }} />;
        }} />
      </div>;
    })}
  </div>;
}
