import { comparisonWindowMonths, currentMonth, isValidPlainMonth } from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import { resolveCircleAccess } from "./guard.js";
import { collectMonthActiveTransactions, sumMonthTotals } from "./monthActivity.js";
import { newViewCaches, toTransactionView } from "./transactions.js";

const transactionType = v.union(v.literal("expense"), v.literal("income"));

/**
 * How many recent Transactions the Dashboard surfaces (PRD story 75). A small,
 * glanceable feed — not a list view (that is the Monthly Ledger, RPT-1) — so the
 * recent slice stays bounded regardless of how busy the month is.
 */
export const RECENT_TRANSACTIONS_LIMIT = 5;

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

    const monthTxns = await collectMonthActiveTransactions(ctx, args.circleId, month);

    // Recent = the same bounded set, ordered by record time and capped. Sorting a
    // single bounded month in memory is fine (README §4 forbids sorting UNBOUNDED
    // sets); only the capped slice is resolved to full views, so the per-row Paid
    // By / Category resolution stays bounded by the cap, not the month size.
    const recentDocs = [...monthTxns]
      .sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime)
      .slice(0, RECENT_TRANSACTIONS_LIMIT);
    const caches = newViewCaches();
    const recent = await Promise.all(
      recentDocs.map((txn) =>
        toTransactionView(ctx, txn, caches, access.membership._id, access.isOwner),
      ),
    );

    return {
      totals: sumMonthTotals(monthTxns),
      recent,
      currency: access.circle.currency,
      month,
    };
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

    const series = await Promise.all(
      comparisonWindowMonths(endMonth, args.rangeMonths).map(async (month) => {
        const monthTxns = await collectMonthActiveTransactions(ctx, args.circleId, month);
        return { month, ...sumMonthTotals(monthTxns) };
      }),
    );

    return { series, currency: access.circle.currency };
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

    const monthTxns = await collectMonthActiveTransactions(ctx, args.circleId, month);
    const scopedTxns = args.type ? monthTxns.filter((txn) => txn.type === args.type) : monthTxns;

    // Bounded parallel fan-out: at most CATEGORY_LINK_READ_CONCURRENCY transactionCategories
    // reads in flight at once — keeps the latency win over the serial N+1 loop without
    // letting a high-volume month spike to thousands of concurrent reads (RPT-5).
    const linkLoads = await asyncMapChunked(scopedTxns, DEFAULT_READ_CONCURRENCY, async (txn) => ({
      txn,
      links: await ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .collect(),
    }));

    const accum = new Map<Id<"categories">, { taggedTotalMinor: number; txnCount: number }>();
    for (const { txn, links } of linkLoads) {
      for (const link of links) {
        const existing = accum.get(link.categoryId) ?? { taggedTotalMinor: 0, txnCount: 0 };
        existing.taggedTotalMinor += txn.amountMinorUnits;
        existing.txnCount += 1;
        accum.set(link.categoryId, existing);
      }
    }

    const categoryIds = [...accum.keys()];
    const loadedCategories = await asyncMapChunked(
      categoryIds,
      DEFAULT_READ_CONCURRENCY,
      (categoryId) => ctx.db.get(categoryId),
    );
    const rows = [];
    for (const [index, categoryId] of categoryIds.entries()) {
      const category = loadedCategories[index];
      if (!category) {
        continue;
      }
      const totals = accum.get(categoryId);
      if (!totals) {
        continue;
      }
      rows.push({
        categoryId,
        name: category.name,
        color: category.color,
        status: category.status,
        taggedTotalMinor: totals.taggedTotalMinor,
        txnCount: totals.txnCount,
      });
    }

    rows.sort((a, b) => b.taggedTotalMinor - a.taggedTotalMinor || a.name.localeCompare(b.name));

    return { rows, currency: access.circle.currency };
  },
});
