import { useEffect, useState, useSyncExternalStore } from "react";

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
 *
 * Uses `useSyncExternalStore` so SSR and hydration start from `false` until the
 * client reads the real media query.
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeToReducedMotion, readPrefersReducedMotion, () => false);
}

function subscribeToReducedMotion(onStoreChange: () => void) {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function readPrefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

type ScopeMotionPrev = {
  scopeKey: string;
  valueKey: string;
  armed: boolean;
};

/**
 * Whether this render should run ADR 0032 motion for a value update.
 *
 * - `scope`: animate only when `valueKey` changes after `scopeKey` changed
 *   (currency/range/month/comparison controls). Live refreshes with the same
 *   scope snap without digit/chart motion.
 * - `always`: animate every `valueKey` change after mount (Dashboard
 *   current-month totals may refresh from live queries — ADR 0032).
 *
 * Derives `animated` from the previous committed keys during render, then syncs
 * that snapshot in an Effect so the pulse is not lost to adjust-state retries.
 */
export function useScopeChangeMotion(
  scopeKey: string,
  valueKey: string,
  mode: "scope" | "always" = "scope",
) {
  const [prev, setPrev] = useState(
    () => ({ scopeKey, valueKey, armed: false }) satisfies ScopeMotionPrev,
  );

  let animated = false;
  if (mode === "always") {
    animated = !Object.is(valueKey, prev.valueKey) || !Object.is(scopeKey, prev.scopeKey);
  } else if (!Object.is(scopeKey, prev.scopeKey)) {
    animated = !Object.is(valueKey, prev.valueKey);
  } else if (prev.armed && !Object.is(valueKey, prev.valueKey)) {
    animated = true;
  }

  useEffect(() => {
    setPrev((p) => {
      if (mode === "always") {
        if (Object.is(scopeKey, p.scopeKey) && Object.is(valueKey, p.valueKey)) return p;
        return { scopeKey, valueKey, armed: false };
      }
      if (!Object.is(scopeKey, p.scopeKey)) {
        if (!Object.is(valueKey, p.valueKey)) {
          return { scopeKey, valueKey, armed: false };
        }
        return { scopeKey, valueKey, armed: true };
      }
      if (!Object.is(valueKey, p.valueKey)) {
        return { scopeKey, valueKey, armed: false };
      }
      return p;
    });
  }, [scopeKey, valueKey, mode]);

  return animated;
}

/** Stable fingerprint for cash-flow chart series (scope-motion value key). */
export function cashFlowSeriesMotionKey(
  series: ReadonlyArray<{
    month: string;
    incomeMinor: number;
    expenseMinor: number;
    netMinor: number;
  }>,
) {
  return series
    .map((row) => `${row.month}:${row.incomeMinor}:${row.expenseMinor}:${row.netMinor}`)
    .join("|");
}

/** Stable fingerprint for Income/Expense/Net totals. */
export function scopeTotalsMotionKey(totals: {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}) {
  return `${totals.incomeMinor}:${totals.expenseMinor}:${totals.netMinor}`;
}
