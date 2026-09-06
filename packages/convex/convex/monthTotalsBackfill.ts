import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { recomputeCircleMonthWithMembers } from "./monthTotals.js";

/**
 * Paginated rebuild of Circle-month + Paid-By-month totals (RPT-8 PR2).
 *
 * Each invocation scans up to `pageSize` Transactions, then absolute-recomputes
 * **one** Circle-month (plus its Paid-By Member-month rows) from a single month
 * collect — so work stays bounded regardless of how many distinct months appear
 * on the page. Re-runnable / idempotent from `cursor: null`.
 */
export const backfillMonthTotalsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = args.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("pageSize must be a positive integer");
    }

    const page = await ctx.db.query("transactions").paginate({
      numItems: pageSize,
      cursor: args.cursor,
    });
    if (page.page.length === 0) {
      return { continueCursor: null, isDone: true, processed: 0 };
    }

    const target = page.page[0];
    if (!target) {
      return { continueCursor: null, isDone: true, processed: 0 };
    }
    await recomputeCircleMonthWithMembers(ctx, target.circleId, target.month);

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      processed: 1,
      circleId: target.circleId,
      month: target.month,
    };
  },
});
