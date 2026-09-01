import { currentMonth, isValidPlainMonth } from "@pocketcircle/domain";
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { resolveCircleAccess } from "./guard.js";
import {
  categoryAnalyticsForAccess,
  dashboardForAccess,
  monthlyComparisonForAccess,
  RECENT_TRANSACTIONS_LIMIT,
} from "./operations.js";

export { RECENT_TRANSACTIONS_LIMIT };

const transactionType = v.union(v.literal("expense"), v.literal("income"));

/**
 * The per-Circle Dashboard surface for one month (RPT-3; PRD stories 68, 75).
 * Returns that month's Income / Expense / Net **in minor units** (ADR 0009 — the
 * edge formats once, never sums formatted strings), a bounded **recent** feed of
 * the latest Transactions by record time, the Circle Currency, and the resolved
 * `month`. Only **active** Transactions count — archived are frozen and excluded
 * from reporting (TXN-3 contract).
 *
 * `month` defaults to the current month (server clock) when omitted; the route
 * passes the User's local current month so the Dashboard reads as "this month" for
 * them. An explicit malformed month throws, mirroring the Ledger.
 *
 * Totals and recent come from one `collect` of the bounded month set (see
 * {@link collectMonthActiveTransactions}); recent is that set ordered by record time
 * (`createdAt` desc, `_creationTime` desc tiebreak) and capped at
 * {@link RECENT_TRANSACTIONS_LIMIT}, then resolved to full Transaction views (Paid
 * By / Categories memoized per query to avoid N+1). Recent is intentionally
 * record-time order — what was most recently ENTERED — distinct from the Ledger's
 * Transaction-Date order, so a backfilled old Transaction still shows as recent
 * activity.
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns `null`,
 * indistinguishable from each other.
 */
export const getDashboard = query({
  args: {
    circleId: v.id("circles"),
    month: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }

    const month = args.month ?? currentMonth(new Date());
    if (!isValidPlainMonth(month)) {
      throw new Error("Invalid month");
    }

    return dashboardForAccess(ctx, access, month);
  },
});

/**
 * The Dashboard's month-over-month comparison series (RPT-4; PRD stories 70, 71, 72):
 * one entry per month of the Comparison Range — `rangeMonths` months (1/3/6/12, the
 * glossary's only windows, enforced by the literal validator) ending at `endMonth`
 * inclusive — each with that month's active Income / Expense / Net **in minor units**
 * (ADR 0009; the chart only formats, never sums). The series is chronological and
 * zero-filled by construction: `comparisonWindowMonths` (domain) builds the full
 * ascending window via `addMonths`/`monthRange` so year boundaries are correct and a
 * month with no Transactions reduces to zeros rather than a gap.
 *
 * `endMonth` defaults to the current month (server clock) when omitted; the route
 * passes the User's local current month, mirroring `getDashboard`. An explicit
 * malformed month throws, mirroring the Ledger.
 *
 * Each month is read through {@link collectMonthActiveTransactions} — the shared
 * bounded, index-backed Circle-month read (README §4) — and reduced by
 * {@link sumMonthTotals}, so the comparison can never disagree with the Ledger or
 * the Dashboard about what a month contains. At most 12 single-month indexed range
 * reads, fetched in parallel.
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns `null`,
 * indistinguishable from each other.
 */
export const getMonthlyComparison = query({
  args: {
    circleId: v.id("circles"),
    endMonth: v.optional(v.string()),
    rangeMonths: v.union(v.literal(1), v.literal(3), v.literal(6), v.literal(12)),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }

    const endMonth = args.endMonth ?? currentMonth(new Date());
    if (!isValidPlainMonth(endMonth)) {
      throw new Error("Invalid month");
    }

    return monthlyComparisonForAccess(ctx, access, endMonth, args.rangeMonths);
  },
});

/**
 * Ranked, non-additive category tagged spend for one month (RPT-5; PRD stories 58, 73).
 * Each Category's total is the sum of full Transaction amounts for active Transactions
 * tagged with it in the period — a multi-Category Transaction contributes its full
 * amount to *each* of its Categories, so category totals are explicitly NOT additive.
 * Archived Categories appear when in-period active Transactions still use them (PRD 58).
 *
 * Reads the same bounded active month set as `getDashboard` via
 * {@link collectMonthActiveTransactions}, optionally narrowed by `type`. Returns rows
 * sorted by `taggedTotalMinor` descending (name ascending on ties) plus the Circle
 * Currency in minor units (ADR 0009).
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns `null`.
 */
export const getCategoryAnalytics = query({
  args: {
    circleId: v.id("circles"),
    month: v.optional(v.string()),
    type: v.optional(transactionType),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }

    const month = args.month ?? currentMonth(new Date());
    if (!isValidPlainMonth(month)) {
      throw new Error("Invalid month");
    }

    return categoryAnalyticsForAccess(ctx, access, month, args.type);
  },
});
