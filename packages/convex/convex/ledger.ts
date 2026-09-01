import { isValidPlainMonth } from "@pocketcircle/domain";
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { resolveCircleAccess } from "./guard.js";
import { monthlyLedgerSummaryForAccess } from "./operations.js";

/**
 * The Monthly Ledger's financial summary for one Circle-month (RPT-1; PRD stories
 * 62–64). Returns that month's Income, Expense, and Net **in minor units** plus the
 * Circle Currency, so the edge formats once (ADR 0009) and never sums formatted
 * strings or floats. Only **active** Transactions count — archived are frozen and
 * excluded from reporting (TXN-3 contract).
 *
 * Pairing: the month's Transaction LIST is the paginated `transactions.listTransactions`
 * with the same `month` arg; this query is its totals counterpart. They are split
 * because (a) `usePaginatedQuery` can't surface extra top-level fields like totals
 * next to a page, and (b) totals must sum the WHOLE month whereas the list only
 * resolves the visible page — so fusing them into one query would force the
 * expensive full-month view resolution on every page. `data.ts`'s `useMonthlyLedger`
 * recombines the two into the slice's `{ transactions, totals, currency }` surface.
 *
 * Scalability (README §4): the list paginates at the source; these totals are an
 * AGGREGATE over the bounded, indexed month range (`by_circle_status_date` ranged to
 * one month, active only) — the sanctioned aggregate-over-a-bounded-range read, not
 * a whole-table scan. It reads only `type` + `amountMinorUnits` per row (no Category
 * / Member resolution), so the per-row cost is minimal. A maintained running
 * aggregate (e.g. @convex-dev/aggregate) is the next-level optimization if a single
 * month's volume ever warrants it; deferred for v1.
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns `null`,
 * indistinguishable from each other — nothing about the Circle's existence leaks.
 */
export const getMonthlyLedger = query({
  args: { circleId: v.id("circles"), month: v.string() },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }
    if (!isValidPlainMonth(args.month)) {
      throw new Error("Invalid month");
    }

    return monthlyLedgerSummaryForAccess(ctx, access, args.month);
  },
});
