// 本地 shadcn Checkbox 使用 Radix 管理复选语义、空格键与焦点。
import type { ComponentProps } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "./utils";

/** 复选框沿用品牌橙，并为未选中边界提供足够对比度。 */
export function Checkbox({ className, checked, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return <CheckboxPrimitive.Root data-slot="checkbox" checked={checked} className={cn("peer size-4 shrink-0 rounded-sm border border-muted bg-bg outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent disabled:cursor-not-allowed disabled:opacity-50", className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">{checked === "indeterminate" ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}</CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}
