/** 外部链接确认卡：复用纸本 Trust 对话框样式，使用原生模态行为管理焦点与 Escape。 */
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

interface ExternalLinkDialogProps {
  url: string;
  label: string;
  onClose(): void;
  /** 可选的 Work 内置打开回调：校验并打开预览面板；成功返回 undefined，失败返回固定安全文案。未传时不渲染内置入口。 */
  onOpenInPreview?: (url: string, signal: AbortSignal) => Promise<string | undefined>;
}

/** 展示真实目标域名与完整地址，用户确认后在独立标签页打开并保留聊天。 */
export default function ExternalLinkDialog({ url, label, onClose, onOpenInPreview }: ExternalLinkDialogProps) {
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  /** 作废在途内置打开：中止请求并清空控制器（幂等，迟到响应随后被忽略）。 */
  function abortPendingPreview(): void {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
  }

  useEffect(function openLinkDialog() {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return function restoreLinkFocus() {
      // 取消/Escape/新标签页/卸载共用同一收尾：先中止在途请求再卸载弹窗。
      abortPendingPreview();
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  /** 将 Tab 保留在两项决定之间，并阻止 Escape 冒泡到后台任务的取消快捷键。 */
  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key === "Escape") event.stopPropagation();
    if (event.key !== "Tab") return;
    const actions = dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href]");
    if (!actions?.length) return;
    const first = actions[0];
    const last = actions[actions.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={handleDialogKeyDown} onCancel={function cancelLink(event) { event.preventDefault(); onClose(); }} className="fixed inset-0 m-auto w-[calc(100%_-_3rem)] max-w-md border-[3px] border-ink bg-card p-5 text-ink shadow-[4px_4px_0_var(--ink)] backdrop:bg-ink/80">
      <p className="text-[10px] uppercase tracking-widest text-accent">链接预览</p>
      <h2 id={titleId} className="mt-1 text-lg font-bold">打开外部链接</h2>
      <div className="mt-4 border-2 border-ink bg-ink/5 p-3">
        <p className="break-all text-sm font-semibold text-accent">{new URL(url).host}</p>
        {label !== url && <p className="mt-2 break-words text-sm">{label}</p>}
        <p className="mt-2 max-h-32 overflow-y-auto break-all text-xs leading-5 text-muted">{url}</p>
      </div>
      <p id={descriptionId} className="mt-4 text-xs leading-6 text-muted">{onOpenInPreview ? "可在新标签页打开（当前对话保留），或在应用内置预览面板中打开。" : "将在新标签页打开，当前对话会保留。"}</p>
      {previewError && <p role="alert" className="mt-2 text-xs text-error">{previewError}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onClose} className="border-2 border-ink px-4 py-2 text-sm hover:bg-ink hover:text-ink-on-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">取消</button>
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={onClose} className="border-2 border-ink bg-accent px-4 py-2 text-sm font-semibold text-ink-on-dark transition-colors hover:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">打开网站 <span aria-hidden="true">↗</span></a>
        {onOpenInPreview && (
          <button
            type="button"
            disabled={previewPending}
            onClick={function openInPreview() {
              if (!onOpenInPreview || previewPending) return;
              abortPendingPreview();
              const controller = new AbortController();
              previewAbortRef.current = controller;
              setPreviewPending(true);
              setPreviewError(null);
              void onOpenInPreview(url, controller.signal).then(function handlePreviewResult(failure) {
                // 已取消/已离开：迟到的结果不改变面板，也不回写已卸载的弹窗。
                if (controller.signal.aborted) return;
                previewAbortRef.current = null;
                // 成功时装配层已关闭弹窗并打开侧栏；失败留在弹窗说明固定原因，保留新标签页选择。
                if (failure === undefined) onClose();
                else { setPreviewPending(false); setPreviewError(failure); }
              });
            }}
            className="border-2 border-ink px-4 py-2 text-sm font-semibold hover:bg-ink hover:text-ink-on-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewPending ? "正在打开…" : "在内置浏览器中打开"}
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
