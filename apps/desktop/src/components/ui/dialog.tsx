// 本地 shadcn Dialog 使用 Radix 管理模态、焦点约束与 Escape，样式沿用 Desktop token。
import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "./utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/** 居中暗色卡片与适度模糊遮罩保持外壳字体及柔和边界。 */
export function DialogContent({ className, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-bg/60 backdrop-blur-sm" />
    <DialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-input-border bg-surface p-6 text-ink outline-none", className)} {...props} />
  </DialogPrimitive.Portal>;
}
