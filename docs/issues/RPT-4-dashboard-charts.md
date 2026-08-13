# RPT-4 · Dashboard charts + comparison ranges

| | |
|---|---|
| **Status** | Done · [PR #86](https://github.com/arpitdalal/PocketCircle/pull/86) |
| **Labels** | `area:reporting`, `backend`, `ui` |
| **Depends on** | RPT-3 |
| **PRD stories** | 70, 71, 72 |
| **ADRs** | 0005, 0009, 0015, 0021 |
| **Glossary** | Dashboard, Comparison Range |

## Intent

Trends over time: **month-over-month Income, Expense, and Net** (PRD 70) rendered as **grouped
Income/Expense bars with a Net line overlay** (PRD 72), across a **Comparison Range** of 1, 3,
6 (default), or 12 months (PRD 71). Recharts is the chart library (ADR 0005).

## Implement

- **Convex** (`dashboard.ts`):
  - `getMonthlyComparison` query: args `{ circleId, endMonth?, rangeMonths: 1|3|6|12 }`.
    `resolveCircleAccess` → compute the month window via `monthRange`/`addMonths` (domain) → for
    each month sum active income/expense/net in minor units → return an ordered series `{ month,
    incomeMinor, expenseMinor, netMinor }[]` + currency.
- **Web:** Recharts grouped bar (income, expense) + line (net) overlay; comparison-range
  selector (1/3/6/12, default 6). Format axes/tooltips via the viewer locale and Circle Currency.

## Why this way

- **Server returns a clean per-month series in minor units**; the chart only formats — keeps
  money math server-side and the UI dumb.
- **Range math reuses `monthRange`/`addMonths`** (domain) so month windows are correct across
  year boundaries.
- Default 6 months per the Comparison Range glossary.

## How to test

- **Series correctness:** each month's income/expense/net matches the per-month totals; months
  with no Transactions appear as zero entries (no gaps); archived excluded.
- **Ranges:** 1/3/6/12 produce the right window ending at `endMonth` (default current); year
  boundary spans correct; default is 6.
- **Ordering:** series is chronological.
- **Access:** non-member → `null`.

## Done when

- A correct, zero-filled, chronological monthly series for 1/3/6/12-month ranges (default 6),
  rendered as grouped bars + net line; tests green; gates pass.

## Out of scope

Category analytics (RPT-5); drilldowns (RPT-6).
</content>
