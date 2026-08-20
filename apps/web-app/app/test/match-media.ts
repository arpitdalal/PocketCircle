import { vi } from "vitest";

/** Installs a configurable `window.matchMedia` fake for motion/a11y tests. */
export function installMatchMediaFake(queries: Record<string, boolean>) {
  const matchMedia = vi.fn((query: string) => ({
    matches: queries[query] ?? false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  return matchMedia;
}

export function installReducedMotionPreference(prefersReducedMotion: boolean) {
  return installMatchMediaFake({ "(prefers-reduced-motion: reduce)": prefersReducedMotion });
}
