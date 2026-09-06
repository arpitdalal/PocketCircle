import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { sumMonthTotals } from "./monthActivity.js";
import type { OperationReader } from "./operationReader.js";

const ZERO_TOTALS = { incomeMinor: 0, expenseMinor: 0, netMinor: 0 } as const;

export type MonthTotals = {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
};

type TotalsDelta = { incomeMinor: number; expenseMinor: number };

/** Fields that determine which maintained month buckets a Transaction contributes to. */
export type MonthTotalsContribution = {
  circleId: Id<"circles">;
  month: string;
  paidByMemberId: Id<"members">;
  type: Doc<"transactions">["type"];
  amountMinorUnits: number;
};

export function monthTotalsContributionFrom(
  txn: Pick<
    Doc<"transactions">,
    "circleId" | "month" | "paidByMemberId" | "type" | "amountMinorUnits" | "status"
  >,
) {
  if (txn.status !== "active") {
    return null;
  }
  return {
    circleId: txn.circleId,
    month: txn.month,
    paidByMemberId: txn.paidByMemberId,
    type: txn.type,
    amountMinorUnits: txn.amountMinorUnits,
  };
}

function deltaFromContribution(contribution: MonthTotalsContribution, sign: 1 | -1) {
  const totals = sumMonthTotals([
    { type: contribution.type, amountMinorUnits: contribution.amountMinorUnits },
  ]);
  return {
    incomeMinor: sign * totals.incomeMinor,
    expenseMinor: sign * totals.expenseMinor,
  };
}

function sameContribution(a: MonthTotalsContribution, b: MonthTotalsContribution) {
  return (
    a.circleId === b.circleId &&
    a.month === b.month &&
    a.paidByMemberId === b.paidByMemberId &&
    a.type === b.type &&
    a.amountMinorUnits === b.amountMinorUnits
  );
}

async function adjustMonthTotalsRow(
  ctx: Pick<MutationCtx, "db">,
  existing: {
    _id: Id<"circleMonthTotals"> | Id<"memberMonthTotals">;
    incomeMinor: number;
    expenseMinor: number;
  } | null,
  delta: TotalsDelta,
  insert: () => Promise<unknown>,
) {
  if (delta.incomeMinor === 0 && delta.expenseMinor === 0) {
    return;
  }
  if (!existing) {
    if (delta.incomeMinor <= 0 && delta.expenseMinor <= 0) {
      return;
    }
    await insert();
    return;
  }
  const incomeMinor = existing.incomeMinor + delta.incomeMinor;
  const expenseMinor = existing.expenseMinor + delta.expenseMinor;
  if (incomeMinor === 0 && expenseMinor === 0) {
    await ctx.db.delete(existing._id);
    return;
  }
  await ctx.db.patch(existing._id, { incomeMinor, expenseMinor });
}

async function applyContribution(
  ctx: Pick<MutationCtx, "db">,
  contribution: MonthTotalsContribution,
  sign: 1 | -1,
) {
  const delta = deltaFromContribution(contribution, sign);
  const circleRow = await ctx.db
    .query("circleMonthTotals")
    .withIndex("by_circle_month", (q) =>
      q.eq("circleId", contribution.circleId).eq("month", contribution.month),
    )
    .unique();
  await adjustMonthTotalsRow(ctx, circleRow, delta, () =>
    ctx.db.insert("circleMonthTotals", {
      circleId: contribution.circleId,
      month: contribution.month,
      incomeMinor: delta.incomeMinor,
      expenseMinor: delta.expenseMinor,
    }),
  );

  const memberRow = await ctx.db
    .query("memberMonthTotals")
    .withIndex("by_circle_member_month", (q) =>
      q
        .eq("circleId", contribution.circleId)
        .eq("paidByMemberId", contribution.paidByMemberId)
        .eq("month", contribution.month),
    )
    .unique();
  await adjustMonthTotalsRow(ctx, memberRow, delta, () =>
    ctx.db.insert("memberMonthTotals", {
      circleId: contribution.circleId,
      paidByMemberId: contribution.paidByMemberId,
      month: contribution.month,
      incomeMinor: delta.incomeMinor,
      expenseMinor: delta.expenseMinor,
    }),
  );
}

/** Apply a Transaction's active contribution to maintained Circle-month + Paid-By-month totals. */
export async function applyMonthTotalsContribution(
  ctx: Pick<MutationCtx, "db">,
  contribution: MonthTotalsContribution,
) {
  await applyContribution(ctx, contribution, 1);
}

/** Remove a Transaction's active contribution from maintained totals. */
export async function removeMonthTotalsContribution(
  ctx: Pick<MutationCtx, "db">,
  contribution: MonthTotalsContribution,
) {
  await applyContribution(ctx, contribution, -1);
}

/**
 * Move maintained totals from `before` → `after` (archive/restore/edit). No-ops when
 * both null or when the contribution is unchanged.
 */
export async function replaceMonthTotalsContribution(
  ctx: Pick<MutationCtx, "db">,
  before: MonthTotalsContribution | null,
  after: MonthTotalsContribution | null,
) {
  if (before && after && sameContribution(before, after)) {
    return;
  }
  if (before) {
    await removeMonthTotalsContribution(ctx, before);
  }
  if (after) {
    await applyMonthTotalsContribution(ctx, after);
  }
}

function toMonthTotals(row: { incomeMinor: number; expenseMinor: number } | null) {
  if (!row) {
    return { ...ZERO_TOTALS };
  }
  return {
    incomeMinor: row.incomeMinor,
    expenseMinor: row.expenseMinor,
    netMinor: row.incomeMinor - row.expenseMinor,
  };
}

/** Circle-wide active Income/Expense/Net for one month (Dashboard, Ledger, comparison). */
export async function readCircleMonthTotals(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
) {
  const row = await ctx.db
    .query("circleMonthTotals")
    .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
    .unique();
  return toMonthTotals(row);
}

/** Paid-By-scoped active Income/Expense/Net for one Circle-month (Home Summary attribution). */
export async function readMemberMonthTotals(
  ctx: OperationReader,
  circleId: Id<"circles">,
  paidByMemberId: Id<"members">,
  month: string,
) {
  const row = await ctx.db
    .query("memberMonthTotals")
    .withIndex("by_circle_member_month", (q) =>
      q.eq("circleId", circleId).eq("paidByMemberId", paidByMemberId).eq("month", month),
    )
    .unique();
  return toMonthTotals(row);
}

/**
 * Bounded recent active Transactions for one Circle-month by record time — index-backed
 * take, not a full-month collect (RPT-8).
 */
export async function collectRecentMonthActiveTransactions(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
  limit: number,
  paidByMemberId?: Id<"members">,
) {
  if (paidByMemberId) {
    return await ctx.db
      .query("transactions")
      .withIndex("by_circle_paidby_status_month_createdAt", (q) =>
        q
          .eq("circleId", circleId)
          .eq("paidByMemberId", paidByMemberId)
          .eq("status", "active")
          .eq("month", month),
      )
      .order("desc")
      .take(limit);
  }
  return await ctx.db
    .query("transactions")
    .withIndex("by_circle_status_month_createdAt", (q) =>
      q.eq("circleId", circleId).eq("status", "active").eq("month", month),
    )
    .order("desc")
    .take(limit);
}
