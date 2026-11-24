// 本地 shadcn DropdownMenu 提供键盘导航、Escape 关闭和焦点返回。
import type { ComponentProps } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "./utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/** 弹层与触发器分离，避免布局栏滚动或窄窗口裁剪。 */
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn("z-50 min-w-48 rounded-md border border-border bg-raised p-1.5 text-ink shadow-lg outline-none", className)} {...props} /></DropdownMenuPrimitive.Portal>;
}

/** 菜单项使用 Radix 选取事件，鼠标与键盘共用动作。 */
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" className={cn("flex cursor-pointer select-none items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium outline-none focus:bg-hover focus:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent data-disabled:pointer-events-none data-disabled:text-muted [&_svg]:size-4", className)} {...props} />;
}

/** 分隔布局动作与新增动作，保持同一菜单密度。 */
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("my-1 h-px bg-border", className)} {...props} />;
}
