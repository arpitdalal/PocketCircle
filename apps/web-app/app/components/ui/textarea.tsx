import type { ComponentProps } from "react";
import { cn } from "~/lib/utils.js";

/**
 * Multi-line text input (shadcn/ui style, ADR 0005). Matches `Input`'s look and its
 * `aria-invalid` error border so single- and multi-line fields read consistently.
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus:ring-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

Textarea.displayName = "Textarea";
