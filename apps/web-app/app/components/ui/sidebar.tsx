import { useRender } from "@base-ui/react/use-render";
import { type ComponentProps, createContext, use, useState } from "react";
import {
  type SidebarMenuButtonVariantProps,
  sidebarMenuButtonVariants,
} from "~/components/ui/sidebar-variants.js";
import { cn } from "~/lib/utils.js";

/**
 * Repository-owned desktop subset of shadcn/ui Sidebar (ADR 0005, issue #351),
 * adapted to Base UI's `render` prop, Tailwind 4 theme tokens, and PocketCircle's
 * `lg` breakpoint (shadcn ships `md`).
 *
 * Only the parts the app uses are copied. No mobile Sheet, rail, collapse trigger,
 * collapsed tooltips, cookie persistence, or keyboard shortcut: mobile already has
 * purpose-built navigation (ADR 0022) and a collapse control needs its own
 * interaction design first.
 *
 * The collapse STATE MODEL is in place, so exposing a trigger later does not mean a
 * rewrite: {@link SidebarProvider} supports controlled and uncontrolled `open`, the panel
 * carries `data-state="expanded" | "collapsed"` plus `data-collapsible`, widths come from
 * the `--sidebar-width` / `--sidebar-width-icon` variables in `app.css` (CSS-owned rather
 * than an inline style, so no `as CSSProperties` cast), and menu rows clip their labels
 * instead of removing them. The collapsed PRESENTATION is not finished: shadcn pairs an
 * icon rail with per-row tooltips, and until those exist a collapsed panel would show
 * rows with no visible label.
 */

interface SidebarContextValue {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = use(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}

export function SidebarProvider({
  open: openProp,
  onOpenChange,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // Expanded until an owner says otherwise: the shell renders the provider bare, so this
  // is the state the app actually ships.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(true);
  const open = openProp ?? uncontrolledOpen;

  // `open` decides ownership; `onOpenChange` is only a notification. Treating a bare
  // `onOpenChange` as "controlled" would freeze an uncontrolled panel whose owner just
  // wanted to observe the toggle (same split as Base UI's own controllable props).
  const setOpen = (next: boolean) => {
    if (openProp === undefined) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <SidebarContext.Provider
      value={{
        state: open ? "expanded" : "collapsed",
        open,
        setOpen,
      }}
    >
      <div
        data-slot="sidebar-wrapper"
        className={cn("flex min-h-dvh w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/**
 * The fixed panel plus the in-flow gap it occupies. Painted only at `lg` and above —
 * CSS, not a JavaScript viewport branch, so server and client markup agree.
 *
 * The panel itself is a `complementary` landmark (`<aside>`, labelled by the caller):
 * at `lg` the sticky header — and with it the `banner` that used to hold these controls
 * — is not rendered, so without this the brand, bell, switcher, launchers, and account
 * menu would sit outside every landmark, leaving `main` as the only one on the page.
 */
export function Sidebar({ className, children, ...props }: ComponentProps<"aside">) {
  const { state } = useSidebar();

  return (
    <div
      className="group hidden text-sidebar-foreground lg:block"
      data-slot="sidebar"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
    >
      {/* Holds the space the fixed panel covers, so the inset never sits underneath it. */}
      <div
        data-slot="sidebar-gap"
        className="relative h-dvh w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
      />
      <aside
        data-slot="sidebar-container"
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex h-dvh w-(--sidebar-width) border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          className,
        )}
        {...props}
      >
        <div className="flex h-full w-full min-w-0 flex-col">{children}</div>
      </aside>
    </div>
  );
}

/**
 * The pane beside the sidebar. Deliberately a `<div>`, not shadcn's `<main>`:
 * PocketCircle keeps exactly one `<main>` landmark (the skip-link target), and the
 * responsive header and notification strip live inside this inset above it.
 */
export function SidebarInset({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn("flex w-full min-w-0 flex-1 flex-col bg-background", className)}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex flex-col gap-1 border-t border-sidebar-border p-2", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col px-2 py-1", className)}
      {...props}
    />
  );
}

export function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />
  );
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative list-none", className)}
      {...props}
    />
  );
}

/**
 * A sidebar menu row. Defaults to a `<button>`; compose it with a `NavLink`, a
 * Popover trigger, or anything else through Base UI's `render` prop. Keep children as
 * an icon plus a trailing `<span>` label so the collapse variants can hide the text
 * without touching callers.
 */
export function SidebarMenuButton({
  isActive = false,
  size,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> &
  SidebarMenuButtonVariantProps & {
    /** Marks the row as the current destination (`data-active`, styled by the variants). */
    isActive?: boolean;
  }) {
  return useRender({
    defaultTagName: "button",
    render,
    props: {
      "data-slot": "sidebar-menu-button",
      "data-size": size ?? "default",
      "data-active": isActive,
      className: cn(sidebarMenuButtonVariants({ size }), className),
      ...props,
    },
  });
}

/** Trailing status chip for a menu row. A SIBLING of the button so `peer-*` offsets apply. */
export function SidebarMenuBadge({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-md bg-sidebar-primary px-1 text-[10px] font-semibold tabular-nums text-sidebar-primary-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-3.5 peer-data-[size=sm]/menu-button:top-1 group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}
