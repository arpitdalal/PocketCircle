import { useEffect, useState } from "react";

/** Repo easing token from `app.css` — strong ease-out for UI transitions. */
export const EASE_OUT_QUART = "cubic-bezier(0.165, 0.84, 0.44, 1)";

/** ADR 0032 budgets for scope-change money + chart motion. */
export const SCOPE_MONEY_SPIN_MS = 200;
export const SCOPE_MONEY_OPACITY_MS = 150;
export const SCOPE_CHART_ANIMATION_MS = 200;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Reactive `prefers-reduced-motion` for Recharts gating (ADR 0032).
 *
 * `@number-flow/react` exports its own hook, but it reads a module-level
 * `MediaQueryList` captured at import time — null under jsdom/SSR and then
 * `.matches` throws. NumberFlow digits still honor motion via `respectMotionPreference`.
 */
export function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setPrefersReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return prefersReducedMotion;
}

function readPrefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
