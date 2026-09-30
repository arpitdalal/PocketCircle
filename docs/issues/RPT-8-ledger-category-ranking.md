# RPT-8 · Monthly Ledger Category Ranking

| **Status**      | Proposed                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Labels**      | `area:reporting`, `backend`, `ui`                                                                                                                            |
| **Depends on**  | RPT-1 (Monthly Ledger), RPT-5 (Category analytics, Done · [PR #213](https://github.com/arpitdalal/PocketCircle/pull/213)), TXN-3 (archive lifecycle)             |
| **PRD stories** | 95 (new), 58, 40, 41, 73                                                                                                                                  |
| **ADRs**        | 0005, 0009, 0015, 0016, 0032, 0036                                                                                                                            |
| **Glossary**    | Monthly Ledger, Ledger Filter, Category Ranking, Category, Archived Category, Archived Transaction                                                             |
| **Issue**       | [#421](https://github.com/arpitdalal/PocketCircle/issues/421)                                                                                                 |

## Intent

The Circle Dashboard already shows a per-Category ranking of the current month (RPT-5). It has no
month navigation — the Dashboard is deliberately current-month only, and RPT-6 removed month
navigation from it on purpose so two month affordances could not drift (ADR 0032). A user who wants
to know where a *specific* month went has to open the Ledger and use `MonthNavigator`, and there is
no Category view there at all.

Add a per-Category ranking to the **Monthly Ledger**, above the Transaction list, scoped to the
Ledger's own month and filter. It is the surface that already has month navigation, so this adds no
second month affordance and reverses no recorded decision.

Per [ADR 0036](../../docs/adr/0036-filter-derived-reporting-scope-for-aggregates.md) the ranking is
**list-derived**: it takes scope from the Ledger Filter, so it disagrees with the filter-blind Month
Scope Totals cards by design and says so.

## Not in scope

- **Month navigation on the Dashboard.** Unchanged. RPT-6's decision stands; the Ledger is where
  months are navigated.
- **Making the Month Scope Totals cards filter-aware.** They read a write-maintained
  `circleMonthTotals` row keyed `(circle, month)` with no filter dimension. Supporting filters means
  abandoning the maintained read — a separate performance decision, not this slice.
- **MCP.** `get_category_analytics` stays active-only. Its published description
  (`mcp-api.ts:541`) stays true and no MCP arg schema changes.
- **Unifying the two presentations.** The Dashboard keeps its clickable ranked list and remains the
  only path to a category-filtered Ledger. Revisit once we know which surface gets used.
- **The `MonthNavigator` extraction.** It stays inline in `transactions.tsx`; it is not reused.

## Convex

### Extend `getCategoryAnalytics` — do not add a second query

Add two optional args to the existing query in
[`dashboard.ts`](../../packages/convex/convex/dashboard.ts) and the aggregator in
[`operations.ts`](../../packages/convex/convex/operations.ts). One owner, one signature; the
Dashboard route, the MCP adapter, and every existing test keep working because both args are
optional and both default to today's behaviour.

`getCategoryAnalytics` args become `{ circleId, month?, type?, categoryIds?, status? }`.

1. **`status`** — `v.optional(v.union(v.literal("active"), v.literal("archived")))`, **defaulting to
   `"active"`.** Thread it into `collectMonthTransactions(ctx, circleId, month, status)`.
   The existing `collectMonthActiveTransactions` becomes the `status = "active"` case of a
   status-parameterised reader; `by_circle_status_date` (`schema.ts:190`) already serves both
   scopes, so **no new index**. The default stays `active` so `mcpApproval.test.ts:1569` and
   `dashboard.test.ts:858` stay green.
2. **`categoryIds`** — `v.optional(v.array(v.id("categories")))`. Applied **to the accumulated
   rows, after aggregation**, not to the Transaction set. Filtering the Transaction set would
   silently drop Categories; filtering rows shows the selected Categories' totals.

### Archived Categories come free

The analytics join (`operations.ts:182-185`) has **no Category-status predicate** — the only thing
gating an Archived Category out today is the Transaction filter at `operations.ts:173`. Widening
the Transaction set therefore widens Category scope with no second code path. Under
`status: "archived"`, an Archived Category tagged only on archived Transactions appears, with its
`status` passed through for the UI badge as it is today.

Lifecycle scope filters **Transactions only**. Filtering Categories symmetrically would hide an
Archived Category that active Transactions still use, which is the exact failure PRD 58 exists to
prevent.

### `type` is driven by the Ledger filter

`type` stays `v.optional(transactionType)`. **Do not** pass `undefined` for `type: "all"`:
`operations.ts:174` would keep both types in one set sorted by raw amount, so a salary outranks all
groceries. When the Ledger filter is `all`, make **two calls** — `type: "expense"` and
`type: "income"` — and render the diverging chart. Each reuses the existing tested sorter. Two
month-bounded queries beat duplicating `compareCategoryAnalyticsSort` in the web app.

## Web app

### Route

Add the ranking block to [`transactions.tsx`](../../apps/web-app/app/routes/circle/transactions.tsx)
between `MonthScopeTotalsCards` and `TransactionList` (`:218`–`:226`), matching the Dashboard's
totals-then-ranking order. The route is a single `space-y-6` scroll column with
`keepScrollSearchParamsOptions` on filter writes, so a filter change preserves scroll. Stream
pagination cursors are internal to the list query and are unaffected by sibling content.

The FilterPanel is portalled/modal, so it occupies no vertical space regardless of state.

### Chart

**Vertical bars, diverging from a zero baseline** — income above, expense below. One component,
three states, driven by the Ledger's `type` filter, and it establishes no new dual-type surface
beyond the diverging presentation.

- Reuse the shell from
  [`cash-flow-trend.tsx`](../../apps/web-app/app/components/cash-flow-trend.tsx): `React.lazy`
  split, `aria-hidden` visual plus an **sr-only `<table>` as the accessible reading**,
  `useScopeChangeMotion`, `usePrefersReducedMotion`, and `initialDimension` for mobile. Do not
  invent a second a11y pattern in the same app.
- Bars are independent magnitudes, **not** parts of a whole. A pie or donut is wrong here: a
  Transaction's whole amount is attributed to every Category it carries, so the parts do not sum to
  the period's spend and slice angles would misrepresent it. Horizontal bars were rejected because
  N rows is the vertical space the ranking is meant to save.
- **Archived Categories get a hatched fill** via `<defs><pattern>` plus a badge in the tooltip and
  the sr-only table. The current list marks them with a badge; a chart has nowhere to put one, and
  the a11y rule is never identify by colour alone.
- Use `useStableQuery` (as `useMonthlyComparison` does) so the chart stays mounted across filter
  changes instead of flashing a skeleton. Include `month` in any `scopeKey` that should re-animate
  on month change.

### Two captions, both required

The page shows two different numbers on purpose, so each block states its own scope:

- Ranking header: non-additivity (a Transaction counts its full amount toward each of its
  Categories) **and** the lifecycle scope in view.
- Month Scope Totals cards keep their existing behaviour and wording; the totals stay month-wide.

### No interaction

The chart is **not clickable**. The Dashboard's list remains the only path to a category-filtered
Ledger, and filtering still happens through `FilterPanel`. Do not add row toggles or an
`aria-pressed` affordance.

## Tests

Convex (`packages/convex/convex/`):
- `status: "archived"` returns only archived-Transaction totals; `status: "all"` returns active +
  archived; omitting `status` still returns active-only (regression guard for `dashboard.test.ts:858`
  and `mcpApproval.test.ts:1569`).
- An Archived Category tagged **only** on archived Transactions appears under `status: "archived"`.
- `categoryIds` filters rows, and an unknown id yields an empty row set rather than an empty page.
- `getMonthlyLedger` totals stay active-only under every `status` (ADR 0016/0036 split).

Web (`apps/web-app/app/routes/circle/transactions.test.tsx`): the block renders from the Ledger
filter, re-queries on `month`/`type`/`status`/`categories` changes, and the totals cards stay put
while the chart narrows (extend the existing "leaves monthly totals unchanged" test).

E2E (`e2e/transactions.spec.ts`): narrow lifecycle scope to `archived` and assert the chart changes
while the totals card does not. No archived-analytics E2E exists today.

**Test-double footgun:** both routes call `dashboard.getCategoryAnalytics`, so resolve the slot in
`test/convex/dashboard.ts` and **do not** register it in `test/convex/ledger.ts` — doubles merge
with `Object.assign` and `dashboardDouble` is applied after `ledgerDouble`
(`test/convex/core.ts:46-47`), so a second registration would be silently overwritten in one order
and clobber the other.

## Docs amended with this slice

- [ADR 0036](../../docs/adr/0036-filter-derived-reporting-scope-for-aggregates.md) — new.
- `CONTEXT.md` — **Category Ranking** (new term), Monthly Ledger, Ledger Filter, Archived
  Transaction, Dashboard.
- `docs/prd/v1.md` — story 95 (new), story 40, story 58, the constraints block line that wrongly said
  archived Transactions were excluded from default Ledger Filter and Search, testing decisions.
- [`RPT-5`](RPT-5-category-analytics.md) — the "one shared month set" invariant is narrowed: one
  reader, per-surface scope.
- [`TXN-3`](TXN-3-archive-transaction.md) — reporting contract gains the list-derived clause.

## Done when

- The Monthly Ledger shows a per-Category ranking for the selected month above the Transaction list.
- The ranking reflects the Ledger Filter's month, type, lifecycle scope, and Category selection; the
  month's Income, Expenses, and Net do not move with the filter.
- Under `type: "all"` the chart diverges from a zero baseline with income and expense on opposite
  sides; under a single type it renders one-sided.
- Archived Categories are distinguishable in the chart, not only in the sr-only table.
- The chart is keyboard-inert, and the sr-only table carries every value the visual shows.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; the Dashboard and MCP surfaces are unchanged.
