/** 编排主控使用现有 xterm 组件承载真实 AP CLI；隐藏和卸载都不终止受管 Run。 */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { TerminalPane, type ManagedTerminalActivity } from "./TerminalPane";
import type { ManagedExecutorIcon, Pane } from "./workspace";
import type { TerminalOutput } from "./contract";
import { Button } from "./components/ui/button";
/** 工作区固定绑定终端，重复进入附着同一 PTY；客户端退出后可安全重开。 */
export function ManagedControllerTerminal({ workspaceId, runId, assignmentId, executorIcon, activity, number = 1, resizing = false, visible = true, focused = true, onFocus }: { workspaceId: string; runId?: string; assignmentId?: string; executorIcon?: ManagedExecutorIcon; activity?: ManagedTerminalActivity; number?: number; resizing?: boolean; visible?: boolean; focused?: boolean; onFocus?: () => void }) {
  const [pane, setPane] = useState<Pane>();
  const [attachment, setAttachment] = useState(0);
  const [error, setError] = useState("");
  const attempt = useRef(0);
  /** 拉起的只有客户端；目标、Trust 与追加指令在主控 CLI 内完成。 */
  async function ensure() {
    const current = ++attempt.current;
    setError(""); setPane(undefined);
    try {
      const bridge = window.autopilotDesktop.orchestration;
      const result = await bridge.terminal(workspaceId, "ensure", runId, assignmentId) as Pane;
      if (current !== attempt.current) return;
      await bridge.terminal(workspaceId, "waitReady", result.generation, undefined, undefined, result.id);
      if (current !== attempt.current) return;
      setPane(result); setAttachment(current);
    } catch { if (current === attempt.current) setError(assignmentId ? "执行者终端连接待核查。" : "主控终端连接失败。"); }
  }
  useEffect(function attach() {
    void ensure();
    return function invalidate() { attempt.current++; };
  }, [workspaceId, runId, assignmentId]);
  const io = {
    /** 复用宿主有界输出游标。 */
    async readTerminal(id: string, generation: number, after: number) { return await window.autopilotDesktop.orchestration.terminal(workspaceId, "read", generation, after, undefined, id) as TerminalOutput; },
    /** 原始按键只交给已经绑定的真实 PTY。 */
    async writeTerminal(id: string, generation: number, data: string) { await window.autopilotDesktop.orchestration.terminal(workspaceId, "write", generation, data, undefined, id); },
    /** 完整 AP TUI 沿原 PTY 调整网格。 */
    async resizeTerminal(id: string, generation: number, cols: number, rows: number) { await window.autopilotDesktop.orchestration.terminal(workspaceId, "resize", generation, cols, rows, id); },
    /** 与普通AP共用预排版/OSC确认，避免ConPTY缩窄时重排旧宽帧。 */
    async prepareTerminalResize(id: string, generation: number, cols: number, rows: number) { return await window.autopilotDesktop.orchestration.terminal(workspaceId, "prepareResize", generation, cols, rows, id) as string | null; },
  };
  return pane ? <div className="h-full min-h-0 overflow-hidden rounded-lg border border-border"><TerminalPane key={attachment} pane={{ ...pane, number }} io={io} managedRole={assignmentId ? "执行者" : "主控"} executorIcon={executorIcon} managedActivity={activity} visible={visible} focused={focused} highlighted={false} resizing={resizing} expanded={false} onFocus={onFocus ?? function focus() {}} onClose={function keep() {}} onExpand={function keep() {}} onRetry={ensure} /></div>
    : <ManagedTerminalStatus message={error || (assignmentId ? "正在连接执行者终端…" : "正在连接主控终端…")} retry={error ? ensure : undefined} />;
}

/** 沿用桌面的加载图标和按钮，在终端原位替换退出回顾及切换空窗。 */
export function ManagedTerminalStatus({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="flex h-full min-h-0 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm text-muted">
    <div className="flex flex-wrap items-center justify-center gap-3">
      {!retry && <LoaderCircle aria-hidden="true" className="size-4 shrink-0 text-accent motion-safe:animate-spin" />}
      <span role={retry ? "alert" : "status"}>{message}</span>
      {retry && <Button size="sm" variant="outline" onClick={retry}>重试</Button>}
    </div>
  </div>;
}
