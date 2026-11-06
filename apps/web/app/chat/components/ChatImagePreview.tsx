/** ChatImagePreview.tsx — 会话附件与来源图片的全屏预览弹层；纯展示组件，关闭动作由父级注入。 */
"use client";

import Image from "next/image";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

interface ChatImagePreviewProps {
  selectedImage: { url: string; alt: string } | null;
  setSelectedImage: Dispatch<SetStateAction<{ url: string; alt: string } | null>>;
  onPrevious?: () => void;
  onNext?: () => void;
  position?: string;
}

/** 渲染图片预览弹层；无选中图片时不输出任何 DOM。 */
export default function ChatImagePreview({ selectedImage, setSelectedImage, onPrevious, onNext, position }: ChatImagePreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOpen = Boolean(selectedImage);
  useEffect(function managePreviewDialog() {
    if (!isOpen || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return function restorePreviewFocus() {
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [isOpen]);
  if (!selectedImage) return null;
  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto max-h-full max-w-full bg-transparent p-6 backdrop:bg-ink/80"
      aria-modal="true"
      aria-label="图片预览"
      onCancel={function closeWithEscape(event) { event.preventDefault(); event.stopPropagation(); setSelectedImage(null); }}
      onMouseDown={function closeWithBackdrop(event) {
        if (event.target !== event.currentTarget) return;
        // 取消按下时的默认聚焦，避免遮罩关闭后焦点落到页面 body 而无法回到触发缩略图。
        event.preventDefault();
        setSelectedImage(null);
      }}
      onKeyDown={function switchWithArrow(event) {
        if (event.key === "ArrowLeft" && onPrevious) { event.preventDefault(); onPrevious(); }
        if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
        // 原生模态只把页面变惰性，Tab 越过最后一个控件仍会落到浏览器界面，需要首尾循环。
        if (event.key === "Tab") {
          const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        }
      }}
    >
      <div
        className="max-h-full max-w-5xl border-[3px] border-ink bg-card p-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-4 border-b-2 border-ink pb-2 text-xs">
          <span className="text-accent">图片预览 {position}</span>
          <button
            type="button"
            aria-label="关闭图片预览"
            onClick={() => setSelectedImage(null)}
            className="border-2 border-ink px-2 py-1 hover:bg-ink hover:text-ink-on-dark"
          >
            ×
          </button>
        </div>
        <Image src={selectedImage.url} alt={selectedImage.alt} width={1200} height={900} className="max-h-[75vh] max-w-full object-contain" />
        {onPrevious && onNext && <div className="mt-3 flex justify-center gap-2">
          <button type="button" onClick={onPrevious} aria-label="上一张图片" className="border-2 border-ink px-3 py-1 hover:bg-ink hover:text-ink-on-dark">←</button>
          <button type="button" onClick={onNext} aria-label="下一张图片" className="border-2 border-ink px-3 py-1 hover:bg-ink hover:text-ink-on-dark">→</button>
        </div>}
      </div>
    </dialog>
  );
}
