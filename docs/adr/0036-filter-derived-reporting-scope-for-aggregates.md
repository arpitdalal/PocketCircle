# Filter-derived reporting scope for list-adjacent aggregates

Aggregates that sit directly above a filtered list take their scope from that list's filter rather than hardcoding "active" Transactions. The Monthly Ledger's per-Category tagged-spend chart reads the Ledger Filter's lifecycle scope, so narrowing to `archived` shows archived Transactions, and the chart's total then deliberately disagrees with the Month Scope Totals cards above it.

## Context

PocketCircle's reporting surfaces were all built with one rule: a report counts active Transactions only, because Archived Transactions are frozen and moderation should not move reported numbers (PRD 40). That rule is implemented by `collectMonthTransactions` (defaulting to `active`) in `packages/convex/convex/monthActivity.ts`, which is the shared month-set reader behind the Dashboard, Month Scope Totals, the comparison chart, and Category analytics (RPT-5 reused it precisely so category totals could never disagree with the totals cards).

The Monthly Ledger is the first surface where an aggregate and a filtered list coexist *and* differ. Its Transaction list honours a lifecycle scope filter defaulting to `all` — archived rows are visible by default and badged — while its totals cards are active-only by contract (`apps/web-app/app/lib/data/ledger.ts`). That asymmetry already ships and is asserted (`transactions.test.tsx`, "applies ledger filters only when Apply is clicked and leaves monthly totals unchanged"). A category ranking placed above the list forces the question: does it follow the totals cards, or the rows the user can see?

## Decision

**An aggregate is either a month/circle total or a summary of a list, and it must pick one and be honest about it.**

- Totals surfaces (Dashboard, Home Summary, Month Scope Totals, comparison) stay active-only. Their scope is not filterable.
- List-derived aggregates take the list's scope. The Ledger's Category ranking reads the Ledger Filter's lifecycle scope, its type, and its Category selection, so it aggregates exactly the Transactions represented by the rows beneath it.

**Lifecycle scope filters Transactions, not Categories.** A Category is included when an in-scope Transaction is tagged with it, regardless of the Category's own status. Archived Categories therefore appear when active Transactions still use them (PRD 58) *and* when archived Transactions do, with no second code path — the analytics join has no Category-status predicate today, so widening the Transaction set widens Category scope for free.

**Each surface states its scope where it is read.** Because a filter-aware ranking beside a filter-blind totals card shows two different numbers, the ranking carries its own scope caption rather than relying on the user to infer it.

## Consequences

- `getCategoryAnalytics` gains optional `categoryIds` and lifecycle-scope arguments. The scope default stays `active`, so the Dashboard route, the MCP tool, and existing behaviour are unchanged; the MCP surface stays active-only and its published "Archived Transactions are excluded" description stays true.
- The RPT-5 "one shared month set" invariant is narrowed, not deleted: surfaces still share one reader, but a list-derived aggregate shares the *scope* as well. RPT-5's doc is amended accordingly.
- `by_circle_status_date` already supports both scopes, so no new index is required. `circleMonthTotals` stays active-only and the chart never reads it — the two aggregates are deliberately decoupled.
- The next report added to a filtered surface must decide which of the two kinds it is. Copying `collectMonthTransactions` without that decision is the mistake this ADR exists to prevent.
- A Transaction is required to have at least one Category (PRD 52), but that is enforced at the edge — the domain schema and the form — not by the Convex argument validators, which accept an empty array. Category aggregates silently drop any Transaction that reaches the data layer untagged. This is a product invariant, not a schema guarantee.

## Considered options

- **Keep the ranking active-only**, matching the totals cards and TXN-3 as previously written. Rejected: the chart would contradict the list above it, and the user has no interaction that reconciles the two, since the chart is not clickable.
- **Make the Month Scope Totals cards filter-aware too.** Rejected for now: they read a write-maintained `circleMonthTotals` row keyed by `(circle, month)` with no filter dimension. Supporting filters means abandoning the maintained read and recomputing per filter, which is a separate performance decision, not a feature.
- **Symmetric lifecycle filtering of Categories** (hide Archived Categories when scope is `active`). Rejected: it breaks PRD 58 — spending disappears from analytics for a tidier-looking view nobody asked for.
- **Filter Categories as well as Transactions** so the ranking shows only selected Categories. Accepted: rows are filtered by `categoryIds` after aggregation, which changes what the chart shows without changing what the Transaction set is.
