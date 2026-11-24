// 本地 shadcn Alert 统一错误和状态未接入提示，不推断任务事实。
import type { ComponentProps } from "react";
import { cn } from "./utils";

/** 明确失败使用 alert，普通说明由调用方选择 status。 */
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert" role="alert" className={cn("flex items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", className)} {...props} />;
}
