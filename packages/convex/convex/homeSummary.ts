import {
  buildRef,
  comparisonWindowMonths,
  currentMonth,
  DEFAULT_HOME_RANGE_MONTHS,
  type HomeRangeMonths,
  isHomeRangeMonths,
  isSupportedCurrency,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import { requireCurrentUser } from "./auth.js";
import { getActiveMembership } from "./guard.js";
import { getPersonalCircleForOwner } from "./model.js";
import { collectMonthActiveTransactions, sumMonthTotals } from "./monthActivity.js";
import { newViewCaches, toTransactionView } from "./transactions.js";

/**
 * Bounded recent transactions cap for the Home Summary feed. Matches Dashboard's
 * RECENT_TRANSACTIONS_LIMIT for consistency.
 */
const HOME_RECENT_LIMIT = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns all Circles the user is an active member of (including archived Circles). */
async function visibleCircles(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .collect();
  // Chunk circle document loads — no serial cross-Circle N+1
  const circles = await asyncMapChunked(
    memberships,
    DEFAULT_READ_CONCURRENCY,
    async (membership) => {
      const circle = await ctx.db.get(membership.circleId);
      if (!circle) return null;
      return { ...circle, membershipId: membership._id, role: membership.role };
    },
  );
  return circles.filter((c): c is NonNullable<typeof c> => c !== null);
}

async function getExcludedCircleIds(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const exclusions = await ctx.db
    .query("homeSummaryExclusions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return new Set(exclusions.map((e) => e.circleId));
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * The Home Summary query (GH-273): currency-scoped, multi-Circle aggregation with
 * exclusions. Authenticated, no circleId arg. Returns a time series, totals,
 * per-circle contributions, bounded recent transactions, and circle metadata.
 *
 * Visible = active memberships; archived Circles remain visible (their transactions
 * are frozen but the Circle stays in the user's membership set).
 *
 * Invalid/unavailable currency canonicalizes to Personal Circle's currency.
 * availableCurrencies includes excluded Circles (user can filter on any visible
 * currency regardless of exclusion).
 */
export const getHomeSummary = query({
  args: {
    currency: v.optional(v.string()),
    range: v.optional(v.union(v.literal(1), v.literal(3), v.literal(6), v.literal(12))),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);

    // 1. Resolve visible Circles
    const allCircles = await visibleCircles(ctx, user._id);

    // 2. Resolve available currencies (from ALL visible, including excluded)
    const availableCurrencies = [...new Set(allCircles.map((c) => c.currency))].sort();

    // 3. Resolve selected currency
    const personalCircle = await getPersonalCircleForOwner(ctx, user._id);
    const personalCurrency = personalCircle?.currency ?? availableCurrencies[0] ?? "USD";

    let selectedCurrency: string;
    if (
      args.currency &&
      isSupportedCurrency(args.currency) &&
      availableCurrencies.includes(args.currency)
    ) {
      selectedCurrency = args.currency;
    } else {
      selectedCurrency = personalCurrency;
    }

    // 4. Filter to currency-matching Circles
    const currencyCircles = allCircles.filter((c) => c.currency === selectedCurrency);

    // 5. Resolve exclusions
    const excludedIds = await getExcludedCircleIds(ctx, user._id);
    const includedCircles = currencyCircles.filter((c) => !excludedIds.has(c._id));

    // 6. Resolve range
    const range: HomeRangeMonths =
      args.range && isHomeRangeMonths(args.range) ? args.range : DEFAULT_HOME_RANGE_MONTHS;

    const endMonth = currentMonth(new Date());
    const months = comparisonWindowMonths(endMonth, range);

    // 7. One-read aggregation: build (Circle, month) cross-product, load each exactly once
    const crossProduct: Array<{
      circle: (typeof includedCircles)[number];
      month: string;
    }> = [];
    for (const circle of includedCircles) {
      for (const month of months) {
        crossProduct.push({ circle, month });
      }
    }

    const cellResults = await asyncMapChunked(
      crossProduct,
      DEFAULT_READ_CONCURRENCY,
      async (cell) => {
        const txns = await collectMonthActiveTransactions(
          ctx,
          cell.circle._id,
          cell.month,
          cell.circle.membershipId,
        );
        return { circle: cell.circle, month: cell.month, totals: sumMonthTotals(txns), txns };
      },
    );

    // 8. Derive series (per-month totals)
    const monthTotalsMap = new Map<string, { incomeMinor: number; expenseMinor: number }>();
    for (const m of months) {
      monthTotalsMap.set(m, { incomeMinor: 0, expenseMinor: 0 });
    }
    for (const cell of cellResults) {
      const bucket = monthTotalsMap.get(cell.month);
      if (!bucket) {
        throw new Error(`Missing Home Summary month bucket: ${cell.month}`);
      }
      bucket.incomeMinor += cell.totals.incomeMinor;
      bucket.expenseMinor += cell.totals.expenseMinor;
    }
    const series = months.map((month) => {
      const bucket = monthTotalsMap.get(month);
      if (!bucket) {
        throw new Error(`Missing Home Summary month bucket: ${month}`);
      }
      return {
        month,
        incomeMinor: bucket.incomeMinor,
        expenseMinor: bucket.expenseMinor,
        netMinor: bucket.incomeMinor - bucket.expenseMinor,
      };
    });

    // 9. Range-wide totals (derived from same loaded records)
    let totalIncomeMinor = 0;
    let totalExpenseMinor = 0;
    for (const entry of series) {
      totalIncomeMinor += entry.incomeMinor;
      totalExpenseMinor += entry.expenseMinor;
    }

    // 10. Per-circle contributions (derived from same loaded records)
    const circleTotalsMap = new Map<Id<"circles">, { incomeMinor: number; expenseMinor: number }>();
    for (const circle of includedCircles) {
      circleTotalsMap.set(circle._id, { incomeMinor: 0, expenseMinor: 0 });
    }
    for (const cell of cellResults) {
      const bucket = circleTotalsMap.get(cell.circle._id);
      if (!bucket) {
        throw new Error(`Missing Home Summary Circle bucket: ${cell.circle._id}`);
      }
      bucket.incomeMinor += cell.totals.incomeMinor;
      bucket.expenseMinor += cell.totals.expenseMinor;
    }
    const contributions = includedCircles.map((circle) => {
      const bucket = circleTotalsMap.get(circle._id);
      if (!bucket) {
        throw new Error(`Missing Home Summary Circle bucket: ${circle._id}`);
      }
      return {
        circleId: circle._id,
        circleRef: buildRef(circle.name, circle._id),
        name: circle.name,
        kind: circle.kind,
        incomeMinor: bucket.incomeMinor,
        expenseMinor: bucket.expenseMinor,
        netMinor: bucket.incomeMinor - bucket.expenseMinor,
      };
    });

    // 11. Recent transactions: from ALL loaded records across the ENTIRE selected range,
    //     sorted by record time, capped at HOME_RECENT_LIMIT, resolve only capped docs.
    const allTxnDocs: Array<{
      txn: Doc<"transactions">;
      circle: (typeof includedCircles)[number];
    }> = [];
    for (const cell of cellResults) {
      for (const txn of cell.txns) {
        allTxnDocs.push({ txn, circle: cell.circle });
      }
    }
    allTxnDocs.sort(
      (a, b) => b.txn.createdAt - a.txn.createdAt || b.txn._creationTime - a.txn._creationTime,
    );
    const cappedRecent = allTxnDocs.slice(0, HOME_RECENT_LIMIT);

    const caches = newViewCaches();
    const recent = await Promise.all(
      cappedRecent.map(async ({ txn, circle }) => {
        // Pass correct isOwner based on the membership role
        const isOwner = circle.role === "owner";
        const view = await toTransactionView(ctx, txn, caches, circle.membershipId, isOwner);
        return {
          ...view,
          circleId: circle._id,
          circleRef: buildRef(circle.name, circle._id),
          circleName: circle.name,
          circleKind: circle.kind,
        };
      }),
    );

    // 12. Scope metadata for ALL visible Circles (not just selected currency),
    //     enough for grouped/labelled control
    const scopeCircles = allCircles.map((c) => ({
      id: c._id,
      ref: buildRef(c.name, c._id),
      name: c.name,
      kind: c.kind,
      currency: c.currency,
      status: c.status,
      included: !excludedIds.has(c._id),
    }));

    return {
      selectedCurrency,
      availableCurrencies,
      range,
      series,
      totals: {
        incomeMinor: totalIncomeMinor,
        expenseMinor: totalExpenseMinor,
        netMinor: totalIncomeMinor - totalExpenseMinor,
      },
      contributions,
      recent,
      includedCount: includedCircles.length,
      availableCount: currencyCircles.length,
      circles: scopeCircles,
    };
  },
});

// ─── Exclusion Mutations ──────────────────────────────────────────────────────

async function requireVisibleMembership(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  circleId: Id<"circles">,
) {
  const membership = await getActiveMembership(ctx, circleId, userId);
  if (!membership) {
    throw new Error("Circle not found");
  }
  return membership;
}

async function exclusionFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  circleId: Id<"circles">,
) {
  return await ctx.db
    .query("homeSummaryExclusions")
    .withIndex("by_user_circle", (q) => q.eq("userId", userId).eq("circleId", circleId))
    .unique();
}

/**
 * Idempotent: exclude a Circle from the Home Summary for the authenticated user.
 * Requires current visibility (active membership). One row per (user, circle).
 * New circles are included by default (absence of exclusion row = included).
 */
export const excludeCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    await requireVisibleMembership(ctx, user._id, args.circleId);
    const existing = await exclusionFor(ctx, user._id, args.circleId);
    if (existing) {
      return;
    }
    await ctx.db.insert("homeSummaryExclusions", {
      userId: user._id,
      circleId: args.circleId,
      excludedAt: Date.now(),
    });
  },
});

/**
 * Idempotent: include a Circle back in the Home Summary for the authenticated user.
 * Requires current visibility (active membership). Removes the exclusion row if present.
 */
export const includeCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    await requireVisibleMembership(ctx, user._id, args.circleId);
    const existing = await exclusionFor(ctx, user._id, args.circleId);
    if (!existing) {
      return;
    }
    await ctx.db.delete(existing._id);
  },
});
