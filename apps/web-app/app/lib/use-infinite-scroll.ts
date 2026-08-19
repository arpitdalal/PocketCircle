import { type RefObject, useEffect, useRef } from "react";
import type { PaginationStatus } from "~/lib/data.js";

/**
 * Pins `status` and `loadMore` for the intersection callback in an effect — not during
 * render — so concurrent React never observes ref values ahead of committed props.
 * Observes the sentinel only while `status === "CanLoadMore"`.
 *
 * Learnings encoded here (Categories infinite scroll, PR #111):
 *
 * 1. Pin latest `status`/`loadMore` in refs via `useEffect`, NOT during render — render-phase
 *    ref writes break under concurrent React. The pin effect must run before the observer effect
 *    so refs are current within any commit.
 * 2. The sentinel only mounts while `status === "CanLoadMore"`, and the observer effect is keyed
 *    on `[status, sentinelRef, rootRef]` — observer lifetime matches the sentinel; unmount/remount through
 *    `LoadingMore → CanLoadMore` re-arms so consecutive pages load while the user sits at the bottom.
 * 3. Double guard: the callback checks `statusRef.current === "CanLoadMore"`, and the paginated
 *    `loadMore` is a no-op unless `CanLoadMore` (backstop for the race between `loadMore()` and re-render).
 * 4. Viewport observers use `rootMargin: "0px 0px 200px 0px"`. A tray `rootRef` uses a smaller
 *    `48px` bottom margin so prefetch stays inside the dropdown scroller.
 */
export function useInfiniteScroll(
  sentinelRef: RefObject<HTMLElement | null>,
  status: PaginationStatus,
  loadMore: () => void,
  options?: { rootRef?: RefObject<HTMLElement | null> },
) {
  const statusRef = useRef(status);
  const loadMoreRef = useRef(loadMore);
  const rootRef = options?.rootRef;

  useEffect(() => {
    statusRef.current = status;
    loadMoreRef.current = loadMore;
  }, [status, loadMore]);

  useEffect(() => {
    if (status !== "CanLoadMore") {
      return;
    }
    const node = sentinelRef.current;
    if (!node) {
      return;
    }
    const root = rootRef?.current ?? null;
    if (rootRef && !root) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          if (statusRef.current !== "CanLoadMore") {
            return;
          }
          loadMoreRef.current();
          return;
        }
      },
      {
        root,
        rootMargin: rootRef ? "0px 0px 48px 0px" : "0px 0px 200px 0px",
        threshold: 0,
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [status, sentinelRef, rootRef]);
}
