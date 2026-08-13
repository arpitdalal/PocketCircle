# RPT-7 · Fix multi-paginate crash in Transaction Search / Ledger Filter

|                 |                                                                          |
| --------------- | ------------------------------------------------------------------------ |
| **Status**      | Done · [PR #95](https://github.com/arpitdalal/PocketCircle/pull/95)      |
| **Labels**      | `area:reporting`, `backend`, `bug`                                       |
| **Depends on**  | RPT-2, CAT-4                                                             |
| **PRD stories** | 41, 65, 66, 67 (keeps the RPT-2 surfaces working at scale; no new story) |
| **ADRs**        | 0006, 0015, 0016                                                         |
| **Glossary**    | Ledger Filter, Transaction Search                                        |

## Intent

`collectTransactionViews` in `packages/convex/convex/search.ts` — the shared read behind
**`filterLedgerTransactions`** (Ledger Filter) and **`searchTransactions`** (Transaction
Search) — fills a result page by looping: paginate one source page off the index, apply the
in-handler predicates (text, type, Category, amount), and if the page isn't full yet,
**paginate again** from the continue cursor. The real Convex backend permits only **one**
`.paginate()` call per query execution; the second iteration throws

> `This query or mutation function ran multiple paginated queries. Convex only supports a
single paginated query in each function.`

convex-test does **not** enforce this restriction, so the unit suite is green — the bug
only surfaces against a real backend, whenever the filters are sparse enough that the first
source page can't fill the requested page. Concretely: searching a term matching few
Transactions in a Circle whose month/window holds more than one page of rows crashes the
query, and `usePaginatedQuery` surfaces the error boundary ("Something went wrong"). Dense
matches (most current E2E flows) never hit the second iteration, which is why it shipped.

CAT-4 hit this exact wall building `filterCategories` on the same loop shape and fixed it
with `convex-helpers` streams (see [PR #93](https://github.com/arpitdalal/PocketCircle/pull/93));
this slice applies the same fix to the Transaction reads.

## Implement

- **`search.ts`**: rework `collectTransactionViews` onto `convex-helpers/server/stream`
  (already a direct dependency of `packages/convex` since CAT-4 — the
  `filterCategories` handler in `categories.ts` is the in-repo reference):
  - Build the source as `stream(ctx.db, schema).query("transactions").withIndex(...).order("desc")`,
    choosing the same index `pageByWindow` chooses today (the single-Paid-By /
    single-Recorded-By / status / date-window specializations).
  - Apply `matchesFilters` through `.filterWith(...)`, then `.paginate(paginationOpts)`
    **once**. Map the page through `toTransactionView` after pagination, exactly as today.
  - `mergedStream` (same module) can replace the index-specialization branches if that
    simplifies — but preserving today's index selection with a plain `stream` per branch is
    enough; don't widen the rework.
  - The per-row caches (`newViewCaches`, `newSearchCaches`) stay: `filterWith` runs the
    same predicate the loop ran, including the Category-link lookups.
- **No schema change.** The indexes already carry the sort keys.
- **Client** (`data.ts`): point `useLedgerTransactionFilter` and `useTransactionSearch`
  at `usePaginatedQuery` from **`convex-helpers/react`** (drop-in signature). Stream
  pagination has no journal, so the native `convex/react` hook cannot pin page ends —
  reactive changes after a `loadMore` can skip or duplicate boundary rows; the helper
  hook passes `endCursor` back to keep pages contiguous. CAT-4's `useCategoriesPage`
  (PR #93 review fix) is the reference, including the `convex-helpers/react` test double
  in `apps/web-app/app/test/convex-react.tsx`. Args and page shape are otherwise
  unchanged — `paginationOptsValidator` already carries `endCursor` into
  `stream.paginate()`.

## Why this way

- **Streams, not short pages** — returning whatever the single source page yielded after
  filtering would be legal but breaks the "no empty intermediate page while further matches
  exist" contract RPT-2 promised and CAT-4 reaffirmed; streams fill the page reading the
  same index ranges via `take` under the hood.
- **Don't hand-roll cursors** — a bespoke createdAt/\_creationTime continuation re-implements
  what `convex-helpers` already maintains, without the journal-adjacent edge handling.
- **One fix, one slice** — this deliberately changes no filter semantics, no args, no UI.
  Identical inputs must produce identical pages (modulo cursor encoding).

## How to test

- **Regression (the crash):** convex-test can't reproduce the throw (it doesn't enforce the
  restriction), so encode the _behavior_ it implies: seed sparse matches — e.g. 12+
  Transactions where every other row matches the text query — and assert a small-numItems
  page comes back **full** of matches with a working continue cursor, on both
  `filterLedgerTransactions` and `searchTransactions`, on the status-index and
  date-window paths. Then verify the crash itself is gone against the real backend:
  an E2E search whose term matches sparsely across more than one source page (seed in a
  dedicated Circle — see the CAT-4 spec's isolation note — and mind the per-month source
  windows when seeding the ledger path).
- **No-change contract:** the existing `search.test.ts` suite passes untouched (same pages,
  same order for the pre-GH-91 non-text path, same anti-enumeration empty page for an
  inaccessible Circle, same `hasOnlyUnknownIds` and invalid-filter behavior).
- **Pagination invariants (README §5.10):** first page bounded, `continueCursor` continues
  without gaps or duplicates across the boundary, exhaustion reports `isDone` (a trailing
  empty done page when the page fills exactly at the source's last row is acceptable —
  the CAT-4 contract).
- **Specialized index paths:** single Paid-By + status, single Recorded-By + status,
  status-only, and unscoped date-window paths each paginate and filter correctly.

## Done when

Both Transaction read queries fill filtered pages through a single paginate per execution;
a sparse text search over a multi-page window succeeds against the real backend (E2E);
the existing search suite is green unchanged; new sparse-match pagination tests cover both
queries and the main index paths; gates pass.

## Out of scope

Any change to filter semantics, search args, or the search/ledger UI. The Category Filter
(CAT-4) already uses streams. Performance work beyond removing the crash (e.g.
`maximumRowsRead` tuning) — note it in the PR if it becomes relevant, don't bundle it. GH-91
later moves non-empty Transaction text queries to Convex full-text relevance order.
