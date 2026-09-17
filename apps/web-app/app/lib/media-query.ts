import { useSyncExternalStore } from "react";

/**
 * Reactive CSS media queries for the two places JS legitimately needs to know what CSS
 * decided: `prefers-reduced-motion` gating (ADR 0032) and which app chrome is painted
 * (issue #351). Presentation itself stays in CSS.
 *
 * One store per query string, created once and cached, because `useSyncExternalStore`
 * tears down and re-subscribes whenever the `subscribe` reference changes. Snapshots are
 * booleans, so React's `Object.is` comparison settles immediately.
 *
 * `pageshow` sits alongside `change` so a document restored from the back/forward cache
 * re-reads a query that changed (rotation, window resize) while it was frozen and could
 * not receive events.
 */

type MediaQueryStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  read: () => boolean;
};

const stores = new Map<string, MediaQueryStore>();

function matchMediaOrNull(query: string) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(query);
}

function storeFor(query: string) {
  const cached = stores.get(query);
  if (cached) {
    return cached;
  }

  const store: MediaQueryStore = {
    subscribe(onStoreChange) {
      const media = matchMediaOrNull(query);
      if (!media) {
        return () => {};
      }
      media.addEventListener("change", onStoreChange);
      window.addEventListener("pageshow", onStoreChange);
      return () => {
        media.removeEventListener("change", onStoreChange);
        window.removeEventListener("pageshow", onStoreChange);
      };
    },
    read: () => matchMediaOrNull(query)?.matches ?? false,
  };
  stores.set(query, store);
  return store;
}

/**
 * Whether `query` currently matches. `serverSnapshot` is what a prerendered document
 * reports: pick the value that lets the server markup hydrate without a visible flip.
 */
export function useMediaQuery(query: string, serverSnapshot: boolean) {
  const store = storeFor(query);
  return useSyncExternalStore(store.subscribe, store.read, () => serverSnapshot);
}
