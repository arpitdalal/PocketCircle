import { addMonths } from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { OperationReader } from "./operationReader.js";

/**
 * Circle month activity — the single home of "what one Circle-month contains" and
 * the reporting reduction derived from it (RPT-1/RPT-3, and the upcoming Search and
 * Category-analytics surfaces). The Monthly Ledger, the Dashboard, Home Summary,
 * and every future month-scoped report read the SAME active Transaction set for a
 * Circle-month and reduce it to the SAME Income/Expense/Net totals. Concentrating
 * the month-range,
 * the active-only filter, and the totals math HERE means those surfaces can never
 * drift — one cannot start counting archived Transactions, range the month
 * differently, or sum totals another way while another does it right.
 *
 * The Convex queries (`ledger.getMonthlyLedger`, `dashboard.getDashboard`,
 * `homeSummary.getHomeSummary`) stay thin
 * adapters: they resolve Circle access (guard.ts, ADR 0015), then read and reduce
 * through this module. This module performs NO access checks — it is reached only
 * after the caller has authorized the Circle — and reads only the `transactions`
 * table, so it stays a low-level leaf with no dependency on the query/view layer.
 */

/**
 * The half-open plain-date range `[month-start, next-month-start)` that captures
 * exactly one "YYYY-MM" month. Plain dates are zero-padded "YYYY-MM-DD" strings,
 * so every date in `month` sorts at or after the bare `month` prefix and strictly
 * before the next month's prefix — letting a date-ordered index (`by_circle_status_date`)
 * range a month at the source instead of bucketing in memory (ADR 0009 dates;
 * README §4 index-backed reads). Shared by the month-scoped list, the Ledger totals,
 * and the Dashboard set so they never disagree on what a month contains.
 */
export function monthDateRange(month: string): { start: string; endExclusive: string } {
  return { start: month, endExclusive: addMonths(month, 1) };
}

/**
 * Collects ONE Circle-month's active Transactions — the single active set the
 * month-scoped reports derive from (RPT-1/RPT-3), so totals and any per-row feed
 * narrow together and can never disagree about what counts. Only **active**
 * Transactions are read: archived are frozen and excluded from reporting (TXN-3).
 *
 * The set is bounded to one month at the source: the unfiltered read ranges
 * `by_circle_status_date` to `[month, next-month)` active-only, and an optional Paid
 * By filter ranges `by_circle_paidby_status_date` so ONE Member's month is read at
 * the source rather than scanning the whole month and filtering in memory (README
 * §4). Either way the range is a single month, the sanctioned bounded-aggregate
 * read; a maintained running aggregate (@convex-dev/aggregate) is the next-level
 * optimization if a single month's volume ever warrants it, deferred for v1.
 */
export async function collectMonthActiveTransactions(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
  paidByMemberId?: Id<"members">,
): Promise<Doc<"transactions">[]> {
  const range = monthDateRange(month);
  if (paidByMemberId) {
    return await ctx.db
      .query("transactions")
      .withIndex("by_circle_paidby_status_date", (q) =>
        q
          .eq("circleId", circleId)
          .eq("paidByMemberId", paidByMemberId)
          .eq("status", "active")
          .gte("date", range.start)
          .lt("date", range.endExclusive),
      )
      .collect();
  }
  return await ctx.db
    .query("transactions")
    .withIndex("by_circle_status_date", (q) =>
      q
        .eq("circleId", circleId)
        .eq("status", "active")
        .gte("date", range.start)
        .lt("date", range.endExclusive),
    )
    .collect();
}

/**
 * Reduces a bounded month set to its Income / Expense / Net **in minor units** (ADR
 * 0009 — the edge formats once; the server never sums formatted strings or floats).
 * The single home of the reporting totals math shared by the Monthly Ledger and the
 * Dashboard. Reads only `type` + `amountMinorUnits`, so it is honest about its
 * inputs and trivially unit-testable without a backend. Net is Income − Expense, so
 * an expense-heavy month is naturally negative.
 */
export function sumMonthTotals(
  transactions: ReadonlyArray<Pick<Doc<"transactions">, "type" | "amountMinorUnits">>,
) {
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const txn of transactions) {
    if (txn.type === "income") {
      incomeMinor += txn.amountMinorUnits;
    } else {
      expenseMinor += txn.amountMinorUnits;
    }
  }
  return { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
}
