import type { ComponentProps } from "react";
import { cn } from "~/lib/utils.js";

/**
 * Text input (shadcn/ui style, ADR 0005). `aria-invalid` paints the error border so
 * a field's validity is conveyed visually and to assistive tech without extra markup;
 * the form sets it from the field's error state.
 */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus:ring-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

Input.displayName = "Input";
