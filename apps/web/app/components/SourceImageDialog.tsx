/** 来源大图弹窗：沿用纸本原生 dialog，复用站内预览图片并管理键盘焦点。 */
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/** 展示来源原图；关闭时恢复缩略图焦点，不影响后台任务。 */
export default function SourceImageDialog({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [failed, setFailed] = useState(false);

  /** 使用原生模态层隔离背景交互，卸载时恢复打开前的焦点。 */
  function openDialog() {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return function restoreFocus() {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }
  useEffect(openDialog, []);

  /** Esc 不传到聊天取消快捷键，Tab 留在唯一的关闭操作上。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") event.stopPropagation();
    if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
  }

  return createPortal(
    <dialog ref={dialogRef} aria-labelledby={titleId} onKeyDown={handleKeyDown} onCancel={function cancel(event) { event.preventDefault(); onClose(); }} onClick={function closeBackdrop(event) { if (event.target === event.currentTarget) onClose(); }} className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-5xl overflow-y-auto border-[3px] border-ink bg-card p-4 text-ink backdrop:bg-ink/80">
      <div className="mb-3 flex items-start justify-between gap-4">
        <h2 id={titleId} className="min-w-0 break-words text-sm font-semibold">{alt}</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭来源大图" className="shrink-0 border-2 border-ink px-3 py-1 text-sm hover:bg-ink hover:text-ink-on-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">关闭</button>
      </div>
      {failed ? <p role="status" className="py-6 text-sm text-muted">预览不可用，资源可能已删除或暂时无法读取。</p> : (
        // 直接复用已授权的站内预览，不经过额外图片代理。
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} onError={function previewFailed() { setFailed(true); }} className="mx-auto block h-auto max-h-[75vh] max-w-full object-contain" />
      )}
    </dialog>,
    document.body,
  );
}
