import { cva, type VariantProps } from "class-variance-authority";

// shadcn/ui-style sidebar menu-button variants (ADR 0005, issue #351). Kept separate
// from `sidebar.tsx` so the component file only exports components (fast refresh /
// react-doctor), matching `button-variants.ts`.
//
// `group-data-[collapsible=icon]:*` is the collapse-ready half of the contract: the
// panel sets `data-collapsible="icon"` when the provider is collapsed, which squares each
// row down to its icon. Nothing collapses it today (no trigger is exposed — issue #351
// "Out of scope"), so the icon state is unreachable; what is here keeps the row's
// GEOMETRY ready, not its full presentation — collapsed rows would still need shadcn's
// tooltips to name themselves on hover.
//
// Labels are CLIPPED by the row's `overflow-hidden`, never `display:none`: an element
// with `display:none` is excluded from accessible-name computation, so hiding the span
// would leave collapsed rows as unnamed buttons.
//
// `group-has-data-[slot=sidebar-menu-badge]` reserves the trailing space a badge needs,
// so callers never hand-roll their own right padding (shadcn does the same for its menu
// actions).
export const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm text-sidebar-foreground outline-none transition-[background-color,color,width,height,padding] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[popup-open]:bg-sidebar-accent group-has-data-[slot=sidebar-menu-badge]/menu-item:pr-14 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      size: {
        default: "h-8",
        lg: "h-12 group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

export type SidebarMenuButtonVariantProps = VariantProps<typeof sidebarMenuButtonVariants>;
