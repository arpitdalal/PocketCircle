# RPT-6 · Dashboard drilldowns

|                 |                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Done                                                                                                                                                                                                              |
| **Labels**      | `area:reporting`, `ui`                                                                                                                                                                                            |
| **Depends on**  | RPT-1 (Done), RPT-2 (Done), RPT-3 (Done), RPT-4 (Done · [PR #86](https://github.com/arpitdalal/PocketCircle/pull/86)), RPT-5 (Done · [PR #213](https://github.com/arpitdalal/PocketCircle/pull/213)) — all merged |
| **PRD stories** | 74                                                                                                                                                                                                                |
| **ADRs**        | 0005, 0016, 0017                                                                                                                                                                                                  |
| **Glossary**    | Dashboard, Monthly Ledger, Ledger Filter                                                                                                                                                                          |

## Intent

Charts should lead to the underlying records (PRD 74): clicking a Dashboard chart navigates to
the **Monthly Ledger** with a **Ledger Filter** pre-filled to match — turning a summary into a
list you can act on. This is a **pure UI-wiring slice**: no new backend, no new query. The data
and both destinations already exist (RPT-1's Ledger, RPT-2's filter codec, RPT-5's category rows).

One drilldown source remains on the Dashboard today
([`dashboard.tsx`](../../apps/web-app/app/routes/circle/dashboard.tsx)) — wire it to the Ledger:

1. **A category row** in the category analytics list (RPT-5,
   [`dashboard-category-analytics.tsx`](../../apps/web-app/app/routes/circle/dashboard-category-analytics.tsx))
   → the **current-month Ledger narrowed to that Category** (and the same Income/Expense `type`
   the analytics list is currently showing).

### Month-over-month comparison chart — no drilldown

The month-over-month comparison chart (RPT-4,
[`dashboard-comparison-chart.tsx`](../../apps/web-app/app/routes/circle/dashboard-comparison-chart.tsx))
is **read-only**. It renders an `aria-hidden` Recharts SVG plus an `sr-only` data table (one row per
month) so screen readers get the same numbers as sighted users. There is **no** month-bar
drilldown — no visible month links, no `onClick` on bars, no pointer cursor.

**Why:** RPT-6 originally shipped a month-bar drilldown (visible `<nav>` links + mouse `onClick` on
bars). That duplicated the Ledger's **MonthNavigator** for reaching past months, and the two
affordances drifted (mouse-only bar clicks vs keyboard/SR paths). Removing all comparison-chart
navigation gives **mouse = keyboard = SR** (none drill down from the chart), eliminates the WCAG
parity gap, and keeps the chart purely presentational. Users open the Ledger tab and use
MonthNavigator when they need another month.

### Not in this slice (already shipped or no such element)

- **Recent Transaction → detail is already done.** `RecentRow` in
  [`dashboard.tsx`](../../apps/web-app/app/routes/circle/dashboard.tsx) already links each recent
  row's title to the TXN-4 detail route with a validated `returnTo`. Do **not** rebuild it.
- **Member-specific Dashboard reporting is out of scope.** The Dashboard is Circle-wide; the
  Monthly Ledger and Transaction Search provide Member-specific investigation.

## Implement

**Web only.** No Convex, no `data.ts`, no fixture changes — this slice adds zero queries.

### The drilldown href: translate Dashboard scope → Ledger Filter URL

The two routes use **different URL codecs** — this is the one non-obvious part. Build a _Ledger_
URL, never reuse the Dashboard's params:

- Dashboard codec ([`dashboard-url.ts`](../../apps/web-app/app/lib/dashboard-url.ts)): `range`
  plus `type` (`expense`/`income`).
- Ledger codec
  ([`transaction-filter-url.ts`](../../apps/web-app/app/lib/transaction-filter-url.ts)): `month`,
  `q`, `type` (`all`/`expense`/`income`), `status` (`active`/`archived`/`all`), and **array**
  params `categories[]`, `recordedBy[]`, `paidBy[]`.

Build the link with the existing helpers (do not hand-roll query strings):

```ts
import {
  canonicalLedgerParams,
  defaultLedgerFilters,
} from "~/lib/transaction-filter-url.js";
import { circlePath } from "~/lib/circle-path.js";
import { withQuery } from "~/lib/ledger-url.js";

function ledgerDrilldownHref(circle, { month, categoryId, type }) {
  const filters = defaultLedgerFilters(month); // month + empty filters
  if (categoryId) filters.categories = [categoryId]; // single id → ledger's array param
  if (type) filters.type = type; // "expense" | "income" (else default "all")
  return withQuery(
    circlePath(circle.ref, "transactions"),
    canonicalLedgerParams(filters).toString(),
  );
}
```

- A **category-row** drilldown: `{ month: currentMonth(new Date()), categoryId: row.categoryId,
type: selection.type }` — `selection.type` comes from `readDashboardSelection(searchParams)` and
  matches the analytics query.
- `defaultLedgerFilters` already leaves `status: "all"`, so archived Transactions appear in the
  drilled-in Ledger marked as archived — same as opening the Ledger directly (CONTEXT: Ledger
  Filter lifecycle defaults to all).

These are plain in-app navigations (a top-level list route, not an object route), so use a React
Router `<Link>` and **no `returnTo`** — browser Back returns to the Dashboard naturally.
`returnTo` is only for object routes that need an explicit close target (the recent-row → detail
link, already shipped).

### Accessible affordances

- **Month-over-month comparison** — presentational only. The Recharts surface is `aria-hidden`; the
  `sr-only` table is a non-interactive data equivalent for screen readers. Do not add links or
  `onClick` handlers to the chart.
- **Category rows** — each row is a `<li>`. Wrap the category **name** in a `<Link>` (mirroring how
  `RecentRow` wraps the Transaction title), with an `aria-label` like `View {name} transactions`.
  The bar stays `aria-hidden`. Native `<a>` = keyboard-operable for free.

Keep money formatting, archived badges, and non-additive copy exactly as RPT-4/RPT-5 left them —
this slice only adds links (category rows), it does not restyle the charts.

## Why this way

- **Filters live in the URL** (ADR 0016, ADR 0017), so a drilldown is a real navigation: the
  resulting Ledger reads its filter from the URL, reload preserves it, and Back returns to the
  Dashboard. No ephemeral component state, no new state machine.
- **Reuse the Ledger codec, don't translate by hand.** `defaultLedgerFilters` +
  `canonicalLedgerParams` are the single home for the Ledger param vocabulary; building the href
  through them means a drilldown URL can never diverge from a URL the Ledger itself would produce
  (defaults omitted, ids in the canonical array shape).
- **Comparison chart stays presentational.** Drilldown on `aria-hidden` SVG bars created unequal
  mouse vs keyboard/SR paths; past-month navigation belongs on the Ledger's MonthNavigator.
- **No backend.** The destinations already serve these filters (RPT-1/RPT-2); adding a query would
  duplicate them.

## How to test

Web route/render tests in `apps/web-app/app/routes/circle/*.test.ts(x)`, driving through the shared
[`app/test/convex/dashboard.ts`](../../apps/web-app/app/test/convex/dashboard.ts) double — never
redefine per-file scaffolding (CLAUDE.md). No new Convex tests (no backend change).

- **Category-row navigation:** the category name link points at the current-month Ledger with
  `categories=<id>` and the current analytics `type` (`expense`/`income`); the destination filters to
  that Category.
- **Comparison chart accessibility:** the chart SVG is `aria-hidden`; the `sr-only` data table has
  one row per month with formatted values and **no** interactive elements (no links, no buttons).
- **URL state round-trips:** the drilled-in Ledger reads its filter from the URL; reloading preserves
  it (true by construction — it's in the URL); Back returns to the Dashboard.
- **Empty/loading states unchanged:** with no comparison series / no category rows, there is nothing
  to link and the existing empty/skeleton states still render (no crash building hrefs from an empty
  list).
- **E2E** (extend an existing reporting spec; ADR 0019): Dashboard → click a category drilldown →
  land on the Ledger filtered to that Category and see the matching records.

## Done when

- A category row drills into the current-month Ledger filtered to that Category and analytics type;
  the comparison chart has no drilldown (presentational SVG + non-interactive `sr-only` table);
  filters live in the URL (deep-linkable, reload-safe, Back-friendly); category drilldown is
  keyboard/screen-reader accessible; tests green; gates pass
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

- The chart math and surfaces themselves (RPT-3 totals, RPT-4 comparison, RPT-5 category analytics),
  and the Monthly Ledger + Ledger Filter (RPT-1/RPT-2) — all reused, not rebuilt.
- **Month-bar drilldown from the comparison chart** — removed; use Ledger MonthNavigator for other
  months ([issue #218](https://github.com/arpitdalal/PocketCircle/issues/218), [PR #221](https://github.com/arpitdalal/PocketCircle/pull/221)).
- **Recent Transaction → detail** — already shipped in `RecentRow` (`dashboard.tsx`).
- Member-specific Dashboard reporting.
- Any new backend query, fixture, or `data.ts` hook — this slice wires existing reads.
