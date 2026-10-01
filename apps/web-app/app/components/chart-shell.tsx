/** Shared shell chrome for Suspense fallback + Recharts container (size must match).
 * `min-w-0 overflow-hidden` keeps ResponsiveContainer's initial width from widening
 * the page (horizontal scroll breaks `position: fixed` bottom chrome). */
export const CHART_SHELL_CLASSNAME =
  "h-72 min-w-0 w-full overflow-hidden rounded-xl border border-border bg-card p-3 shadow-sm";

/**
 * The `aria-hidden` placeholder every chart in the app shows while its Recharts chunk
 * loads, so the accessible reading (the sr-only table) is never gated on the bundle.
 */
export function ChartShellFallback() {
  return (
    <div
      aria-hidden="true"
      data-chart-shell="fallback"
      data-chart-animation-active="false"
      className={CHART_SHELL_CLASSNAME}
    />
  );
}
