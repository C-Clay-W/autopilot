/**
 * WorkspaceTrustDialog.tsx — 工作区能力启用前的显式 Trust 确认。
 *
 * 对话框只呈现目录显示名与已冻结风险文案，绝不携带或渲染绝对路径。
 */

"use client";

import { useEffect, useRef } from "react";

interface WorkspaceTrustDialogProps {
  open: boolean;
  displayName: string;
  busy: boolean;
  onCancel(): void;
  onTrust(): void;
}

/** 渲染可通过键盘完整操作的工作区 Trust 确认卡。 */
export default function WorkspaceTrustDialog(props: WorkspaceTrustDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(function focusTrustCancelButton() {
    if (!props.open) return;
    window.requestAnimationFrame(function focusCancelButton() { cancelButtonRef.current?.focus(); });
  }, [props.open]);

  /** Escape 只关闭确认框，不写入拒绝决定或消耗 Trust challenge。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || props.busy) return;
    event.preventDefault();
    props.onCancel();
  }

  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/80 p-6" role="dialog" aria-modal="true" aria-labelledby="workspace-trust-title" onKeyDown={handleKeyDown}>
      <section className="w-full max-w-md border-[3px] border-ink bg-card p-5">
        <p className="text-[10px] uppercase tracking-widest text-accent">工作区权限</p>
        <h2 id="workspace-trust-title" className="mt-1 text-lg font-bold">访问工作区</h2>
        <p className="mt-4 border-l-4 border-accent pl-3 text-sm font-semibold">{props.displayName}</p>
        <p className="mt-4 text-sm leading-6">仅当这是你创建或信任的项目时继续。<br />Agent 将能够在此工作区内读取、编辑和执行文件。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelButtonRef} type="button" disabled={props.busy} onClick={props.onCancel} className="border-2 border-ink px-3 py-2 text-sm hover:bg-ink hover:text-ink-on-dark disabled:opacity-60">否，取消</button>
          <button type="button" disabled={props.busy} onClick={props.onTrust} className="border-2 border-accent bg-accent px-3 py-2 text-sm font-semibold text-ink-on-dark hover:border-ink hover:bg-ink disabled:opacity-60">{props.busy ? "正在确认…" : "是，我信任此工作区"}</button>
        </div>
      </section>
    </div>
  );
}
