# RPT-2 · Search

| | |
|---|---|
| **Status** | Done · [PR #79](https://github.com/arpitdalal/PocketCircle/pull/79) |
| **Labels** | `area:reporting`, `backend`, `ui` |
| **Depends on** | TXN-1, RPT-1 |
| **PRD stories** | 41, 65, 66, 67 |
| **ADRs** | 0009, 0015, 0016, 0021 |
| **Glossary** | Ledger Filter, Transaction Search, Archived Transaction, Archived Category, Removed Member |

## Intent

Split the original Search surface into a lightweight **Ledger Filter** on Transactions and a
dedicated **Transaction Search** route. Ledger Filter narrows the selected **Monthly Ledger**
month only. Transaction Search is a top-level Circle page for finding Transactions across the
Circle with explicit date range or all-time scope. Both surfaces filter text by Title and Note
only; Category is a structured filter, not a second text-matching path. Default lifecycle scope is
all; archived Transactions are shown by default but visually distinguished (muted title, "Archived"
badge) so the full history is visible without filtering while active and archived rows remain
easy to tell apart. Users can narrow to active-only or archived-only via the status filter.

## Implement

- **Convex**:
  - Add a month-bound Ledger Filter query. Args include `{ circleId, month, query?, categoryIds?,
    recordedByMemberIds?, paidByMemberIds?, status: "active"|"archived"|"all",
    type: "all"|"expense"|"income" }`. It can share predicate helpers with Transaction Search,
    but the public contract must not accept date range or all-time scope.
  - Keep Transaction Search as a Circle-scoped paginated query. Args include `{ circleId, query?,
    type: "all"|"expense"|"income", categoryIds?, recordedByMemberIds?, paidByMemberIds?,
    dateFrom?, dateTo?, amountMin?, amountMax?, status: "active"|"archived"|"all" }`. Empty date
    range means all-time. Query the best source index for non-text filters. For non-empty text,
    use the Transaction search projection (synced transactionally on create/edit/archive/restore).
  - Text predicates match Title and Note only, case-insensitively with whitespace runs normalized.
    Category matching happens only through category IDs.
  - Multi-select filters use OR within a field and AND across fields. Category multi-select is OR;
    member multi-selects are OR. Text is ANDed with all structured filters.
  - Date and amount ranges are inclusive. UI prevents reversed ranges; hand-written reversed ranges
    return an empty result rather than an error.
  - Ledger Filter options come from Transactions in the selected month. Category options ignore
    current status, follow selected type, and include active or Archived Categories actually used
    that month. Member options ignore current type/status and include current or Removed Members
    actually used that month.
  - Transaction Search options are exhaustive for the Circle: all Categories, including archived,
    and all Members ever present in the Circle, including Removed Members. Category options follow
    selected type; Member options do not narrow by type/status/date.
  - No search metadata totals/counts query is needed. Ledger totals remain monthly totals, and
    Transaction Search shows no totals cards.
- **Web:** Add top-level Circle route `/circles/:circleRef/search` and Circle nav item `Search`.
  Transactions keeps a responsive Ledger Filter panel opened from a Filter button: desktop sidebar,
  mobile bottom sheet, source-owned local primitive based on Radix Dialog semantics. Transaction
  Search uses the same panel pattern for advanced filters, with `q` visible on the page. Both
  surfaces use draft state and only query/write the URL on Apply/Search; Reset immediately writes
  canonical defaults.
  Search results reuse the transaction row presentation, but Search does not show totals cards.
  Multi-select controls are searchable combobox-style inputs with checkboxes and removable
  selections.
  Unknown selected IDs are dropped from the URL after options load.

## Why this way

- **Ledger Filter stays month-bound** so the Transactions page remains a Monthly Ledger, not an
  advanced search page.
- **Transaction Search is Circle-scoped** so cross-month discovery is explicit and has room for
  advanced filters.
- **Lifecycle status is tri-state** because users need active-only, archived-only, and all results.
- **Category is structured only** so the same concept is not filtered through two mechanisms.
- **URL defaults are explicit for tri-state controls** so shared links reproduce lifecycle/type
  scope without hidden defaults.
- Amounts are compared in minor units.
- **Text query order follows full-text relevance.** Default/no-text results stay Transaction Date
  desc, but once `q` is non-empty Convex's search index owns pagination order; do not promise
  date-desc ordering for text results.
- The Transaction search projection is an operational index: public create/edit/archive/restore
  mutations sync it transactionally. PocketCircle is pre-production, so no one-time backfill is
  required for rows created before the projection existed.

## Carry Forward from PR #79

- Keep the root backend fix for filtered pagination: collect after filtering until the requested
  page is full or the source is exhausted.
- Keep the root performance fix that avoids computing totals/search metadata through full
  Transaction views; the redesigned surface should remove metadata totals entirely.
- Keep the inactive-query discipline: Ledger Filter and Transaction Search queries run only for
  the applied URL state they own, not while users draft filters.
- Keep URL ownership tests around canonical defaults, reset behavior, and month-change filter
  reset.
- Keep exact date and amount range edge tests: inclusive bounds, reversed hand-written ranges
  yielding empty results, and minor-unit amount comparison.

## How to test

- **Ledger Filter:** canonical URL includes `month`, `status=all`, and `type=all`; selected
  month only; month change resets Ledger Filter-owned params back to defaults; text matches
  Title/Note; category/member/status/type filters combine; option lists are sourced from that
  month’s Transactions only; archived rows show a visual badge and muted title.
- **Transaction Search:** canonical URL includes `status=all` and `type=all`; default URL
  searches all Circle Transactions (active and archived) newest-first, with archived rows
  visually distinguished; exact date range narrows inclusively; empty date range means all-time;
  text matches Title/Note and is ordered by full-text relevance; type, Category, Recorded By, Paid
  By, lifecycle status, and amount range combine.
- **URL encoding:** `q`, `type`, `status`, comma-separated `categories`, comma-separated `paidBy`,
  comma-separated `recordedBy`; Transaction Search only also owns `from`, `to`, `min`, `max`.
  Multi-select IDs are written in stable sorted order; trimmed empty `q` is omitted.
- **Submit behavior:** editing fields does not query; Ledger Filter applies on Apply, and
  Transaction Search applies on Search. Reset immediately navigates to canonical defaults.
- **Pagination:** filtered pages are filled after filtering; no empty intermediate pages while
  additional matches exist.
- **Lifecycle status:** active, archived, and all each return the expected Transactions on both
  surfaces.
- **Filter sources:** Ledger Filter shows only values used in the selected month; Transaction
  Search shows every Category and every Member ever present in the Circle.
- **Amount edges:** min only, max only, min==max, min>max (empty result, no error); minor-unit
  comparison correctness.
- **Access:** non-member → `null`; archived Circle searchable (view-only).
- **E2E:** exercise Transactions canonical defaults, opening the responsive Ledger Filter, applying
  and resetting filters, month-change reset, Search route canonical defaults, advanced Search
  submit/reset, status/type/date/amount filters, and opening a Search result detail.

## Done when

- Transactions has a collapsed month-bound Ledger Filter; `/search` is a top-level Circle page for
  advanced Transaction Search; URL state is reproducible; filtered pagination is correct;
  comprehensive unit, integration, and E2E tests are green; gates pass.

## Out of scope

Dashboard charts/analytics (RPT-3/4/5); export (EXP-1, though it may reuse the filter shape).
</content>
