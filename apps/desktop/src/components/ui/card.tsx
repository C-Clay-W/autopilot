// 本地 shadcn Card 统一工作区、总台与空态的表面和间距。
import type { ComponentProps } from "react";
import { cn } from "./utils";

/** 卡片仅提供表面语义，页面决定内容与响应式宽度。 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn("rounded-lg border border-border bg-surface text-ink", className)} {...props} />;
}

/** 头部采用统一的标题和说明间距。 */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-2 p-5", className)} {...props} />;
}

/** 内容区域承接卡片头部，避免重复顶部留白。 */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 pb-5", className)} {...props} />;
}
