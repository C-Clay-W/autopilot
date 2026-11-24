// 按需采用 shadcn/ui 的本地组件形式，Radix 提供布局单选、方向键与焦点语义。
import type { ComponentProps } from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "./utils";

/** 保留 Radix 的单选组契约，由使用处决定响应式排列。 */
export function ToggleGroup(props: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return <ToggleGroupPrimitive.Root data-slot="toggle-group" {...props} />;
}

/** 布局卡使用圆角和淡橙填充选中，品牌橙用于焦点与确认标记。 */
export function ToggleGroupItem({ className = "", ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return <ToggleGroupPrimitive.Item data-slot="toggle-group-item" className={cn("min-w-0 rounded-lg border border-border bg-surface text-ink outline-none transition-colors hover:border-muted/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg data-[state=on]:border-selected-border data-[state=on]:bg-selected data-[state=on]:hover:bg-selected disabled:pointer-events-none disabled:opacity-50", className)} {...props} />;
}
