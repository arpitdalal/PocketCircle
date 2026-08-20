import { useState, useSyncExternalStore } from "react";

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

type ScopeMotionState = {
  scopeKey: string;
  valueKey: string;
  armed: boolean;
  /**
   * Stored (not only returned) so adjust-state-during-render retries still
   * commit `true` to children — returning `true` from the setState render is
   * discarded (same React behavior as `useValueChange`).
   */
  animate: boolean;
};

/**
 * Whether this render should run ADR 0032 motion for a value update.
 *
 * - `scope`: animate only when `valueKey` changes after `scopeKey` changed
 *   while a retained query is still pending. Live refreshes with the same
 *   scope snap without digit/chart motion.
 * - `always`: animate every `valueKey` change after mount (Dashboard
 *   current-month totals may refresh from live queries — ADR 0032).
 *
 * Pass `pending` from `useStableQuery` / Home retention so an armed scope is
 * disarmed when the new query settles with an unchanged fingerprint (e.g. two
 * empty ledger months) — otherwise the next live update would falsely animate.
 *
 * `animate` stays true until a later transition explicitly clears it. NumberFlow
 * / Recharts only move when their value props change, so a sticky flag after a
 * pulse is harmless.
 */
export function useScopeChangeMotion(
  scopeKey: string,
  valueKey: string,
  mode: "scope" | "always" = "scope",
  pending = false,
) {
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- tracked previous scope/value IS read during render to arm one motion frame (ADR 0032); same adjust-state-during-render pattern as useValueChange.
  const [tracked, setTracked] = useState<ScopeMotionState>(() => ({
    scopeKey,
    valueKey,
    armed: false,
    animate: false,
  }));

  if (mode === "always") {
    if (!Object.is(valueKey, tracked.valueKey) || !Object.is(scopeKey, tracked.scopeKey)) {
      setTracked({ scopeKey, valueKey, armed: false, animate: true });
    }
  } else if (!Object.is(scopeKey, tracked.scopeKey)) {
    if (!Object.is(valueKey, tracked.valueKey)) {
      setTracked({ scopeKey, valueKey, armed: false, animate: true });
    } else if (pending) {
      setTracked({ scopeKey, valueKey, armed: true, animate: false });
    } else {
      setTracked({ scopeKey, valueKey, armed: false, animate: false });
    }
  } else if (tracked.armed && !Object.is(valueKey, tracked.valueKey)) {
    setTracked({ scopeKey, valueKey, armed: false, animate: true });
  } else if (tracked.armed && !pending) {
    setTracked({ scopeKey, valueKey, armed: false, animate: false });
  } else if (!Object.is(valueKey, tracked.valueKey)) {
    setTracked({ scopeKey, valueKey, armed: false, animate: false });
  }

  return tracked.animate;
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
