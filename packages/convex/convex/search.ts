import {
  clampSearchPage,
  clampSearchPageSize,
  currentMonth,
  indexedSearchOffsetTakeLimit,
  isValidPlainDate,
  isValidPlainMonth,
  MAX_AMOUNT_MINOR,
  normalizeSearchText,
  searchOffsetTakeLimit,
  searchOffsetTotalCount,
  transactionSearchText,
  transactionTextMatches,
} from "@pocketcircle/domain";
import { type IndexRange, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { stream } from "convex-helpers/server/stream";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import { toCategoryView } from "./categories.js";
import { resolveCircleAccess } from "./guard.js";
import { monthDateRange } from "./monthActivity.js";
import type { OperationReader } from "./operationReader.js";
import { toMemberView } from "./operations.js";
import schema from "./schema.js";
import { newViewCaches, toTransactionView } from "./transactions.js";

const filterType = v.union(v.literal("all"), v.literal("expense"), v.literal("income"));
const lifecycleFilter = v.union(v.literal("active"), v.literal("archived"), v.literal("all"));

export const commonFilterArgs = {
  circleId: v.id("circles"),
  query: v.optional(v.string()),
  type: filterType,
  status: lifecycleFilter,
  categoryIds: v.optional(v.array(v.string())),
  recordedByMemberIds: v.optional(v.array(v.string())),
  paidByMemberIds: v.optional(v.array(v.string())),
};

interface SearchCaches {
  linksByTransaction: Map<Id<"transactions">, Doc<"transactionCategories">[]>;
}

export function newSearchCaches() {
  return { linksByTransaction: new Map() } satisfies SearchCaches;
}

function emptyPage() {
  return { page: [], isDone: true, continueCursor: "" };
}

export function validAmountBoundary(value: number | undefined) {
  return (
    value === undefined || (Number.isInteger(value) && value >= 0 && value <= MAX_AMOUNT_MINOR)
  );
}

function selectedType(value: "all" | "expense" | "income") {
  return value === "all" ? undefined : value;
}

function selectedStatus(value: "active" | "archived" | "all") {
  return value === "all" ? undefined : value;
}

function normalizeCategoryIds(ctx: OperationReader, values: string[] | undefined) {
  const ids = new Set<Id<"categories">>();
  let sawValue = false;
  for (const value of values ?? []) {
    sawValue = true;
    const id = ctx.db.normalizeId("categories", value);
    if (id) {
      ids.add(id);
    }
  }
  return { ids, hasOnlyUnknown: sawValue && ids.size === 0 };
}

function normalizeMemberIds(ctx: OperationReader, values: string[] | undefined) {
  const ids = new Set<Id<"members">>();
  let sawValue = false;
  for (const value of values ?? []) {
    sawValue = true;
    const id = ctx.db.normalizeId("members", value);
    if (id) {
      ids.add(id);
    }
  }
  return { ids, hasOnlyUnknown: sawValue && ids.size === 0 };
}

export function resolveSearchWindow(args: { dateFrom?: string; dateTo?: string }) {
  if (args.dateFrom !== undefined && !isValidPlainDate(args.dateFrom)) {
    return { ok: false };
  }
  if (args.dateTo !== undefined && !isValidPlainDate(args.dateTo)) {
    return { ok: false };
  }
  if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) {
    return { ok: true, empty: true };
  }
  return {
    ok: true,
    start: args.dateFrom,
    endExclusive: args.dateTo ? nextPlainDate(args.dateTo) : undefined,
  };
}

function nextPlainDate(date: string) {
  const parts = date.split("-").map(Number);
  const next = new Date(Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, (parts[2] ?? 1) + 1));
  const year = next.getUTCFullYear().toString().padStart(4, "0");
  const month = (next.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = next.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function categoryLinksForTransaction(
  ctx: OperationReader,
  transactionId: Id<"transactions">,
  caches: SearchCaches,
) {
  const cached = caches.linksByTransaction.get(transactionId);
  if (cached) {
    return cached;
  }
  const links = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .collect();
  caches.linksByTransaction.set(transactionId, links);
  return links;
}

export async function matchesFilters(
  ctx: OperationReader,
  txn: Doc<"transactions">,
  filters: {
    type?: "expense" | "income";
    status?: "active" | "archived";
    categoryIds: Set<Id<"categories">>;
    recordedByMemberIds: Set<Id<"members">>;
    paidByMemberIds: Set<Id<"members">>;
    amountMin?: number;
    amountMax?: number;
    queryText: string;
  },
  caches: SearchCaches,
) {
  if (filters.status && txn.status !== filters.status) return false;
  if (filters.type && txn.type !== filters.type) return false;
  if (
    filters.recordedByMemberIds.size > 0 &&
    !filters.recordedByMemberIds.has(txn.recordedByMemberId)
  ) {
    return false;
  }
  if (filters.paidByMemberIds.size > 0 && !filters.paidByMemberIds.has(txn.paidByMemberId)) {
    return false;
  }
  if (filters.amountMin !== undefined && txn.amountMinorUnits < filters.amountMin) return false;
  if (filters.amountMax !== undefined && txn.amountMinorUnits > filters.amountMax) return false;
  if (filters.categoryIds.size > 0) {
    const links = await categoryLinksForTransaction(ctx, txn._id, caches);
    if (!links.some((link) => filters.categoryIds.has(link.categoryId))) {
      return false;
    }
  }
  if (
    filters.queryText &&
    !transactionTextMatches(
      transactionSearchText({ title: txn.title, note: txn.note }),
      filters.queryText,
    )
  ) {
    return false;
  }
  return true;
}

function applyDateRange<
  Scoped extends IndexRange & {
    gte(
      field: "date",
      value: string,
    ): IndexRange & { lt(field: "date", value: string): IndexRange };
    lt(field: "date", value: string): IndexRange;
  },
>(scoped: Scoped, range: { start?: string; endExclusive?: string }) {
  if (range.start && range.endExclusive) {
    return scoped.gte("date", range.start).lt("date", range.endExclusive);
  }
  if (range.start) return scoped.gte("date", range.start);
  if (range.endExclusive) return scoped.lt("date", range.endExclusive);
  return scoped;
}

export function streamByWindow(
  ctx: OperationReader,
  args: {
    circleId: Id<"circles">;
    status?: "active" | "archived";
    paidByMemberIds: Set<Id<"members">>;
    recordedByMemberIds: Set<Id<"members">>;
    start?: string;
    endExclusive?: string;
  },
) {
  if (args.paidByMemberIds.size === 1 && args.status) {
    const paidByMemberId = args.paidByMemberIds.values().next().value;
    if (paidByMemberId) {
      const status = args.status;
      return stream(ctx.db, schema)
        .query("transactions")
        .withIndex("by_circle_paidby_status_date", (q) => {
          const scoped = q
            .eq("circleId", args.circleId)
            .eq("paidByMemberId", paidByMemberId)
            .eq("status", status);
          return applyDateRange(scoped, args);
        })
        .order("desc");
    }
  }
  if (args.recordedByMemberIds.size === 1 && args.status) {
    const recordedByMemberId = args.recordedByMemberIds.values().next().value;
    if (recordedByMemberId) {
      const status = args.status;
      return stream(ctx.db, schema)
        .query("transactions")
        .withIndex("by_circle_recordedby_status_date", (q) => {
          const scoped = q
            .eq("circleId", args.circleId)
            .eq("recordedByMemberId", recordedByMemberId)
            .eq("status", status);
          return applyDateRange(scoped, args);
        })
        .order("desc");
    }
  }
  if (args.status) {
    const status = args.status;
    return stream(ctx.db, schema)
      .query("transactions")
      .withIndex("by_circle_status_date", (q) => {
        const scoped = q.eq("circleId", args.circleId).eq("status", status);
        return applyDateRange(scoped, args);
      })
      .order("desc");
  }
  return stream(ctx.db, schema)
    .query("transactions")
    .withIndex("by_circle_and_date", (q) => {
      const scoped = q.eq("circleId", args.circleId);
      return applyDateRange(scoped, args);
    })
    .order("desc");
}

export async function collectTransactionViews(
  ctx: OperationReader,
  args: {
    circleId: Id<"circles">;
    viewerMemberId: Id<"members">;
    viewerIsOwner: boolean;
    status?: "active" | "archived";
    paidByMemberIds: Set<Id<"members">>;
    recordedByMemberIds: Set<Id<"members">>;
    start?: string;
    endExclusive?: string;
    paginationOpts: { numItems: number; cursor: string | null };
    filters: {
      type?: "expense" | "income";
      categoryIds: Set<Id<"categories">>;
      amountMin?: number;
      amountMax?: number;
      queryText: string;
    };
  },
) {
  const viewCaches = newViewCaches();
  const searchCaches = newSearchCaches();

  if (args.filters.queryText) {
    return await collectSearchTransactionViews(ctx, args, viewCaches);
  }

  const source = streamByWindow(ctx, {
    circleId: args.circleId,
    status: args.status,
    paidByMemberIds: args.paidByMemberIds,
    recordedByMemberIds: args.recordedByMemberIds,
    start: args.start,
    endExclusive: args.endExclusive,
  }).filterWith((txn) =>
    matchesFilters(
      ctx,
      txn,
      {
        type: args.filters.type,
        status: args.status,
        categoryIds: args.filters.categoryIds,
        recordedByMemberIds: args.recordedByMemberIds,
        paidByMemberIds: args.paidByMemberIds,
        amountMin: args.filters.amountMin,
        amountMax: args.filters.amountMax,
        queryText: args.filters.queryText,
      },
      searchCaches,
    ),
  );
  const result = await source.paginate(args.paginationOpts);

  return {
    page: await Promise.all(
      result.page.map((txn) =>
        toTransactionView(ctx, txn, viewCaches, args.viewerMemberId, args.viewerIsOwner),
      ),
    ),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

function onlySelectedId<T>(ids: Set<T>) {
  if (ids.size !== 1) return undefined;
  return ids.values().next().value;
}

export function buildIndexedSearchSource(
  ctx: OperationReader,
  args: Omit<Parameters<typeof collectTransactionViews>[1], "paginationOpts">,
) {
  const paidByMemberId = onlySelectedId(args.paidByMemberIds);
  const recordedByMemberId = onlySelectedId(args.recordedByMemberIds);

  let source = ctx.db.query("transactionSearchDocuments").withSearchIndex("search_text", (q) => {
    let scoped = q.search("searchText", args.filters.queryText).eq("circleId", args.circleId);
    if (args.status) {
      scoped = scoped.eq("status", args.status);
    }
    if (args.filters.type) {
      scoped = scoped.eq("type", args.filters.type);
    }
    if (paidByMemberId) {
      scoped = scoped.eq("paidByMemberId", paidByMemberId);
    }
    if (recordedByMemberId) {
      scoped = scoped.eq("recordedByMemberId", recordedByMemberId);
    }
    return scoped;
  });

  if (args.start) {
    const start = args.start;
    source = source.filter((q) => q.gte(q.field("date"), start));
  }
  if (args.endExclusive) {
    const endExclusive = args.endExclusive;
    source = source.filter((q) => q.lt(q.field("date"), endExclusive));
  }
  if (args.filters.amountMin !== undefined) {
    const amountMin = args.filters.amountMin;
    source = source.filter((q) => q.gte(q.field("amountMinorUnits"), amountMin));
  }
  if (args.filters.amountMax !== undefined) {
    const amountMax = args.filters.amountMax;
    source = source.filter((q) => q.lte(q.field("amountMinorUnits"), amountMax));
  }

  if (args.paidByMemberIds.size > 1) {
    const ids = [...args.paidByMemberIds];
    source = source.filter((q) => q.or(...ids.map((id) => q.eq(q.field("paidByMemberId"), id))));
  }
  if (args.recordedByMemberIds.size > 1) {
    const ids = [...args.recordedByMemberIds];
    source = source.filter((q) =>
      q.or(...ids.map((id) => q.eq(q.field("recordedByMemberId"), id))),
    );
  }
  if (args.filters.categoryIds.size > 0) {
    const ids = [...args.filters.categoryIds];
    source = source.filter((q) =>
      q.or(
        ...ids.flatMap((id) => [
          q.eq(q.field("categoryId0"), id),
          q.eq(q.field("categoryId1"), id),
          q.eq(q.field("categoryId2"), id),
          q.eq(q.field("categoryId3"), id),
          q.eq(q.field("categoryId4"), id),
          q.eq(q.field("categoryId5"), id),
          q.eq(q.field("categoryId6"), id),
          q.eq(q.field("categoryId7"), id),
          q.eq(q.field("categoryId8"), id),
          q.eq(q.field("categoryId9"), id),
        ]),
      ),
    );
  }

  return source;
}

async function collectSearchTransactionViews(
  ctx: OperationReader,
  args: Parameters<typeof collectTransactionViews>[1],
  viewCaches: ReturnType<typeof newViewCaches>,
) {
  const source = buildIndexedSearchSource(ctx, args);
  const result = await source.paginate(args.paginationOpts);
  // Batch raw transaction loads; map to views serially so shared viewCaches stay coherent.
  const txns = await asyncMapChunked(result.page, DEFAULT_READ_CONCURRENCY, (searchDoc) =>
    ctx.db.get(searchDoc.transactionId),
  );
  const page = [];
  for (let index = 0; index < result.page.length; index++) {
    const txn = txns[index];
    if (txn) {
      page.push(
        await toTransactionView(ctx, txn, viewCaches, args.viewerMemberId, args.viewerIsOwner),
      );
    }
  }

  return {
    page,
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

export async function searchTransactionsOffsetPage(
  ctx: OperationReader,
  args: Omit<Parameters<typeof collectTransactionViews>[1], "paginationOpts"> & {
    page: number;
    pageSize: number;
  },
) {
  const viewCaches = newViewCaches();
  const searchCaches = newSearchCaches();
  const { page, pageSize } = args;
  const takeLimit = searchOffsetTakeLimit(pageSize);

  if (args.filters.queryText) {
    const source = buildIndexedSearchSource(ctx, args);
    const indexedTakeLimit = indexedSearchOffsetTakeLimit(pageSize);
    const result = await source.paginate({ numItems: indexedTakeLimit, cursor: null });
    const allDocs = result.page;
    const docSlice = allDocs.slice((page - 1) * pageSize, page * pageSize);
    // Batch raw transaction loads; map to views serially so shared viewCaches stay coherent.
    const txns = await asyncMapChunked(docSlice, DEFAULT_READ_CONCURRENCY, (searchDoc) =>
      ctx.db.get(searchDoc.transactionId),
    );
    const transactions = [];
    for (let index = 0; index < docSlice.length; index++) {
      const txn = txns[index];
      if (txn) {
        transactions.push(
          await toTransactionView(ctx, txn, viewCaches, args.viewerMemberId, args.viewerIsOwner),
        );
      }
    }
    const { totalCount, totalCountCapped } = searchOffsetTotalCount(
      allDocs.length,
      indexedTakeLimit,
      !result.isDone,
    );
    return {
      transactions,
      pageNumber: page,
      pageSize,
      totalCount,
      totalCountCapped,
    };
  }

  const source = streamByWindow(ctx, {
    circleId: args.circleId,
    status: args.status,
    paidByMemberIds: args.paidByMemberIds,
    recordedByMemberIds: args.recordedByMemberIds,
    start: args.start,
    endExclusive: args.endExclusive,
  }).filterWith((txn) =>
    matchesFilters(
      ctx,
      txn,
      {
        type: args.filters.type,
        status: args.status,
        categoryIds: args.filters.categoryIds,
        recordedByMemberIds: args.recordedByMemberIds,
        paidByMemberIds: args.paidByMemberIds,
        amountMin: args.filters.amountMin,
        amountMax: args.filters.amountMax,
        queryText: args.filters.queryText,
      },
      searchCaches,
    ),
  );

  const matched = await source.take(takeLimit);
  const { totalCount, totalCountCapped } = searchOffsetTotalCount(matched.length, takeLimit);
  const pageDocs = matched.slice((page - 1) * pageSize, page * pageSize);
  const transactions = await Promise.all(
    pageDocs.map((txn) =>
      toTransactionView(ctx, txn, viewCaches, args.viewerMemberId, args.viewerIsOwner),
    ),
  );

  return {
    transactions,
    pageNumber: page,
    pageSize,
    totalCount,
    totalCountCapped,
  };
}

export function normalizeCommonFilters(
  ctx: OperationReader,
  args: {
    type: "all" | "expense" | "income";
    status: "active" | "archived" | "all";
    query?: string;
    categoryIds?: string[];
    recordedByMemberIds?: string[];
    paidByMemberIds?: string[];
  },
) {
  const categoryIds = normalizeCategoryIds(ctx, args.categoryIds);
  const recordedByMemberIds = normalizeMemberIds(ctx, args.recordedByMemberIds);
  const paidByMemberIds = normalizeMemberIds(ctx, args.paidByMemberIds);
  return {
    type: selectedType(args.type),
    status: selectedStatus(args.status),
    queryText: normalizeSearchText(args.query),
    categoryIds,
    recordedByMemberIds,
    paidByMemberIds,
    hasOnlyUnknownIds:
      categoryIds.hasOnlyUnknown ||
      recordedByMemberIds.hasOnlyUnknown ||
      paidByMemberIds.hasOnlyUnknown,
  };
}

export const filterLedgerTransactions = query({
  args: {
    ...commonFilterArgs,
    month: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return emptyPage();
    }
    const month = isValidPlainMonth(args.month) ? args.month : currentMonth(new Date());
    const range = monthDateRange(month);
    const filters = normalizeCommonFilters(ctx, args);
    if (filters.hasOnlyUnknownIds) {
      return emptyPage();
    }

    return await collectTransactionViews(ctx, {
      circleId: args.circleId,
      viewerMemberId: access.membership._id,
      viewerIsOwner: access.isOwner,
      status: filters.status,
      paidByMemberIds: filters.paidByMemberIds.ids,
      recordedByMemberIds: filters.recordedByMemberIds.ids,
      start: range.start,
      endExclusive: range.endExclusive,
      paginationOpts: args.paginationOpts,
      filters: {
        type: filters.type,
        categoryIds: filters.categoryIds.ids,
        queryText: filters.queryText,
      },
    });
  },
});

export const searchTransactions = query({
  args: {
    ...commonFilterArgs,
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
    amountMin: v.optional(v.number()),
    amountMax: v.optional(v.number()),
    page: v.number(),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = clampSearchPageSize(args.pageSize);
    const page = clampSearchPage(args.page);

    const emptySearch = () => ({
      transactions: [],
      pageNumber: page,
      pageSize,
      totalCount: 0,
      totalCountCapped: false,
    });

    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return emptySearch();
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
      return emptySearch();
    }
    if (
      args.amountMin !== undefined &&
      args.amountMax !== undefined &&
      args.amountMin > args.amountMax
    ) {
      return emptySearch();
    }

    const filters = normalizeCommonFilters(ctx, args);
    if (filters.hasOnlyUnknownIds) {
      return emptySearch();
    }

    return await searchTransactionsOffsetPage(ctx, {
      circleId: args.circleId,
      viewerMemberId: access.membership._id,
      viewerIsOwner: access.isOwner,
      status: filters.status,
      paidByMemberIds: filters.paidByMemberIds.ids,
      recordedByMemberIds: filters.recordedByMemberIds.ids,
      start: window.start,
      endExclusive: window.endExclusive,
      page,
      pageSize,
      filters: {
        type: filters.type,
        categoryIds: filters.categoryIds.ids,
        amountMin: args.amountMin,
        amountMax: args.amountMax,
        queryText: filters.queryText,
      },
    });
  },
});

function orderMembers(a: Doc<"members">, b: Doc<"members">) {
  if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
  return a.joinedAt - b.joinedAt;
}

function orderCategories(a: Doc<"categories">, b: Doc<"categories">) {
  if (a.type !== b.type) return a.type === "expense" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export const getLedgerFilterOptions = query({
  args: {
    circleId: v.id("circles"),
    month: v.string(),
    type: filterType,
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }
    const month = isValidPlainMonth(args.month) ? args.month : currentMonth(new Date());
    const type = selectedType(args.type);
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_circle_and_month", (q) => q.eq("circleId", args.circleId).eq("month", month))
      .collect();

    const memberIds = new Set<Id<"members">>();
    const categoryIds = new Set<Id<"categories">>();
    for (const txn of transactions) {
      memberIds.add(txn.recordedByMemberId);
      memberIds.add(txn.paidByMemberId);
    }

    const typeFilteredTxns = type ? transactions.filter((txn) => txn.type === type) : transactions;
    const linkLoads = await asyncMapChunked(typeFilteredTxns, DEFAULT_READ_CONCURRENCY, (txn) =>
      ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .collect(),
    );
    for (const links of linkLoads) {
      for (const link of links) {
        categoryIds.add(link.categoryId);
      }
    }

    const loadedCategories = await asyncMapChunked(
      [...categoryIds],
      DEFAULT_READ_CONCURRENCY,
      (categoryId) => ctx.db.get(categoryId),
    );
    const categoryDocs = loadedCategories.filter(
      (category): category is Doc<"categories"> =>
        category != null && (!type || category.type === type),
    );
    categoryDocs.sort(orderCategories);

    const loadedMembers = await asyncMapChunked(
      [...memberIds],
      DEFAULT_READ_CONCURRENCY,
      (memberId) => ctx.db.get(memberId),
    );
    const memberDocs = loadedMembers.filter((member): member is Doc<"members"> => member != null);
    memberDocs.sort(orderMembers);

    const viewer = { userId: access.user._id, isOwner: access.isOwner };
    return {
      categories: await Promise.all(
        categoryDocs.map((category) => toCategoryView(ctx, category, viewer)),
      ),
      members: await Promise.all(
        memberDocs.map((member) => toMemberView(ctx, member, access.membership._id)),
      ),
    };
  },
});

export const getTransactionSearchOptions = query({
  args: {
    circleId: v.id("circles"),
    type: filterType,
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }
    const type = selectedType(args.type);
    const categories = type
      ? await ctx.db
          .query("categories")
          .withIndex("by_circle_type_createdAt", (q) =>
            q.eq("circleId", args.circleId).eq("type", type),
          )
          .collect()
      : await ctx.db
          .query("categories")
          .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
          .collect();
    categories.sort(orderCategories);

    const members = await ctx.db
      .query("members")
      .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
      .collect();
    members.sort(orderMembers);

    const viewer = { userId: access.user._id, isOwner: access.isOwner };
    return {
      categories: await Promise.all(
        categories.map((category) => toCategoryView(ctx, category, viewer)),
      ),
      members: await Promise.all(
        members.map((member) => toMemberView(ctx, member, access.membership._id)),
      ),
    };
  },
});
