# RPT-5 · Category analytics

| | |
|---|---|
| **Status** | Done · [PR #213](https://github.com/arpitdalal/SpendCircle/pull/213) |
| **Labels** | `area:reporting`, `backend`, `ui` |
| **Depends on** | RPT-3 (Done · [PR #70](https://github.com/arpitdalal/SpendCircle/pull/70)) — also reuses RPT-4's chart/URL wiring (Done · [PR #86](https://github.com/arpitdalal/SpendCircle/pull/86)) |
| **PRD stories** | 58, 73 |
| **ADRs** | 0005, 0009, 0015, 0016 |
| **Glossary** | Dashboard, Category, Archived Category |

## Intent

Category spend, done honestly. Because a Transaction can carry **multiple Categories**,
category totals are **non-additive** — summing them would exceed the real spend and misrepresent
the data (PRD 73). So this is presented as **ranked tagged spend** (each Category's total = sum
of Transactions tagged with it), explicitly NOT a pie/additive breakdown. **Archived Categories
are included when active Transactions in the period still use them** (PRD 58) — spending must
not vanish because a label was archived.

This builds directly on the Dashboard surfaces shipped by RPT-3/RPT-4: the same Circle index
route ([`dashboard.tsx`](../../apps/web-app/app/routes/circle/dashboard.tsx)) and the same bounded
month-set reader. Read those first — this slice adds one backend query + one hook + one section,
mirroring what's already there.

## Implement

### Convex — new query in [`dashboard.ts`](../../packages/convex/convex/dashboard.ts)

`getCategoryAnalytics` query: args `{ circleId, month?, type? }`
(`type` = `v.optional(transactionType)` — `"expense" | "income"`).

1. `resolveCircleAccess(ctx, args.circleId)` → `null` if inaccessible/missing (ADR 0016 —
   indistinguishable, anti-enumeration; same guard the other dashboard queries use).
2. Default month: `args.month ?? currentMonth(new Date())`; throw `"Invalid month"` if
   `!isValidPlainMonth(month)` — **mirror `getDashboard` exactly** (both from `@pocketcircle/domain`).
3. Read the **same bounded active month set** the Dashboard/Ledger use — call
   `collectMonthActiveTransactions(ctx, args.circleId, month)` from
   [`monthActivity.ts`](../../packages/convex/convex/monthActivity.ts). Do **not** re-query
   `transactions` by hand; reusing this is what guarantees category totals can never disagree
   with the totals cards about which Transactions count (active-only, archived excluded — TXN-3).
4. If `type` is set, filter the returned set in memory (`txns.filter(t => t.type === type)`).
   The set is one bounded month, so an in-memory narrow is fine (README §4 forbids sorting/
   filtering *unbounded* sets, not a bounded month) — there is no month+type index and you must
   not add one. NOTE: Categories are typed and only attach to a Transaction of their own type, so
   filtering Transactions by `type` inherently yields only that type's Categories.
5. For each active Transaction in the (filtered) set, read its Category links via the
   `transactionCategories` `by_transaction` index — the **same per-row walk `toTransactionView`
   does** ([`transactions.ts`](../../packages/convex/convex/transactions.ts) ~L123). This is the
   only bounded access path: `transactionCategories` has only `by_transaction` and `by_category`
   indexes (no `by_circle`), so accumulate per-Transaction, not by scanning `by_category`.
   Accumulate into a `Map<Id<"categories">, { taggedTotalMinor, txnCount }>`: for each link add
   the Transaction's full `amountMinorUnits` to its Category's `taggedTotalMinor` and `++txnCount`.
   A multi-Category Transaction adds its full amount to *each* of its Categories (the non-additive
   property, by construction).
6. Resolve each distinct `categoryId` to `{ name, color, status }` via `ctx.db.get`. The existing
   `categoryRef` helper drops `status` (returns `{id,name,color}` only), so read the Category doc
   directly here — analytics needs `status` to badge Archived Categories. Memoize per query if you
   prefer, but the distinct-category count is already bounded by the month set.
7. Return a **ranked** list sorted by `taggedTotalMinor` **descending** (stable on ties), plus the
   Circle Currency for the edge to format: `{ rows: { categoryId, name, color, status,
   taggedTotalMinor, txnCount }[], currency }`. Money stays minor units (ADR 0009 — the edge
   formats once; never sum formatted strings). Archived-but-used Categories appear (badged via
   `status`); purely-archived-unused Categories are absent automatically (no in-period link).

### Web

- **Data hook** in [`app/lib/data/dashboard.ts`](../../apps/web-app/app/lib/data/dashboard.ts):
  add `useCategoryAnalytics` mirroring `useDashboard`/`useMonthlyComparison` — derive the view
  type from `FunctionReturnType<typeof api.dashboard.getCategoryAnalytics>` (no hand-written
  contract — ADR 0003 drift-proofing), honour the `MOCKS` fixture + `"skip"` path, and accept the
  same `{ month, enabled }` options.
- **Fixture** in [`app/lib/fixtures.ts`](../../apps/web-app/app/lib/fixtures.ts): a
  `MOCK_CATEGORY_ANALYTICS` alongside `MOCK_DASHBOARD` for mock mode.
- **Render** a new section in [`dashboard.tsx`](../../apps/web-app/app/routes/circle/dashboard.tsx):
  a ranked bar/list (Recharts horizontal bars or a plain list — ADR 0005 owns the chart stack)
  labelled as **tagged spend**, with a short note that totals are **non-additive** (a Transaction
  counts toward every Category it carries). Format money via the viewer locale + Circle Currency
  (`formatMoney`/`money`, the existing pattern in this file), badge Archived Categories distinctly,
  and identify Categories by **name/legend, not color alone** (CONTEXT a11y rule the comparison
  chart already follows).
- **Month scope:** the Dashboard currently has **no month picker** — the route hardcodes
  `currentMonth(new Date())` and passes it to every query. So `month` here is just the local
  current month for now; the `month?` arg exists for parity/future month navigation, not a new UI
  control in this slice. If you add a `type` toggle (expense vs income ranking), put it in the URL
  via `dashboard-url.ts` (URL-as-state policy), not component state.

## Why this way

- **Non-additive by construction:** compute per-Category tagged totals; never present a
  whole-equals-sum-of-parts chart. A multi-category Transaction contributes its full amount to
  *each* of its Categories — document this in the UI so it isn't read as additive.
- **One shared month set:** routing through `collectMonthActiveTransactions` means the category
  ranking, the totals cards (RPT-3), and the comparison chart (RPT-4) can never drift on what a
  Circle-month contains.
- **Archived-but-used included** so historical spend stays visible (PRD 58); purely-archived-
  unused Categories are omitted because they have no in-period link.

## How to test

Convex query tests go in `packages/convex/convex/dashboard.test.ts` (real backend logic, no
mocked seams — ADR 0006). Web route/hook tests drive through the shared
[`app/test/convex/dashboard.ts`](../../apps/web-app/app/test/convex/dashboard.ts) double — add a
zero/default `getCategoryAnalytics` reply there (mirror `EMPTY_DASHBOARD`) so existing Dashboard
tests that don't drive the ranking still render it; never redefine per-file scaffolding (CLAUDE.md).

- **Non-additive correctness:** a Transaction tagged with Categories A and B contributes its
  full amount to both A and B totals; the sum of category totals can exceed total spend — assert
  this is expected, and that total spend (RPT-3 `sumMonthTotals`) is unchanged.
- **Ranking:** categories ordered by tagged total desc; ties stable.
- **Archived inclusion:** an Archived Category still attached to in-period active Transactions
  appears (badged via `status`); an Archived Category with no in-period active Transactions is
  excluded.
- **Filters:** `type` and `month` narrow correctly; archived Transactions are excluded from the
  math (collected set is active-only).
- **Access:** non-member / missing Circle → `null` (ADR 0016).

## Done when

- Ranked, non-additive tagged category spend in minor units, including archived-but-used
  categories, filterable by month/type, clearly not presented as additive; the surface reuses the
  shared month-set reader; tests green; gates pass.

## Out of scope

Totals/recent (RPT-3); month-over-month (RPT-4); drilldowns (RPT-6 — clicking a Category to a
filtered Ledger is wired there, not here).
