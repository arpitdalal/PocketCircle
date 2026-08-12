import {
  formatMoneyAmount,
  money,
  TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { query } from "./_generated/server.js";
import { resolveCircleAccess } from "./guard.js";
import {
  buildIndexedSearchSource,
  categoryLinksForTransaction,
  commonFilterArgs,
  matchesFilters,
  newSearchCaches,
  normalizeCommonFilters,
  resolveSearchWindow,
  streamByWindow,
  validAmountBoundary,
} from "./search.js";
import { categoryDisplayName, memberDisplayName, newViewCaches } from "./transactions.js";

export const EXPORT_LIMIT = 5000;

const exportRowValidator = v.object({
  date: v.string(),
  type: v.union(v.literal("expense"), v.literal("income")),
  title: v.string(),
  note: v.string(),
  amount: v.string(),
  currency: v.string(),
  categories: v.string(),
  recordedBy: v.string(),
  paidBy: v.string(),
  status: v.union(v.literal("active"), v.literal("archived")),
});

const exportResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    rows: v.array(exportRowValidator),
    currency: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    reason: v.union(v.literal("tooMany"), v.literal("inaccessible")),
    limit: v.optional(v.number()),
  }),
);

async function toExportRow(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
  currency: ReturnType<typeof toCurrencyCode>,
  viewCaches: ReturnType<typeof newViewCaches>,
  searchCaches: ReturnType<typeof newSearchCaches>,
) {
  const links = await categoryLinksForTransaction(ctx, txn._id, searchCaches);
  const categoryNames = [];
  for (const link of links) {
    const name = await categoryDisplayName(ctx, link.categoryId, viewCaches);
    if (name) {
      categoryNames.push(name);
    }
  }

  return {
    date: txn.date,
    type: txn.type,
    title: txn.title,
    note: txn.note ?? "",
    amount: formatMoneyAmount(money(txn.amountMinorUnits, currency)),
    currency,
    categories: categoryNames.join(", "),
    recordedBy: await memberDisplayName(ctx, txn.recordedByMemberId, viewCaches),
    paidBy: await memberDisplayName(ctx, txn.paidByMemberId, viewCaches),
    status: txn.status,
  };
}

async function gatherExportTransactions(
  ctx: QueryCtx,
  args: {
    circleId: Doc<"transactions">["circleId"];
    amountMin?: number;
    amountMax?: number;
  },
  access: NonNullable<Awaited<ReturnType<typeof resolveCircleAccess>>>,
  filters: ReturnType<typeof normalizeCommonFilters>,
  window: { start?: string; endExclusive?: string },
) {
  const collectArgs = {
    circleId: args.circleId,
    viewerMemberId: access.membership._id,
    viewerIsOwner: access.isOwner,
    status: filters.status,
    paidByMemberIds: filters.paidByMemberIds.ids,
    recordedByMemberIds: filters.recordedByMemberIds.ids,
    start: window.start,
    endExclusive: window.endExclusive,
    filters: {
      type: filters.type,
      categoryIds: filters.categoryIds.ids,
      amountMin: args.amountMin,
      amountMax: args.amountMax,
      queryText: filters.queryText,
    },
  };

  if (filters.queryText) {
    const source = buildIndexedSearchSource(ctx, collectArgs);
    const result = await source.paginate({
      numItems: TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
      cursor: null,
    });
    if (!result.isDone) {
      return { refused: true as const, limit: TRANSACTION_SEARCH_INDEXED_RESULT_CEILING };
    }
    const transactions = [];
    for (const searchDoc of result.page) {
      const txn = await ctx.db.get("transactions", searchDoc.transactionId);
      if (txn) {
        transactions.push(txn);
      }
    }
    return { transactions };
  }

  const searchCaches = newSearchCaches();
  const source = streamByWindow(ctx, {
    circleId: args.circleId,
    status: filters.status,
    paidByMemberIds: filters.paidByMemberIds.ids,
    recordedByMemberIds: filters.recordedByMemberIds.ids,
    start: collectArgs.start,
    endExclusive: collectArgs.endExclusive,
  }).filterWith((txn) =>
    matchesFilters(
      ctx,
      txn,
      {
        type: collectArgs.filters.type,
        status: filters.status,
        categoryIds: collectArgs.filters.categoryIds,
        recordedByMemberIds: filters.recordedByMemberIds.ids,
        paidByMemberIds: filters.paidByMemberIds.ids,
        amountMin: collectArgs.filters.amountMin,
        amountMax: collectArgs.filters.amountMax,
        queryText: collectArgs.filters.queryText,
      },
      searchCaches,
    ),
  );
  const matched = await source.take(EXPORT_LIMIT + 1);
  if (matched.length > EXPORT_LIMIT) {
    return { refused: true as const, limit: EXPORT_LIMIT };
  }
  return { transactions: matched };
}

export const exportTransactions = query({
  args: {
    ...commonFilterArgs,
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
    amountMin: v.optional(v.number()),
    amountMax: v.optional(v.number()),
  },
  returns: exportResultValidator,
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return { ok: false as const, reason: "inaccessible" as const };
    }

    const window = resolveSearchWindow(args);
    if (
      !window.ok ||
      !validAmountBoundary(args.amountMin) ||
      !validAmountBoundary(args.amountMax)
    ) {
      throw new Error("Invalid search filters");
    }
    if ("empty" in window && window.empty) {
      return {
        ok: true as const,
        rows: [],
        currency: toCurrencyCode(access.circle.currency),
      };
    }
    if (
      args.amountMin !== undefined &&
      args.amountMax !== undefined &&
      args.amountMin > args.amountMax
    ) {
      return {
        ok: true as const,
        rows: [],
        currency: toCurrencyCode(access.circle.currency),
      };
    }

    const filters = normalizeCommonFilters(ctx, args);
    const currency = toCurrencyCode(access.circle.currency);
    if (filters.hasOnlyUnknownIds) {
      return { ok: true as const, rows: [], currency };
    }

    const gathered = await gatherExportTransactions(ctx, args, access, filters, {
      start: window.start,
      endExclusive: window.endExclusive,
    });
    if ("refused" in gathered && gathered.refused) {
      return { ok: false as const, reason: "tooMany" as const, limit: gathered.limit };
    }

    const viewCaches = newViewCaches();
    const searchCaches = newSearchCaches();
    const rows = await Promise.all(
      gathered.transactions.map((txn) => toExportRow(ctx, txn, currency, viewCaches, searchCaches)),
    );
    return { ok: true as const, rows, currency };
  },
});
