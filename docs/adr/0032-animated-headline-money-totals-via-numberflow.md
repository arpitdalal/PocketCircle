# Animated headline money totals and cash-flow charts

PocketCircle animates **headline Income / Expenses / Net totals** and the **Cash flow trend chart** when the User changes a **reporting scope control** (Home Summary currency or range, Circle Dashboard comparison range, Monthly Ledger month). Totals use [`@number-flow/react`](https://number-flow.barvian.me/); the chart uses Recharts' built-in transition. Both bridge an otherwise instant swap so the User can track how a scope change moved the summary.

The prior chart policy (`isAnimationActive={false}`) rejected Recharts' **default 1500ms** draw — too slow for a finance UI. **Fast** chart transitions (~200ms) on scope change are in scope; slow decorative draw-in is not.

This applies only to **read-only summary surfaces** recomputed for a new scope. It does **not** apply to row-level money in Transaction lists, recent feeds, history, detail views, category analytics breakdowns, chart tooltips, or export formatting. Those surfaces are for scanning, editing, or reading dense data; motion there hinders rather than helps (Emil Kowalski frequency/purpose bar).

**Home Summary** (ADR 0031): the three Cash flow total cards (`Income`, `Expenses`, `Net cash flow`) animate when currency, comparison range, or Circle inclusion changes. Per-Circle contribution amounts, recent Transaction rows, and the sr-only chart table stay static `formatMoney` strings.

**Circle Dashboard** (CONTEXT **Dashboard**): the current-month totals grid animates when the selected month changes or the Dashboard query refreshes with new totals for the same month.

**Monthly Ledger** (CONTEXT **Monthly Ledger**): the month totals grid (`Monthly totals` legend) animates when the User changes the selected ledger month. Ledger **Filters** do not change these totals (only the Transaction list narrows); do not tie animation to filter Apply.

`DashboardTotalsCards` (`dashboard.tsx`) and `MonthlyTotals` (`transactions.tsx`) share the same shape (three cards, skeleton while loading, minor-unit amounts). Implementation should extract one shared totals component with NumberFlow inside rather than duplicating wiring.

Money values remain integer **minor units** end-to-end (ADR 0009). NumberFlow receives **major-unit numbers** derived at the UI boundary (`minorUnits / 10 ** decimals`) plus `Intl.NumberFormat` options and `viewerLocale()` (ADR 0021). Do not pass pre-formatted strings from `formatMoney()` into NumberFlow.

**Motion budget (fast, not flashy):**

| Surface | Duration | Notes |
| --- | --- | --- |
| NumberFlow digit spin | **200ms** | `spinTiming` with `--ease-out-quart`; NumberFlow defaults (~750ms+) are too slow |
| NumberFlow opacity | **150ms** | `opacityTiming`, `ease-out` |
| Recharts bars + line | **200ms** | `animationDuration={200}` on `Bar`/`Line` in `cash-flow-trend.tsx`; default is **1500ms** — never use default |
| Recharts easing | `ease-out` | Recharts `animationEasing="ease-out"` |

Gate Recharts with `usePrefersReducedMotion()` from `~/lib/motion.ts` — not `@number-flow/react`'s export, which reads a module-level `MediaQueryList` that is null under jsdom/SSR and throws on `.matches`. NumberFlow digits still honor motion via `respectMotionPreference`. Chart SVG stays `aria-hidden`; sr-only table stays static.

**Cash flow chart** (`apps/web-app/app/components/cash-flow-trend.tsx`): used on Home Summary and Dashboard month-over-month comparison. Enable fast animation here only — not other hypothetical chart surfaces.

Grouping: wrap the three totals on a given surface in `NumberFlowGroup` when all three update in the same render (currency/range/month change) so digit transitions stay synchronized.

This ADR does not add Framer Motion or other animation libraries. It does not change aggregation logic, URL ownership, or Convex queries.
