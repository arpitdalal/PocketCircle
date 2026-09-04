import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { cn } from "~/lib/utils.js";

export function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    // role="group" is intentional; react-doctor/prefer-tag-over-role is ignored for this file in
    // doctor.config.json — no native tag with implicit role="group" fits (a <fieldset>/<address>
    // would force unwanted form/contact semantics; react-doctor's inline disable can't sit adjacent
    // to the role attr without displacing the required adjacent biome-ignore below).
    // biome-ignore lint/a11y/useSemanticElements: shadcn input-group; not a form field grouping.
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex w-full items-center rounded-md border border-input shadow-sm transition-[color,box-shadow] outline-none dark:bg-input/30",
        "h-9 min-w-0 has-[>textarea]:h-auto",

        "has-[>[data-align=inline-start]]:[&>input]:pl-2",
        "has-[>[data-align=inline-end]]:[&>input]:pr-2",
        "has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3",
        "has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3",

        "has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50",

        "has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-destructive/20 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40",

        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-3 has-[>button]:ml-[-0.45rem] has-[>kbd]:ml-[-0.35rem]",
        "inline-end": "order-last pr-3 has-[>button]:mr-[-0.45rem] has-[>kbd]:mr-[-0.35rem]",
        "block-start":
          "order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-2.5 [.border-b]:pb-3",
        "block-end":
          "order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-2.5 [.border-t]:pt-3",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

export function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    // role="group" is intentional; react-doctor/prefer-tag-over-role is ignored for this file in
    // doctor.config.json — no native tag with implicit role="group" fits (a <fieldset>/<address>
    // would force unwanted form/contact semantics; react-doctor's inline disable can't sit adjacent
    // to the role attr without displacing the required adjacent biome-ignore below).
    // biome-ignore lint/a11y/useSemanticElements: addon row inside input-group; not a fieldset.
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") {
          return;
        }
        // Descendant buttons must keep native Enter/Space activation (Copy, etc.).
        if (e.target instanceof Element && e.target.closest("button")) {
          return;
        }
        e.preventDefault();
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva("flex items-center gap-2 text-sm shadow-none", {
  variants: {
    size: {
      xs: "h-6 gap-1 rounded-[calc(var(--radius)-5px)] px-2 has-[>svg]:px-2 [&>svg:not([class*='size-'])]:size-3.5",
      sm: "h-8 gap-1.5 rounded-md px-2.5 has-[>svg]:px-2.5",
      "icon-xs": "size-6 rounded-[calc(var(--radius)-5px)] p-0 has-[>svg]:p-0",
      "icon-sm": "size-8 p-0 has-[>svg]:p-0",
    },
  },
  defaultVariants: {
    size: "xs",
  },
});

export function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  render,
  nativeButton,
  ...props
}: Omit<ComponentProps<typeof Button>, "size"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    render?: ComponentProps<typeof Button>["render"];
    nativeButton?: ComponentProps<typeof Button>["nativeButton"];
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      render={render}
      nativeButton={nativeButton}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

export function InputGroupInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}
