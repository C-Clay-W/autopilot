// 本地 shadcn Badge 以文字配合语义状态色，进程事实与示例任务状态保持区分。
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const badgeVariants = cva("inline-flex shrink-0 items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium", {
  variants: { variant: {
    outline: "border-border bg-hover text-muted",
    accent: "border-accent text-accent-soft",
    success: "border-success/40 text-success",
    warning: "border-warning/40 text-warning",
    error: "border-error/40 text-error",
  } },
  defaultVariants: { variant: "outline" },
});

/** 徽标保持非交互语义，只表达可证明的状态。 */
export function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
