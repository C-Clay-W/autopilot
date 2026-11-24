// 本地 shadcn Button 统一无衬线字重、圆角、整行选中与键盘焦点。
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-transparent bg-accent text-on-accent hover:bg-accent/90",
        outline: "border border-input-border bg-surface text-ink hover:bg-hover hover:border-muted/40",
        ghost: "border border-transparent text-muted hover:bg-hover hover:text-ink aria-[current=page]:border-selected-border aria-[current=page]:bg-selected aria-[current=page]:text-ink aria-[current=page]:hover:bg-selected aria-pressed:border-selected-border aria-pressed:bg-selected aria-pressed:text-ink aria-pressed:hover:bg-selected data-[state=open]:bg-hover data-[state=open]:text-ink",
        destructive: "border border-transparent text-muted hover:bg-hover hover:text-error",
      },
      size: { default: "h-9 px-4", sm: "h-8 px-3", icon: "size-8 p-0" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/** 原生按钮保留 ref 与事件，Radix 触发器通过 asChild 复用此 DOM。 */
export function Button({ className, variant, size, type = "button", ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
