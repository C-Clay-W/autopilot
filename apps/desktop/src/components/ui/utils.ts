// 合并本地 shadcn 组件的条件类名与 Tailwind 覆盖，主题由 Desktop token 提供。
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 后传入的 Tailwind 样式覆盖默认值，避免组件密度与调用处互相冲突。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
