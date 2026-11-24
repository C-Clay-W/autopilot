// 本地表单输入复用 Desktop token，保留原生键盘与标签语义。
import type { ComponentProps } from "react";
import { cn } from "./utils";
/** 页面只组合输入行为，边框和焦点样式在基础组件集中维护。 */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("h-9 w-full rounded-md border border-input-border bg-bg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent", className)} {...props} />;
}
