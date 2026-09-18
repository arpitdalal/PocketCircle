/** Shared shell chrome for Suspense fallback + Recharts container (size must match).
 * `min-w-0 overflow-hidden` keeps ResponsiveContainer's initial width from widening
 * the page (horizontal scroll breaks `position: fixed` bottom chrome). */
export const CASH_FLOW_CHART_SHELL_CLASSNAME =
  "h-72 min-w-0 w-full overflow-hidden rounded-xl border border-border bg-card p-3 shadow-sm";
