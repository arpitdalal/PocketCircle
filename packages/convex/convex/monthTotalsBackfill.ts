import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { recomputeCircleMonthTotals, recomputeMemberMonthTotals } from "./monthTotals.js";

/**
 * Paginated rebuild of Circle-month + Paid-By-month totals (RPT-8 PR2).
 *
 * For each Transaction page, absolute-recomputes every touched (circle, month) and
 * (circle, Paid By, month) from the active month set — no clear phase, no delta
 * apply — so concurrent create/edit/archive/restore cannot double-count.
 * Re-runnable from `cursor: null`.
 */
export const backfillMonthTotalsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = args.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("pageSize must be a positive integer");
    }

    const page = await ctx.db.query("transactions").paginate({
      numItems: pageSize,
      cursor: args.cursor,
    });

    const circleMonths = new Map<
      string,
      { circleId: (typeof page.page)[number]["circleId"]; month: string }
    >();
    const memberMonths = new Map<
      string,
      {
        circleId: (typeof page.page)[number]["circleId"];
        paidByMemberId: (typeof page.page)[number]["paidByMemberId"];
        month: string;
      }
    >();
    for (const txn of page.page) {
      circleMonths.set(`${txn.circleId}:${txn.month}`, {
        circleId: txn.circleId,
        month: txn.month,
      });
      memberMonths.set(`${txn.circleId}:${txn.paidByMemberId}:${txn.month}`, {
        circleId: txn.circleId,
        paidByMemberId: txn.paidByMemberId,
        month: txn.month,
      });
    }
    for (const key of circleMonths.values()) {
      await recomputeCircleMonthTotals(ctx, key.circleId, key.month);
    }
    for (const key of memberMonths.values()) {
      await recomputeMemberMonthTotals(ctx, key.circleId, key.paidByMemberId, key.month);
    }

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      processed: page.page.length,
    };
  },
});
