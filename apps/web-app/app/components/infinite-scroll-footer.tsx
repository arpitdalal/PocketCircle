import { type RefObject, useRef } from "react";
import type { PaginationStatus } from "~/lib/data.js";
import { useInfiniteScroll } from "~/lib/use-infinite-scroll.js";
import { cn } from "~/lib/utils.js";

/**
 * Persistent `role="status"` live region plus optional infinite-scroll sentinel.
 * The region stays mounted with content toggling (`Loading…` ↔ nbsp) and `sr-only` when idle
 * so screen readers reliably announce pagination — mounting the region only while `LoadingMore`
 * makes announcements easy to miss (PR #111 / issue #98).
 * The footer owns the observer wiring so consumers pass `loadMore` instead of threading a ref.
 */
export function InfiniteScrollFooter({
  status,
  loadMore,
  loadingCopy,
  listAriaLabel,
  sentinelTestId,
  rootRef,
}: {
  status: PaginationStatus;
  loadMore: () => void;
  loadingCopy: string;
  listAriaLabel: string;
  sentinelTestId: string;
  /** Scroll container for the observer. Omit to use the viewport (Categories/Transactions). */
  rootRef?: RefObject<HTMLElement | null>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, status, loadMore, rootRef);

  return (
    <>
      <output
        aria-live="polite"
        aria-atomic="true"
        aria-label={listAriaLabel}
        className={cn(
          status === "LoadingMore"
            ? "text-sm text-muted-foreground"
            : "sr-only pointer-events-none",
        )}
      >
        {status === "LoadingMore" ? loadingCopy : "\u00a0"}
      </output>
      {status === "CanLoadMore" ? (
        <div
          ref={sentinelRef}
          data-testid={sentinelTestId}
          aria-hidden
          className="h-2 w-full shrink-0"
        />
      ) : null}
    </>
  );
}
