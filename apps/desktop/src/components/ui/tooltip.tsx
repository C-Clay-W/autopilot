// 本地 shadcn Tooltip 统一图标动作的提示、读屏标签和焦点交互。
import type { ComponentProps } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Button } from "./button";
import { cn } from "./utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/** 提示框由 Portal 定位，沿用暗色表面与可读次级文字。 */
export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} className={cn("z-50 max-w-64 rounded-md border border-border bg-raised px-3 py-2 text-xs font-medium text-ink shadow-lg", className)} {...props} /></TooltipPrimitive.Portal>;
}

/** 重复图标动作共用相同按钮和提示，显式名称始终提供给读屏。 */
export function TooltipButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={label} {...props}>{children}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
