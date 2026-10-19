/**
 * 直角确认浮层：用于会改变模型上下文投影的明确用户操作。
 */
import { useEffect, useRef } from "react";

interface PopconfirmProps {
  open: boolean;
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 渲染受控确认浮层，保持纸本底色、粗黑边框和单一橙色强调态。 */
export default function Popconfirm(props: PopconfirmProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(function manageConfirmFocus() {
    if (!props.open) return;
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return function restoreTrigger() { if (trigger?.isConnected) trigger.focus(); };
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div ref={panelRef} onKeyDown={function confirmKeyboard(event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
      if (event.key === "Tab") {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      }
    }} className="absolute top-full right-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] border-[3px] border-ink bg-card p-3 text-left shadow-none" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="text-sm font-semibold">{props.title}</div>
      <p className="mt-2 text-xs leading-relaxed text-muted">{props.description}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">{props.cancelText}</button>
        <button type="button" onClick={props.onConfirm} className="border-2 border-accent bg-accent px-2 py-1 text-xs font-semibold text-ink-on-dark hover:bg-ink hover:border-ink">{props.confirmText}</button>
      </div>
    </div>
  );
}
