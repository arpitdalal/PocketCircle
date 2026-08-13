# RPT-3 · Dashboard totals

| | |
|---|---|
| **Status** | Done · [PR #70](https://github.com/arpitdalal/PocketCircle/pull/70) |
| **Labels** | `area:reporting`, `backend`, `ui` |
| **Depends on** | TXN-1 |
| **Unlocks** | RPT-4, RPT-5, RPT-6 |
| **PRD stories** | 68, 75 |
| **ADRs** | 0009, 0015, 0016 |
| **Glossary** | Dashboard |

## Intent

The Dashboard is **per Circle** (PRD 68) — one Circle's finances never mix with another's. V1
shows current-month Income, Expenses, Net, **recent Transactions** (PRD 75), and totals
for all Members. Only **active** Transactions count (archived excluded). This slice is the totals
and recent surface; charts (RPT-4) and category analytics (RPT-5) build on it.

## Product decision update — Dashboard Paid By removed (2026-06-22)

The original implementation included a Paid By filter (PRD 69) so Members could inspect one
person's activity. RPT-6 review exposed that the Dashboard's comparison spans several months but
the Monthly Ledger's filter options are deliberately month-scoped: drilling from a zero-value
month could silently broaden the result from one Member to all Members. Preserving the filter would
require a Ledger exception that weakens its month-local discovery model.

The filter is removed rather than patched. V1 Dashboard reporting is Circle-wide; the Monthly
Ledger and Transaction Search remain the Member-specific investigation surfaces. A future Dashboard
reporting design may reintroduce Member filtering only alongside explicit, shared time controls.

## Implement

- **Convex** new `packages/convex/convex/dashboard.ts`:
  - `getDashboard` query: args `{ circleId, month? }`. `resolveCircleAccess` →
    `null` if inaccessible → default month = current → query active Transactions for the month
    → compute income/expense/net in minor units →
    fetch recent active Transactions (e.g. latest N by createdAt) → return `{ totals, recent,
    currency, month }`.
- **Web:** Dashboard route showing the totals cards and a recent-Transactions list linking to
  Transaction detail (TXN-4). Derive view types; fixtures + `useDashboard`.

## Why this way

- **Per-Circle, active-only, minor-units** — the same money discipline as the Ledger; reuse the
  totals helper if extracted in RPT-1.

## How to test

- **Totals:** income/expense/net correct in minor units for the month; archived excluded; empty
  month → zeros.
- **Recent:** returns most-recent active Transactions, correct order, excludes archived.
- **Isolation:** a Transaction in another Circle never appears.
- **Access:** non-member → `null`; archived Circle → readable.

## Done when

- Per-Circle current-month Income/Expense/Net and a recent-Transactions list, active-only and
  minor-unit accurate; tests green; gates pass.

## Out of scope

Month-over-month charts + comparison ranges (RPT-4); category analytics (RPT-5); drilldowns
(RPT-6).
</content>
