import type { ComponentProps } from "react";
import { cn } from "~/lib/utils.js";
import { type BadgeVariantProps, badgeVariants } from "./badge-variants.js";

export interface BadgeProps extends Omit<ComponentProps<"span">, "className">, BadgeVariantProps {
  className?: string;
}

/**
 * Status / label chip (shadcn/ui-style, ADR 0005). Native `<span>` — compose
 * inside links and menu items; do not use as a button.
 */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

Badge.displayName = "Badge";
