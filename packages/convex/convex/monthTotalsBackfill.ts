import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { recomputeCircleMonthWithMembers } from "./monthTotals.js";

/**
 * Paginated rebuild of Circle-month + Paid-By-month totals (RPT-8 PR2).
 *
 * Each invocation advances **one** Transaction cursor row, then absolute-recomputes
 * that row's Circle-month (plus its Paid-By Member-month rows) from a single month
 * collect. Cursor never skips unprocessed months. Same month may be recomputed
 * once per Transaction in it (idempotent). Re-runnable from `cursor: null`.
 */
export const backfillMonthTotalsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    /** Ignored for scan size — kept for call-site compat; each page is one Transaction. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.pageSize !== undefined && (!Number.isInteger(args.pageSize) || args.pageSize < 1)) {
      throw new Error("pageSize must be a positive integer");
    }

    const page = await ctx.db.query("transactions").paginate({
      numItems: 1,
      cursor: args.cursor,
    });
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
