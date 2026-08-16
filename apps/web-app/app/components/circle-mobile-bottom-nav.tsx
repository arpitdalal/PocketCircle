import { Dialog } from "@base-ui/react/dialog";
import { MoreHorizontal, X } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  mobileSheetBackdropClassName,
  mobileSheetPopupBaseClassName,
} from "~/components/ui/mobile-sheet-primitives.js";
import { circleNavItems, isCircleNavItemActive, PRIMARY_SLOT_COUNT } from "~/lib/circle-nav.js";
import type { Circle } from "~/lib/data.js";
import { cn } from "~/lib/utils.js";

/**
 * Fixed mobile bar frame. Height is content (4rem) + safe-area so the home-
 * indicator padding sits *below* the labels — not inside a border-box `h-16`
 * that crushed the slots. Vars live in `app.css`.
 */
export const mobileBottomNavFrameClassName =
  "fixed inset-x-0 bottom-0 z-30 flex h-[var(--mobile-bottom-nav-height)] items-stretch border-t border-border bg-background/80 pb-[var(--safe-area-bottom)] backdrop-blur-md sm:hidden";

function slotClass(isActive: boolean) {
  return cn(
    "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs transition-colors duration-150 min-w-0",
    isActive
      ? "font-medium text-foreground [&_svg]:text-primary"
      : "text-muted-foreground hover:text-foreground [&_svg]:text-muted-foreground",
  );
}

/**
 * Circle-scoped mobile bottom bar + "More" sheet (ADR 0022, issue #124). Renders only
 * below `sm`; desktop uses the horizontal tab nav in `circle-layout.tsx`. Both navs
 * read their destinations from `circleNavItems` so they can't drift.
 */
export function CircleMobileBottomNav({ circle }: { circle: Circle }) {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const items = circleNavItems(circle.ref);
  const primarySlots = items.slice(0, PRIMARY_SLOT_COUNT);
  const moreItems = items.slice(PRIMARY_SLOT_COUNT);

  const moreActive = moreItems.some((item) => isCircleNavItemActive(location.pathname, item));
  const routeLocation = location.pathname + location.search + location.hash;

  // Close the More sheet on navigation before commit so it doesn't paint open on a route
  // it no longer belongs to. Track the semantic route, not the location object identity,
  // so same-route rerenders don't close/remount the sheet while a link is being clicked.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- value IS read during render (the comparison below) to drive React's canonical "adjust state during render" reset. useRef is wrong here: React discourages mutating a ref during render, and set-state-during-render is the blessed pattern for this. The rule only checks JSX-reachability, so it misfires.
  const [prevRouteLocation, setPrevRouteLocation] = useState(routeLocation);
  if (routeLocation !== prevRouteLocation) {
    setPrevRouteLocation(routeLocation);
    setMoreOpen(false);
  }

  return (
    <>
      <nav
        aria-label="Circle"
        className={mobileBottomNavFrameClassName}
        data-testid="circle-mobile-bottom-nav"
      >
        {primarySlots.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              prefetch="viewport"
              className={({ isActive }) => slotClass(isActive)}
            >
              <Icon aria-hidden className="size-5 shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          aria-current={moreActive ? "page" : undefined}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
          className={slotClass(moreActive)}
        >
          <MoreHorizontal aria-hidden className="size-5 shrink-0" />
          <span className="truncate">More</span>
        </button>
      </nav>

      <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className={mobileSheetBackdropClassName} />
          <Dialog.Popup
            className={cn(mobileSheetPopupBaseClassName, "pb-[max(1rem,var(--safe-area-bottom))]")}
          >
            <div className="flex items-center justify-between px-4 pt-4">
              <Dialog.Title className="text-sm font-medium text-foreground">More</Dialog.Title>
              <Dialog.Close
                aria-label="Close"
                className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }))}
              >
                <X aria-hidden className="size-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              Categories, members, and history navigation for this circle.
            </Dialog.Description>
            <div className="flex flex-col gap-1 px-4 pb-4 pt-2">
              {moreItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    prefetch="intent"
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors",
                        isActive
                          ? "bg-muted font-medium text-foreground [&_svg]:text-primary"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground [&_svg]:text-muted-foreground",
                      )
                    }
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/**
 * Presentational stand-in for the Circle bottom bar shown during a cross-Circle shell
 * skeleton (issue #121). Switching Circles routes to the shell `PageSkeleton`, which
 * unmounts `CircleLayout` and with it the real bar; without this the bar would flash out
 * and back, the one mobile layout shift the loading work otherwise avoids. It mirrors the
 * real bar's footprint (same fixed frame, `PRIMARY_SLOT_COUNT` slots + "More") so the
 * swap is seamless, and is `aria-hidden` — the shell `PageSkeleton` already announces the
 * load, and the real, navigable bar mounts the moment the destination Circle resolves.
 */
export function CircleBottomNavSkeleton() {
  const slots = Array.from(
    { length: PRIMARY_SLOT_COUNT + 1 },
    (_, index) => `bottom-nav-slot-${index}`,
  );
  return (
    <div
      aria-hidden
      data-testid="circle-bottom-nav-skeleton"
      className={mobileBottomNavFrameClassName}
    >
      {slots.map((slot) => (
        <div key={slot} className="flex flex-1 flex-col items-center justify-center gap-1.5 py-2">
          <span className="size-5 animate-pulse-soft rounded-full bg-muted" />
          <span className="h-2.5 w-10 animate-pulse-soft rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
