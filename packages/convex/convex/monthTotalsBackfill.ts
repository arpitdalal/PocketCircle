import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { applyMonthTotalsContribution, monthTotalsContributionFrom } from "./monthTotals.js";

/**
 * Paginated backfill of Circle-month + Paid-By-month totals from active Transactions
 * (RPT-8 PR2).
 *
 * Phases (cursor encodes which):
 * 1. `clear:circle` — page-delete `circleMonthTotals`
 * 2. `clear:member` — page-delete `memberMonthTotals`
 * 3. `scan:` + Convex paginate cursor — re-apply contributions from Transactions
 *
 * Start with `cursor: null`. Re-runnable: a fresh null cursor clears then rebuilds.
 * Run while writes are quiet (or re-run once after deploy traffic settles) so live
 * create/edit during the scan cannot double-count against a cleared then rebuilt set.
 */
export const backfillMonthTotalsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = args.pageSize ?? 100;
    const cursor = args.cursor ?? "clear:circle";

    if (cursor === "clear:circle") {
      const rows = await ctx.db.query("circleMonthTotals").take(pageSize);
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      if (rows.length === pageSize) {
        return { continueCursor: "clear:circle", isDone: false, processed: rows.length };
      }
      return { continueCursor: "clear:member", isDone: false, processed: rows.length };
    }

    if (cursor === "clear:member") {
      const rows = await ctx.db.query("memberMonthTotals").take(pageSize);
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      if (rows.length === pageSize) {
        return { continueCursor: "clear:member", isDone: false, processed: rows.length };
      }
      return { continueCursor: "scan:", isDone: false, processed: rows.length };
    }

    const scanCursor = cursor.startsWith("scan:") ? cursor.slice("scan:".length) || null : cursor;
    const page = await ctx.db.query("transactions").paginate({
      numItems: pageSize,
      cursor: scanCursor,
    });
    for (const txn of page.page) {
      const contribution = monthTotalsContributionFrom(txn);
      if (contribution) {
        await applyMonthTotalsContribution(ctx, contribution);
      }
    }
    return {
      continueCursor: page.isDone ? null : `scan:${page.continueCursor}`,
      isDone: page.isDone,
      processed: page.page.length,
    };
  },
});
