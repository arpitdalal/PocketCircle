import { useMediaQuery } from "./media-query.js";
import { useValueChange } from "./use-value-change.js";

/**
 * Which chrome an app-shell control instance belongs to (issue #351). The sticky
 * header and the desktop sidebar both host the install / notification / account
 * controls, and CSS decides which one is painted — so both instances exist in the
 * tree at all times.
 */
export type AppChrome = "header" | "sidebar";

/**
 * Where a chrome control's popup opens. The header hangs its menus below the bar; the
 * sidebar sends them out to the side, like {@link ../components/sidebar-flyout.js} —
 * a tray wider than the panel would otherwise be pushed over the content it is
 * supposed to sit beside. `sidebarAlign` follows where the trigger sits in the panel,
 * so the tray grows into the panel's length instead of relying on collision shifting:
 * `start` for the top row (notifications), `end` for the footer (account).
 */
export function chromeMenuPlacement(chrome: AppChrome, sidebarAlign: "start" | "end") {
  return chrome === "sidebar"
    ? ({ side: "right", align: sidebarAlign } as const)
    : ({ side: "bottom", align: "end" } as const);
}

/**
 * JS mirror of Tailwind's `lg` (64rem) — the width where the sidebar replaces the
 * sticky header. Layout NEVER reads this (issue #351 keeps visibility in CSS so
 * server and client markup agree); it exists only so a control with a global,
 * side-effecting trigger can pick a single owner between the two chromes.
 */
export const SIDEBAR_CHROME_QUERY = "(min-width: 64rem)";

/**
 * Whether `chrome` is the instance the user can actually see.
 *
 * Needed for controls whose popups portal to `document.body` and therefore outlive the
 * `display:none` of their own chrome: a Push-focus auto-open (#384) must land in the
 * painted chrome, and a popup left open across the breakpoint must close instead of
 * floating beside a hidden trigger. Presentation stays CSS-only; this only arbitrates
 * side effects.
 *
 * Mobile-first server snapshot (`header`), matching `usePrefersReducedMotion`.
 */
export function useIsActiveChrome(chrome: AppChrome) {
  const sidebarActive = useMediaQuery(SIDEBAR_CHROME_QUERY, false);
  return chrome === (sidebarActive ? "sidebar" : "header");
}

/**
 * Closes a chrome-scoped popup when CSS stops painting its chrome — a resize across the
 * breakpoint with the sidebar tray open would otherwise leave the tray on screen,
 * anchored to a hidden trigger, while the newly painted header shows everything closed.
 */
export function useCloseWhenChromeHidden(chrome: AppChrome, close: () => void) {
  const active = useIsActiveChrome(chrome);
  useValueChange(active, (isActive) => {
    if (!isActive) {
      close();
    }
  });
}
