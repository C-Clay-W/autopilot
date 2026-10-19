/**
 * SessionStatusIndicator.tsx — 会话侧栏固定 16px 状态槽的可访问状态图形。
 *
 * 图形只表达 SessionTaskManager 已冻结的安全 UI 快照；终态提醒不从历史状态推导。
 */

import type { SessionTaskPhase, SessionTaskTerminalNotice } from "../session-task-store";

interface SessionStatusIndicatorProps {
  phase: SessionTaskPhase;
  terminalNotice: SessionTaskTerminalNotice;
  isCurrent?: boolean;
}

/** 返回当前会话在侧栏中应呈现的单一主状态。 */
function getIndicatorState(phase: SessionTaskPhase, terminalNotice: SessionTaskTerminalNotice): { label: string; kind: string } {
  if (phase === "waiting_approval") return { label: "等待审批", kind: "waiting" };
  if (phase === "waiting_user_input") return { label: "等待回答", kind: "waiting" };
  if (phase === "starting" || phase === "running") return { label: "执行中", kind: "running" };
  if (terminalNotice === "success") return { label: "已完成，未查看", kind: "success" };
  if (terminalNotice === "failure") return { label: "执行失败，未查看", kind: "failure" };
  if (phase === "failed") return { label: "执行失败", kind: "failed" };
  if (phase === "limit_reached") return { label: "需要继续", kind: "interrupted" };
  if (phase === "interrupted") return { label: "已中断或取消", kind: "interrupted" };
  return { label: "空闲", kind: "idle" };
}

/** 渲染执行中的八点像素追逐环；动画在 reduced-motion 下由全局样式冻结。 */
function RunningRing() {
  return (
    <svg viewBox="0 0 16 16" className="session-status-ring h-4 w-4 text-accent" aria-hidden="true">
      <circle cx="8" cy="2" r="1.25" />
      <circle cx="12.25" cy="3.75" r="1.25" />
      <circle cx="14" cy="8" r="1.25" />
      <circle cx="12.25" cy="12.25" r="1.25" />
      <circle cx="8" cy="14" r="1.25" />
      <circle cx="3.75" cy="12.25" r="1.25" />
      <circle cx="2" cy="8" r="1.25" />
      <circle cx="3.75" cy="3.75" r="1.25" />
    </svg>
  );
}

/** 渲染会话状态槽，始终保留文字语义，不能只通过颜色传达状态。 */
export default function SessionStatusIndicator({ phase, terminalNotice, isCurrent = false }: SessionStatusIndicatorProps) {
  const state = getIndicatorState(phase, terminalNotice);

  return (
    <span className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center" data-session-status={state.kind} role="status" aria-label={state.label} title={state.label}>
      {state.kind === "running" && !isCurrent && <RunningRing />}
      {state.kind === "success" && <span aria-hidden="true" className="session-status-dot session-status-success h-2.5 w-2.5 bg-success" />}
      {state.kind === "failure" && <span aria-hidden="true" className="session-status-dot h-2.5 w-2.5 bg-error" />}
      {state.kind === "waiting" && <span aria-hidden="true" className="text-xs font-bold text-accent">?</span>}
      {state.kind === "failed" && <span aria-hidden="true" className="text-xs font-bold text-error">×</span>}
      {state.kind === "interrupted" && <span aria-hidden="true" className="text-xs font-bold text-accent">!</span>}
      <span className="sr-only">{state.label}</span>
    </span>
  );
}
