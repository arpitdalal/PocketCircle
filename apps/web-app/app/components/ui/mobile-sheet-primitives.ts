import { cn } from "~/lib/utils.js";

/** Shared bottom-sheet backdrop + mobile popup base classes (FilterPanel, Circle "More", PWA install). */
export const mobileSheetBackdropClassName =
  "fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] data-open:animate-fade-in";

/** Mobile-only bottom sheet shell; FilterPanel adds `md:` overrides on the same node. */
export const mobileSheetPopupBaseClassName = cn(
  "fixed z-50 flex flex-col border-border bg-card shadow-xl outline-none",
  "inset-x-0 bottom-0 max-h-[86vh] rounded-t-xl border-t data-open:animate-panel-up",
);
