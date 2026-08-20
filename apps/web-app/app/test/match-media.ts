import { afterEach, vi } from "vitest";

export type MatchMediaFakeHandle = {
  matchMedia: ReturnType<typeof vi.fn>;
  /** Update a query's match state and notify subscribed listeners. */
  setQueryMatches: (query: string, matches: boolean) => void;
  /** Restore the prior `window.matchMedia` implementation. */
  restore: () => void;
};

/**
 * Configurable `window.matchMedia` fake for motion/a11y tests. Supports live
 * `matches` reads and `change` listener subscriptions (used by
 * `usePrefersReducedMotion`'s `useSyncExternalStore` wiring).
 */
export function installMatchMediaFake(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();

  const matchMedia = vi.fn((query: string) => {
    let queryListeners = listeners.get(query);
    if (!queryListeners) {
      queryListeners = new Set();
      listeners.set(query, queryListeners);
    }

    return {
      get matches() {
        return state[query] ?? false;
      },
      media: query,
      onchange: null,
      addListener: (listener: () => void) => {
        queryListeners.add(listener);
      },
      removeListener: (listener: () => void) => {
        queryListeners.delete(listener);
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "change") {
          queryListeners.add(listener);
        }
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "change") {
          queryListeners.delete(listener);
        }
      },
      dispatchEvent: vi.fn(),
    };
  });

  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    matchMedia,
    setQueryMatches(query: string, matches: boolean) {
      if ((state[query] ?? false) === matches) {
        return;
      }
      state[query] = matches;
      for (const listener of listeners.get(query) ?? []) {
        listener();
      }
    },
    restore() {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previous,
      });
    },
  };
}

export function installReducedMotionPreference(prefersReducedMotion: boolean) {
  return installMatchMediaFake({ "(prefers-reduced-motion: reduce)": prefersReducedMotion });
}

/**
 * Shared lifecycle for files that install matchMedia fakes — one `afterEach`
 * restore so each suite doesn't redefine the same teardown (ADR 0006).
 */
export function createMatchMediaFakeController() {
  let media: MatchMediaFakeHandle | undefined;
  afterEach(() => {
    media?.restore();
    media = undefined;
  });
  return {
    reducedMotion(prefersReducedMotion: boolean) {
      media?.restore();
      media = installReducedMotionPreference(prefersReducedMotion);
      return media;
    },
  };
}
