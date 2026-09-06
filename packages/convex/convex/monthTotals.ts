import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { collectMonthActiveTransactions, sumMonthTotals } from "./monthActivity.js";
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

async function circleMonthRowExists(
  ctx: Pick<MutationCtx, "db">,
  circleId: Id<"circles">,
  month: string,
) {
  return (
    (await ctx.db
      .query("circleMonthTotals")
      .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
      .unique()) !== null
  );
}

async function memberMonthRowExists(
  ctx: Pick<MutationCtx, "db">,
  circleId: Id<"circles">,
  paidByMemberId: Id<"members">,
  month: string,
) {
  return (
    (await ctx.db
      .query("memberMonthTotals")
      .withIndex("by_circle_member_month", (q) =>
        q.eq("circleId", circleId).eq("paidByMemberId", paidByMemberId).eq("month", month),
      )
      .unique()) !== null
  );
}

/**
 * Move maintained totals from `before` → `after` (archive/restore/edit). No-ops when
 * both null or when the contribution is unchanged.
 *
 * If any touched bucket has no maintained row yet (unbackfilled), absolute-recompute
 * those buckets from the active month set instead of inserting a lone delta — otherwise
 * reads would treat the partial row as authoritative and skip the collect fallback.
 */
export async function replaceMonthTotalsContribution(
  ctx: OperationReader & Pick<MutationCtx, "db">,
  before: MonthTotalsContribution | null,
  after: MonthTotalsContribution | null,
) {
  if (before && after && sameContribution(before, after)) {
    return;
  }

  const circleBuckets = new Map<string, { circleId: Id<"circles">; month: string }>();
  const memberBuckets = new Map<
    string,
    { circleId: Id<"circles">; paidByMemberId: Id<"members">; month: string }
  >();
  for (const contribution of [before, after]) {
    if (!contribution) {
      continue;
    }
    circleBuckets.set(`${contribution.circleId}:${contribution.month}`, {
      circleId: contribution.circleId,
      month: contribution.month,
    });
    memberBuckets.set(
      `${contribution.circleId}:${contribution.paidByMemberId}:${contribution.month}`,
      {
        circleId: contribution.circleId,
        paidByMemberId: contribution.paidByMemberId,
        month: contribution.month,
      },
    );
  }

  let needsRecompute = false;
  for (const bucket of circleBuckets.values()) {
    if (!(await circleMonthRowExists(ctx, bucket.circleId, bucket.month))) {
      needsRecompute = true;
      break;
    }
  }
  if (!needsRecompute) {
    for (const bucket of memberBuckets.values()) {
      if (
        !(await memberMonthRowExists(ctx, bucket.circleId, bucket.paidByMemberId, bucket.month))
      ) {
        needsRecompute = true;
        break;
      }
    }
  }

  if (needsRecompute) {
    for (const bucket of circleBuckets.values()) {
      await recomputeCircleMonthTotals(ctx, bucket.circleId, bucket.month);
    }
    for (const bucket of memberBuckets.values()) {
      await recomputeMemberMonthTotals(ctx, bucket.circleId, bucket.paidByMemberId, bucket.month);
    }
    return;
  }

  if (before) {
    await removeMonthTotalsContribution(ctx, before);
  }
  if (after) {
    await applyMonthTotalsContribution(ctx, after);
  }
}

async function upsertMonthTotalsRow(
  ctx: Pick<MutationCtx, "db">,
  existing: { _id: Id<"circleMonthTotals"> | Id<"memberMonthTotals"> } | null,
  totals: { incomeMinor: number; expenseMinor: number },
  insert: () => Promise<unknown>,
) {
  if (totals.incomeMinor === 0 && totals.expenseMinor === 0) {
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return;
  }
  if (existing) {
    await ctx.db.patch(existing._id, {
      incomeMinor: totals.incomeMinor,
      expenseMinor: totals.expenseMinor,
    });
    return;
  }
  await insert();
}

/**
 * Absolute rebuild of one Circle-month row from the active month set (backfill /
 * repair). Concurrent-safe vs delta writes: last write wins with truth from collect.
 */
export async function recomputeCircleMonthTotals(
  ctx: OperationReader & Pick<MutationCtx, "db">,
  circleId: Id<"circles">,
  month: string,
) {
  const totals = sumMonthTotals(await collectMonthActiveTransactions(ctx, circleId, month));
  const existing = await ctx.db
    .query("circleMonthTotals")
    .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
    .unique();
  await upsertMonthTotalsRow(ctx, existing, totals, () =>
    ctx.db.insert("circleMonthTotals", {
      circleId,
      month,
      incomeMinor: totals.incomeMinor,
      expenseMinor: totals.expenseMinor,
    }),
  );
}

/** Absolute rebuild of one Paid-By Member-month row from the active month set. */
export async function recomputeMemberMonthTotals(
  ctx: OperationReader & Pick<MutationCtx, "db">,
  circleId: Id<"circles">,
  paidByMemberId: Id<"members">,
  month: string,
) {
  const totals = sumMonthTotals(
    await collectMonthActiveTransactions(ctx, circleId, month, paidByMemberId),
  );
  const existing = await ctx.db
    .query("memberMonthTotals")
    .withIndex("by_circle_member_month", (q) =>
      q.eq("circleId", circleId).eq("paidByMemberId", paidByMemberId).eq("month", month),
    )
    .unique();
  await upsertMonthTotalsRow(ctx, existing, totals, () =>
    ctx.db.insert("memberMonthTotals", {
      circleId,
      paidByMemberId,
      month,
      incomeMinor: totals.incomeMinor,
      expenseMinor: totals.expenseMinor,
    }),
  );
}

/**
 * Absolute rebuild of one Circle-month plus every Paid-By Member-month for that
 * Circle-month (one collect, then group). Used by bounded backfill pages.
 */
export async function recomputeCircleMonthWithMembers(
  ctx: OperationReader & Pick<MutationCtx, "db">,
  circleId: Id<"circles">,
  month: string,
) {
  const txns = await collectMonthActiveTransactions(ctx, circleId, month);
  const circleTotals = sumMonthTotals(txns);
  const circleRow = await ctx.db
    .query("circleMonthTotals")
    .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
    .unique();
  await upsertMonthTotalsRow(ctx, circleRow, circleTotals, () =>
    ctx.db.insert("circleMonthTotals", {
      circleId,
      month,
      incomeMinor: circleTotals.incomeMinor,
      expenseMinor: circleTotals.expenseMinor,
    }),
  );

  const byMember = new Map<Id<"members">, typeof txns>();
  for (const txn of txns) {
    const list = byMember.get(txn.paidByMemberId) ?? [];
    list.push(txn);
    byMember.set(txn.paidByMemberId, list);
  }

  const existingMembers = await ctx.db
    .query("memberMonthTotals")
    .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
    .collect();
  for (const row of existingMembers) {
    if (!byMember.has(row.paidByMemberId)) {
      await ctx.db.delete(row._id);
    }
  }

  for (const [paidByMemberId, memberTxns] of byMember) {
    const totals = sumMonthTotals(memberTxns);
    const existing = await ctx.db
      .query("memberMonthTotals")
      .withIndex("by_circle_member_month", (q) =>
        q.eq("circleId", circleId).eq("paidByMemberId", paidByMemberId).eq("month", month),
      )
      .unique();
    await upsertMonthTotalsRow(ctx, existing, totals, () =>
      ctx.db.insert("memberMonthTotals", {
        circleId,
        paidByMemberId,
        month,
        incomeMinor: totals.incomeMinor,
        expenseMinor: totals.expenseMinor,
      }),
    );
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

/**
 * Circle-wide active Income/Expense/Net for one month (Dashboard, Ledger, comparison).
 * Falls back to the month collect + {@link sumMonthTotals} when no maintained row
 * exists yet (pre-backfill / empty), so reports stay correct before rebuild finishes.
 */
export async function readCircleMonthTotals(
  ctx: OperationReader,
  circleId: Id<"circles">,
  month: string,
) {
  const row = await ctx.db
    .query("circleMonthTotals")
    .withIndex("by_circle_month", (q) => q.eq("circleId", circleId).eq("month", month))
    .unique();
  if (row) {
    return toMonthTotals(row);
  }
  return sumMonthTotals(await collectMonthActiveTransactions(ctx, circleId, month));
}

/**
 * Paid-By-scoped active Income/Expense/Net for one Circle-month (Home Summary).
 * Same missing-row collect fallback as {@link readCircleMonthTotals}.
 */
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
  if (row) {
    return toMonthTotals(row);
  }
  return sumMonthTotals(await collectMonthActiveTransactions(ctx, circleId, month, paidByMemberId));
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
