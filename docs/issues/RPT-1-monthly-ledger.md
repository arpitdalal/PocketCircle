# RPT-1 · Monthly Ledger

| | |
|---|---|
| **Status** | Done · [PR #65](https://github.com/arpitdalal/PocketCircle/pull/65) |
| **Labels** | `area:reporting`, `backend`, `ui` |
| **Depends on** | TXN-1 |
| **Unlocks** | RPT-2, RPT-6 |
| **PRD stories** | 62, 63, 64 |
| **ADRs** | 0009, 0015, 0016 |
| **Glossary** | Monthly Ledger |

## Intent

The Monthly Ledger is the **operational Transaction management surface** (glossary) — the
default view of a Circle. It shows **one selected month**, that month's **Income, Expenses,
and Net** totals, and that month's Transactions **sorted by Transaction Date desc, then
created-at desc** (glossary), with month/year navigation (PRD 64). Only **active** Transactions
count toward totals and appear by default (archived are excluded — TXN-3 contract).

## Implement

- **Convex** new `packages/convex/convex/ledger.ts` (or in `transactions.ts`):
  - `getMonthlyLedger` query: args `{ circleId, month }` (`YYYY-MM`). `resolveCircleAccess` →
    `null` if inaccessible → query active Transactions for the Circle+month via
    `by_circle_and_month` → compute totals in **minor units** (sum income, sum expense,
    net = income − expense) → return `{ transactions: view[], totals: { incomeMinor,
    expenseMinor, netMinor }, currency }`, transactions sorted date desc then createdAt desc.
  - Reuse `monthOf`/`currentMonth`/`addMonths` from `packages/domain` for the default month and
    nav math.
- **Web:** Ledger as the Circle index route (`routes/circle/dashboard.tsx` or a ledger route).
  Month/year navigator (prev/next/jump) using `addMonths`. Totals header. Transaction rows
  (Title, amount formatted via Circle Currency, date, categories, Paid By). Derive view types;
  fixtures + `useMonthlyLedger`.

## Why this way

- **Totals computed in minor units server-side** then formatted at the edge (ADR 0009) — never
  sum formatted strings or floats.
- **Query by `by_circle_and_month`** (the index exists) — don't scan all Transactions and parse
  dates client-side.
- **Default month = current month** via the domain helper; navigation is pure month arithmetic.

## How to test

- **Totals math:** mixed income/expense in a month → correct income/expense/net in minor units;
  empty month → zeros; **archived Transactions excluded** from totals and list.
- **Sorting:** same-date Transactions ordered by createdAt desc; different dates by date desc.
- **Navigation:** prev/next month via `addMonths`; year boundaries (Dec→Jan) correct; jumping
  to a month with no Transactions shows zeros.
- **Date integrity:** a Transaction's month bucket matches its entered plain date with no
  timezone drift.
- **Access:** non-member → `null`; archived Circle → readable (view-only).
- **Mock parity:** ledger renders in mock mode from fixtures.

## Done when

- A Member sees a month's active Transactions sorted correctly with accurate minor-unit
  income/expense/net totals and can navigate months; archived excluded; tests green; gates pass.

## Out of scope

Search/filters (RPT-2); charts (RPT-4); drilldown targets (RPT-6 links into this).
</content>
