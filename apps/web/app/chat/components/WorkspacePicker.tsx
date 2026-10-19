/**
 * WorkspacePicker.tsx — 本机工作区的安全选择弹层。
 *
 * 组件只显示服务端返回的脱敏摘要；目录选择仍由 Web Host 原生 chooser 完成。
 */

"use client";

import { useEffect, useRef } from "react";
import type { WorkspaceSummary } from "../session-task-context";

interface WorkspacePickerProps {
  open: boolean;
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId: string;
  directoryPickerAvailable: boolean;
  busy: boolean;
  cancellable: boolean;
  error: string;
  onSelect(workspaceId: string): void;
  onAdd(): void;
  onCancelPicker(): void;
  onClose(): void;
}

/** 将 Trust 与可用性映射成文字，避免只靠颜色表达无法选择的原因。 */
function getWorkspaceStatus(workspace: WorkspaceSummary): string {
  if (!workspace.available) return "目录不可用";
  if (workspace.trustStatus !== "trusted") return "尚未信任";
  return "可用";
}

/** 渲染工作区主选择器，并将键盘关闭行为收敛在本组件。 */
export default function WorkspacePicker(props: WorkspacePickerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(function focusWorkspacePickerCloseButton() {
    if (!props.open) return;
    window.requestAnimationFrame(function focusCloseButton() { closeButtonRef.current?.focus(); });
  }, [props.open]);

  /** Escape 只关闭选择器，不产生目录选择或 Trust 副作用。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || (props.busy && !props.cancellable)) return;
    event.preventDefault();
    if (props.busy && props.cancellable) {
      props.onCancelPicker();
      return;
    }
    props.onClose();
  }

  if (!props.open) return null;
  const canCancelPicker = props.busy && props.cancellable;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/80 p-6 pt-24" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title" onKeyDown={handleKeyDown} onMouseDown={props.busy && !canCancelPicker ? undefined : canCancelPicker ? props.onCancelPicker : props.onClose}>
      <section className="w-full max-w-xl border-[3px] border-ink bg-card p-4" onMouseDown={function stopClose(event) { event.stopPropagation(); }}>
        <div className="flex items-center justify-between gap-3 border-b-2 border-ink pb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-accent">本机目录</p>
            <h2 id="workspace-picker-title" className="mt-1 text-lg font-bold">选择工作区</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={canCancelPicker ? props.onCancelPicker : props.onClose} disabled={props.busy && !canCancelPicker} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark disabled:opacity-60">{canCancelPicker ? "取消选择" : "关闭"}</button>
        </div>
        {props.error && <p className="mt-3 border-2 border-accent px-3 py-2 text-xs" role="status">{props.error}</p>}
        <div className="mt-3 max-h-[48vh] overflow-y-auto border-2 border-ink">
          {props.workspaces.length ? props.workspaces.map(function renderWorkspace(workspace) {
            const selected = workspace.workspaceId === props.selectedWorkspaceId;
            const selectable = workspace.available && workspace.trustStatus === "trusted";
            return <button key={workspace.workspaceId} type="button" disabled={!selectable || props.busy} onClick={function selectWorkspace() { props.onSelect(workspace.workspaceId); }} className={`flex w-full items-center justify-between gap-3 border-b-2 border-ink px-3 py-3 text-left text-sm last:border-b-0 ${selected ? "bg-ink text-ink-on-dark" : "hover:bg-ink/10"} disabled:cursor-not-allowed disabled:opacity-60`} aria-current={selected ? "true" : undefined}>
              <span className="min-w-0 truncate">▰ {workspace.displayName}</span>
              <span className="shrink-0 text-xs">{selected ? "当前" : getWorkspaceStatus(workspace)}</span>
            </button>;
          }) : <p className="px-3 py-6 text-center text-xs text-muted">尚未添加工作区。请选择本机项目目录后继续。</p>}
        </div>
        {props.directoryPickerAvailable ? <button type="button" onClick={props.onAdd} disabled={props.busy} className="mt-3 w-full border-2 border-ink px-3 py-2 text-sm font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-wait disabled:opacity-60">
          {props.busy ? "正在打开目录选择…" : "+ 添加工作区"}
        </button> : <p className="mt-3 border-2 border-ink px-3 py-2 text-xs text-muted">当前 Host 不支持本机目录选择，仅可使用已登记工作区。</p>}
      </section>
    </div>
  );
}
