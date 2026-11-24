// 右键定位复用本地 Radix 菜单，沿用方向键、Escape 和焦点返回行为。
import { useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "./dropdown-menu";

/** 包裹卡片并将鼠标或键盘菜单请求定位到同一 Radix 弹层。 */
export function ContextMenu({ children, label, items }: { children: ReactNode; label: string; items: ReactNode }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  return <DropdownMenu open={Boolean(position)} onOpenChange={function open(value) { if (!value) setPosition(null); }}>
    <div ref={container} tabIndex={0} role="group" aria-label={label} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onContextMenu={function menu(event) { event.preventDefault(); setPosition({ x: event.clientX, y: event.clientY }); }}
      onKeyDown={function menuKey(event) {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition({ x: rect.left, y: rect.bottom });
      }}>{children}</div>
    <DropdownMenuTrigger asChild><button tabIndex={-1} aria-hidden="true" className="pointer-events-none fixed size-px opacity-0" style={{ left: position?.x ?? 0, top: position?.y ?? 0 }} /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" onCloseAutoFocus={function restoreFocus(event) { event.preventDefault(); const target = container.current?.querySelector("input") ?? container.current; target?.focus(); }}>{items}</DropdownMenuContent>
  </DropdownMenu>;
}
