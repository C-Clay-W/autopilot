// 本地 shadcn Select 使用 Radix 的选择、方向键和弹层定位，统一 Desktop 暗色主题。
import type { ComponentProps } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "./utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

/** 选择触发器复用统一控件高度、边界与焦点。 */
export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-9 min-w-40 items-center justify-between gap-3 rounded-md border border-input-border bg-surface px-3 text-sm font-medium outline-none hover:border-muted/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-muted [&>span]:truncate", className)} {...props}>{children}<SelectPrimitive.Icon asChild><ChevronDown className="size-4 shrink-0 text-muted" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}

/** Portal 弹层脱离滚动容器，最大高度随可用窗口空间变化。 */
export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content data-slot="select-content" position={position} sideOffset={4} className={cn("z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-raised text-ink shadow-lg", className)} {...props}>
    <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpButton>
    <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
    <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownButton>
  </SelectPrimitive.Content></SelectPrimitive.Portal>;
}

/** 选中标记与焦点高亮相互独立，读屏可读取实际选择。 */
export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-pointer select-none items-center rounded-sm border border-transparent py-2 pr-8 pl-3 text-sm font-medium outline-none data-highlighted:bg-hover data-highlighted:text-ink data-[state=checked]:border-selected-border data-[state=checked]:bg-selected data-[state=checked]:text-ink data-[state=checked]:font-semibold data-[state=checked]:data-highlighted:bg-selected focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent data-disabled:pointer-events-none data-disabled:text-muted", className)} {...props}><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><span className="absolute right-2 flex size-4 items-center justify-center text-ink"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span></SelectPrimitive.Item>;
}
