import { cn } from "~/lib/utils.js";

/** Landmark id the skip link targets — one source so href + `<main>` cannot drift. */
export const MAIN_CONTENT_ID = "main-content";

/**
 * First tab stop in the authenticated shell (WCAG 2.4.1 Bypass Blocks).
 * Hidden until focused; moves keyboard focus past the sticky header into `<main>`.
 */
export function SkipNavigation() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className={cn(
        "sr-only focus:not-sr-only",
        "focus:fixed focus:top-[max(0.75rem,var(--safe-area-top))] focus:left-4 focus:z-50",
        "focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
      )}
      onClick={(event) => {
        // Fragment focus is inconsistent across browsers; focus the landmark explicitly.
        const target = document.getElementById(MAIN_CONTENT_ID);
        if (target == null) {
          return;
        }
        event.preventDefault();
        target.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
