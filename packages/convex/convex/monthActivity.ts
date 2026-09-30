import { addMonths } from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { OperationReader } from "./operationReader.js";

/**
 * Circle month activity — the shared definition of which Transactions belong in one
 * Circle-month, under the lifecycle scope the caller asks for (RPT-1/RPT-3). Totals
 * surfaces pin `active`; a list-derived aggregate passes its list's scope (ADR 0036).
 * Category analytics joins this set to a single month-scoped `transactionCategories`
 * scan (RPT-8 PR3). Totals for Ledger / Dashboard / Home Summary / comparison are
 * write-maintained in `monthTotals.ts` (RPT-8 PR2) using {@link sumMonthTotals} as the
 * reducer SSoT. Recent feeds use index-backed takes in `monthTotals.ts`.
 *
 * This module performs NO access checks — reached only after the caller authorized
 * the Circle — and reads only `transactions` / `transactionCategories`.
 */

/**
 * The half-open plain-date range `[month-start, next-month-start)` that captures
 * exactly one "YYYY-MM" month. Plain dates are zero-padded "YYYY-MM-DD" strings,
 * so every date in `month` sorts at or after the bare `month` prefix and strictly
 * before the next month's prefix — letting a date-ordered index (`by_circle_status_date`
 * or `by_circle_and_date`) range a month at the source instead of bucketing in memory
 * (ADR 0009 dates; README §4 index-backed reads). Shared by the month-scoped list, the
 * Ledger totals, and the Dashboard set so they never disagree about what a month contains.
 */
export function monthDateRange(month: string): { start: string; endExclusive: string } {
  return { start: month, endExclusive: addMonths(month, 1) };
}

/** Lifecycle scope of a month-set read. `all` spans active + archived Transactions. */
export type MonthTransactionScope = "active" | "archived" | "all";

/**
 * Collects ONE Circle-month's Transactions under a lifecycle scope — the shared month
 * set the month-scoped reports derive from (RPT-1/RPT-3), so totals and any per-row feed
 * narrow together and can never disagree about what counts.
 *
 * `status` defaults to **active**: archived Transactions are frozen and excluded from
 * totals reporting (TXN-3). A *list-derived* aggregate passes its list's scope instead —
 * the Monthly Ledger's Category ranking (ADR 0036) — so its numbers describe the rows
 * the user is looking at, not the filter-blind month total.
 *
 * The set is bounded to one month at the source: a single scope ranges
 * `by_circle_status_date` to `[month, next-month)`, `all` ranges the date-ordered
 * `by_circle_and_date` in one pass, and an optional Paid By filter ranges
 * `by_circle_paidby_status_date` so ONE Member's month is read at the source rather than
 * scanning the whole month and filtering in memory (README §4). Either way the range is a
 * single month. Totals for Ledger / Dashboard / Home Summary / comparison read
 * write-maintained month docs (`monthTotals.ts`); this collect remains for Category
 * analytics (joined to month link scans) and any caller that still needs the full month
 * set. Recent feeds use `collectRecentMonthActiveTransactions` instead.
 */
export async function collectMonthTransactions(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
  status: MonthTransactionScope = "active",
  paidByMemberId?: Id<"members">,
): Promise<Doc<"transactions">[]> {
  const range = monthDateRange(month);
  if (paidByMemberId) {
    // No date-ordered Paid By index spans both statuses, so `all` reads one status at a
    // time — each still bounded to the month at the source.
    const scopes = status === "all" ? (["active", "archived"] as const) : ([status] as const);
    const reads = await Promise.all(
      scopes.map((scope) =>
        ctx.db
          .query("transactions")
          .withIndex("by_circle_paidby_status_date", (q) =>
            q
              .eq("circleId", circleId)
              .eq("paidByMemberId", paidByMemberId)
              .eq("status", scope)
              .gte("date", range.start)
              .lt("date", range.endExclusive),
          )
          .collect(),
      ),
    );
    return reads.flat();
  }
  if (status === "all") {
    return await ctx.db
      .query("transactions")
      .withIndex("by_circle_and_date", (q) =>
        q.eq("circleId", circleId).gte("date", range.start).lt("date", range.endExclusive),
      )
      .collect();
  }
  return await ctx.db
    .query("transactions")
    .withIndex("by_circle_status_date", (q) =>
      q
        .eq("circleId", circleId)
        .eq("status", status)
        .gte("date", range.start)
        .lt("date", range.endExclusive),
    )
    .collect();
}

/**
 * One month's Transaction↔Category links for a Circle — index-backed date range on
 * `transactionDate` (synced with the Transaction's date). Used by Category analytics
 * and Ledger Filter option discovery instead of per-Transaction link collects (RPT-8 PR3).
 * Includes links on archived Transactions; callers that want a narrower lifecycle scope
 * must join against {@link collectMonthTransactions}.
 */
export async function collectMonthTransactionCategoryLinks(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
) {
  const range = monthDateRange(month);
  return await ctx.db
    .query("transactionCategories")
    .withIndex("by_circle_transactionDate", (q) =>
      q
        .eq("circleId", circleId)
        .gte("transactionDate", range.start)
        .lt("transactionDate", range.endExclusive),
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
