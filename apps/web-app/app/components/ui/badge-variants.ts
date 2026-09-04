import { cva, type VariantProps } from "class-variance-authority";

// shadcn/ui-style badge variants (ADR 0005). Kept separate from `badge.tsx` so
// the component file only exports components (fast refresh / react-doctor).
// `rounded-md` matches PocketCircle controls (buttons/menus), not shadcn's
// default `rounded-full`.
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        // Soft primary chip for “New” / status hints in dense chrome.
        soft: "bg-primary/10 text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeVariantProps = VariantProps<typeof badgeVariants>;
