/**
 * Agent 授权确认卡片：只展示 Core 冻结的安全事实和允许决定范围。
 */
"use client";

import { useRef, type KeyboardEvent } from "react";
import type { ApprovalItem } from "@autopilot-agent/presentation";

interface ApprovalCardProps {
  approval: ApprovalItem;
  disabled?: boolean;
  onDecision: (decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") => void;
}

/** 将冻结决定映射为稳定按钮文案；run_command 的工作区级授权展示为"记住此命令"，todo_write 的单次批准展示为任务文件集合批准（外部集合单独文案）。 */
function getDecisionLabel(decision: "allow_once" | "allow_session" | "allow_workspace" | "deny", toolName: string, constraint: string | undefined): string {
  if (decision === "allow_once") {
    if (toolName !== "todo_write") return "仅此次";
    return constraint === "task-ext-files:v1" ? "批准本任务外部文件修改" : "批准本任务文件修改";
  }
  if (decision === "allow_session") return "本会话允许";
  if (decision === "allow_workspace") return toolName === "run_command" ? "记住此命令" : "本工作区允许";
  return "拒绝";
}

/** 将 Tab 焦点限制在当前待确认的审批决定中，避免键盘用户意外跳出关键操作。 */
function trapApprovalFocus(event: KeyboardEvent<HTMLDivElement>, container: HTMLDivElement | null): void {
  if (event.key !== "Tab" || !container) return;
  const actions = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  if (!actions.length) return;
  const firstAction = actions[0];
  const lastAction = actions[actions.length - 1];
  if (event.shiftKey && document.activeElement === firstAction) {
    event.preventDefault();
    lastAction.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === lastAction) {
    event.preventDefault();
    firstAction.focus();
  }
}

/** 渲染单个待处理审批，旧记录缺少展示事实时只允许拒绝。 */
export default function ApprovalCard({ approval, disabled = false, onDecision }: ApprovalCardProps) {
  const display = approval.display;
  const allowedDecisions = display?.allowedDecisions ?? ["deny"];
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} id={`approval-${approval.approvalId}`} role="dialog" aria-labelledby={`approval-title-${approval.approvalId}`} aria-describedby={`approval-detail-${approval.approvalId}`} onKeyDown={function handleApprovalKeyDown(event) { trapApprovalFocus(event, containerRef.current); }} className="mt-3 border-[3px] border-approval-deep bg-approval-soft p-4 text-xs">
      <div id={`approval-title-${approval.approvalId}`} className="mb-3 inline-flex border-2 border-approval-deep bg-approval-deep px-2 py-1 text-[10px] font-bold tracking-wider text-ink-on-dark">授权确认</div>
      <p id={`approval-detail-${approval.approvalId}`}>需要确认 {display?.operation ?? approval.toolName}{display?.resource ? ` · ${display.resource}` : ""}</p>
      {display?.cwd && <p className="mt-1 text-muted">工作目录：{display.cwd}</p>}
      {display?.effect === "external" && display?.hostExecution === true && <p className="mt-1 border-2 border-approval-deep px-2 py-1 text-[10px]">外部路径影响：命令声明了工作区外目标，但宿主进程不受该文件范围约束，可能同时影响其他文件；批准不构成精确范围保证。</p>}
      {display?.effect === "external" && display?.hostExecution !== true && display?.unknownScope && <p className="mt-1 border-2 border-approval-deep px-2 py-1 text-[10px]">修改范围无法精确限定：该命令未声明精确外部目标，请审查完整命令后再决定。</p>}
      {display?.effect === "external" && display?.hostExecution !== true && !display?.unknownScope && <p className="mt-1 border-2 border-approval-deep px-2 py-1 text-[10px]">外部路径修改：目标位于工作区之外，授权仅覆盖上方列出的精确目标。</p>}
      {display?.effect === "external" && approval.toolName !== "run_command" && allowedDecisions.includes("allow_workspace") && <p className="mt-1 text-muted">选择“本工作区允许”会把该规则写入工作区 .autopilot/settings.local.json。</p>}
      {approval.toolName === "run_command" && allowedDecisions.includes("allow_workspace") && <p className="mt-1 text-muted">选择“记住此命令”会记住本条命令（程序、参数与工作目录完全一致），此后在本工作区自动放行；参数或目录不同的命令仍会重新询问。</p>}
      {approval.constraint === "no-sandbox-exec:v1" && <p className="mt-1 text-error">沙箱启动失败：本次将无沙箱隔离直接执行上述命令；批准仅对本次调用有效，拒绝则任务停止。</p>}
      {display?.hostExecution === true && <p className="mt-1 text-error">Windows 宿主执行：本次命令将在当前用户权限下直接运行，未启用沙箱隔离；批准仅对本次调用有效，拒绝则不执行。</p>}
      {approval.constraint === "task-ext-files:v1" && <p className="mt-1 border-2 border-approval-deep px-2 py-1 text-[10px]">外部路径修改：目标位于工作区之外，与工作区文件集合分开单独批准；授权仅覆盖清单内精确文件，不包含父目录或递归权限。</p>}
      {approval.toolName === "todo_write" && approval.constraint !== "task-ext-files:v1" && allowedDecisions.includes("allow_once") && <p className="mt-1 text-muted">批准后，本任务内对上方清单内文件的对应修改将自动放行；清单外的新文件仍会逐次询问；授权仅覆盖当前任务，不清空也不影响其他任务。</p>}
      {approval.constraint === "task-ext-files:v1" && allowedDecisions.includes("allow_once") && <p className="mt-1 text-muted">批准后，本任务内对清单内精确文件的对应修改将自动放行；清单外目标仍逐次询问；授权仅覆盖当前任务，新目录或新文件不会因此获得授权。</p>}
      {display?.actionPreview && <p className="mt-1 text-muted">{display.actionPreview}</p>}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {allowedDecisions.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={disabled}
            onClick={() => onDecision(decision)}
            className={decision === "deny" ? "border-2 border-ink bg-card px-2 py-1 text-ink hover:bg-accent hover:text-ink-on-dark disabled:bg-muted disabled:text-ink-on-dark" : "border-2 border-approval-deep bg-approval-deep px-2 py-1 text-ink-on-dark hover:bg-ink disabled:bg-muted"}
          >
            {getDecisionLabel(decision, approval.toolName, approval.constraint)}
          </button>
        ))}
      </div>
    </div>
  );
}
