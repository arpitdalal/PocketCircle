import {
  buildRef,
  clampSearchPage,
  clampSearchPageSize,
  indexedSearchOffsetTakeLimit,
  normalizeSearchText,
  searchOffsetTakeLimit,
  searchOffsetTotalCount,
  TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { mergedStream } from "convex-helpers/server/stream";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import type { OperationReader } from "./operationReader.js";
import { listActiveMembershipsWithCirclesForUser } from "./operations.js";
import {
  buildIndexedSearchSource,
  matchesFilters,
  newSearchCaches,
  resolveSearchWindow,
  streamByWindow,
  validAmountBoundary,
} from "./search.js";
import { newViewCaches, toTransactionView } from "./transactions.js";

const filterType = v.union(v.literal("all"), v.literal("expense"), v.literal("income"));
const lifecycleFilter = v.union(v.literal("active"), v.literal("archived"), v.literal("all"));

/** Index order after paid-by/status equality — same composite `mergedStream` needs. */
const MY_TXN_MERGE_KEYS = ["date", "_creationTime"] as const;

/**
 * Max underlying index rows scanned when type/amount post-filters thin matches.
 * Without this, `filterWith` + `take(takeLimit)` can walk every Paid-By row.
 */
const CANDIDATE_READ_CEILING = 4096;

function selectedType(value: "all" | "expense" | "income") {
  return value === "all" ? undefined : value;
}

function selectedStatus(value: "active" | "archived" | "all") {
  return value === "all" ? undefined : value;
}

function streamLifecycleStatuses(status: "active" | "archived" | undefined) {
  if (status) {
    return [status];
  }
  return ["active", "archived"] as const;
}

function compareTxnDateDesc(a: Doc<"transactions">, b: Doc<"transactions">) {
  if (a.date !== b.date) {
    return a.date < b.date ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a._id < b._id ? 1 : -1;
}

type CircleMembershipEntry = Awaited<
  ReturnType<typeof listActiveMembershipsWithCirclesForUser>
>[number];

function toMyTransactionCircle(circle: Doc<"circles">) {
  return {
    id: circle._id,
    ref: buildRef(circle.name, circle._id),
    name: circle.name,
    color: circle.color,
    mark: circle.mark,
    currency: circle.currency,
    status: circle.status,
  };
}

/**
 * Circle picker rows for My Transactions. Every visible Circle (active membership,
 * including Archived Circles) — independent of Home Summary inclusions.
 */
export const listMyTransactionCircles = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const entries = await listActiveMembershipsWithCirclesForUser(ctx, user);
    return entries.map((entry) => toMyTransactionCircle(entry.circle));
  },
});

/**
 * Text path: per-Circle `transactionSearchDocuments` search (same projection as Circle
 * Search), Paid-By scoped. Takes the full indexed ceiling per Circle (relevance order),
 * then date-desc merges globally so newer low-relevance hits are not dropped early.
 */
async function collectIndexedMatches(
  ctx: OperationReader,
  args: {
    selected: CircleMembershipEntry[];
    status: "active" | "archived" | undefined;
    type: "expense" | "income" | undefined;
    queryText: string;
    amountMin?: number;
    amountMax?: number;
    start?: string;
    endExclusive?: string;
    takeLimit: number;
  },
) {
  const emptyMemberIds = new Set<Id<"members">>();
  const emptyCategoryIds = new Set<Id<"categories">>();
  const matched: Doc<"transactions">[] = [];
  let hitSearchCeiling = false;
  for (const entry of args.selected) {
    const paidByMemberIds = new Set<Id<"members">>([entry.membership._id]);
    const hits = await buildIndexedSearchSource(ctx, {
      circleId: entry.circle._id,
      status: args.status,
      paidByMemberIds,
      recordedByMemberIds: emptyMemberIds,
      start: args.start,
      endExclusive: args.endExclusive,
      filters: {
        type: args.type,
        queryText: args.queryText,
        categoryIds: emptyCategoryIds,
        amountMin: args.amountMin,
        amountMax: args.amountMax,
      },
      viewerMemberId: entry.membership._id,
      viewerIsOwner: entry.membership.role === "owner",
    }).take(TRANSACTION_SEARCH_INDEXED_RESULT_CEILING);
    if (hits.length >= TRANSACTION_SEARCH_INDEXED_RESULT_CEILING) {
      hitSearchCeiling = true;
    }
    for (const hit of hits) {
      const txn = await ctx.db.get(hit.transactionId);
      if (txn) {
        matched.push(txn);
      }
    }
  }
  matched.sort(compareTxnDateDesc);
  if (matched.length > args.takeLimit) {
    hitSearchCeiling = true;
  }
  return {
    matched: matched.slice(0, args.takeLimit),
    hitSearchCeiling,
  };
}

/**
 * Date-ordered paid-by streams, k-way merged. When type/amount post-filters thin the
 * match rate, `maximumRowsRead` caps how many underlying index rows we scan — loop until
 * `takeLimit` matches, the stream ends, or the candidate budget is spent.
 */
async function collectStreamMatches(
  ctx: OperationReader,
  args: {
    selected: CircleMembershipEntry[];
    status: "active" | "archived" | undefined;
    type: "expense" | "income" | undefined;
    amountMin?: number;
    amountMax?: number;
    start?: string;
    endExclusive?: string;
    takeLimit: number;
  },
) {
  const emptyMemberIds = new Set<Id<"members">>();
  const emptyCategoryIds = new Set<Id<"categories">>();
  const searchCaches = newSearchCaches();
  const hasSparsePostFilters = Boolean(
    args.type || args.amountMin !== undefined || args.amountMax !== undefined,
  );
  const candidateBudget = hasSparsePostFilters ? CANDIDATE_READ_CEILING : args.takeLimit;

  const sources = args.selected.flatMap((entry) => {
    const paidByMemberIds = new Set<Id<"members">>([entry.membership._id]);
    return streamLifecycleStatuses(args.status).map((streamStatus) =>
      streamByWindow(ctx, {
        circleId: entry.circle._id,
        status: streamStatus,
        paidByMemberIds,
        recordedByMemberIds: emptyMemberIds,
        start: args.start,
        endExclusive: args.endExclusive,
      }).filterWith((txn) =>
        matchesFilters(
          ctx,
          txn,
          {
            type: args.type,
            status: args.status,
            categoryIds: emptyCategoryIds,
            recordedByMemberIds: emptyMemberIds,
            paidByMemberIds,
            amountMin: args.amountMin,
            amountMax: args.amountMax,
            queryText: "",
          },
          searchCaches,
        ),
      ),
    );
  });
  if (sources.length === 0) {
    return {
      matched: [] as Doc<"transactions">[],
      streamDone: true,
      hitCandidateBudget: false,
    };
  }
  const first = sources[0];
  if (!first) {
    return {
      matched: [] as Doc<"transactions">[],
      streamDone: true,
      hitCandidateBudget: false,
    };
  }
  const source = sources.length === 1 ? first : mergedStream(sources, [...MY_TXN_MERGE_KEYS]);

  const matched: Doc<"transactions">[] = [];
  let cursor: string | null = null;
  let streamDone = false;
  let candidatesRead = 0;
  let hitCandidateBudget = false;

  while (matched.length < args.takeLimit) {
    const room = candidateBudget - candidatesRead;
    if (room <= 0) {
      hitCandidateBudget = true;
      break;
    }
    const need = args.takeLimit - matched.length;
    const page = await source.paginate({
      numItems: need,
      cursor,
      maximumRowsRead: room,
    });
    matched.push(...page.page);
    cursor = page.continueCursor;

    if (page.pageStatus === "SplitRequired") {
      candidatesRead += room;
      if (candidatesRead >= candidateBudget) {
        hitCandidateBudget = true;
        break;
      }
      continue;
    }

    streamDone = page.isDone;
    // Lower bound on rows examined this call (filtered-out rows also counted by the stream).
    candidatesRead += Math.max(page.page.length, 1);
    if (streamDone || page.page.length === 0) {
      break;
    }
  }

  return { matched, streamDone, hitCandidateBudget };
}

/**
 * My Transactions (#389 / ADR 0034): Paid-By-User list+filter across visible Circles.
 *
 * - Text: search-document index (Circle Search projection), then date-desc merge.
 * - No text: k-way merge of paid-by streams; candidate read budget when type/amount thin.
 */
export const searchMyTransactions = query({
  args: {
    circleIds: v.optional(v.array(v.string())),
    query: v.optional(v.string()),
    type: filterType,
    status: lifecycleFilter,
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
    const empty = () => ({
      transactions: [],
      pageNumber: page,
      pageSize,
      totalCount: 0,
      totalCountCapped: false,
    });

    const user = await requireCurrentUser(ctx);
    const window = resolveSearchWindow(args);
    if (
      !window.ok ||
      !validAmountBoundary(args.amountMin) ||
      !validAmountBoundary(args.amountMax)
    ) {
      throw new Error("Invalid search filters");
    }
    if ("empty" in window && window.empty) {
      return empty();
    }
    if (
      args.amountMin !== undefined &&
      args.amountMax !== undefined &&
      args.amountMin > args.amountMax
    ) {
      return empty();
    }

    const entries = await listActiveMembershipsWithCirclesForUser(ctx, user);
    const visibleById = new Map(entries.map((entry) => [entry.circle._id, entry]));

    let selected = entries;
    if (args.circleIds !== undefined) {
      const wanted = new Set<Id<"circles">>();
      let sawValue = false;
      for (const raw of args.circleIds) {
        sawValue = true;
        const id = ctx.db.normalizeId("circles", raw);
        if (id && visibleById.has(id)) {
          wanted.add(id);
        }
      }
      if (sawValue && wanted.size === 0) {
        return empty();
      }
      selected = [...wanted].flatMap((id) => {
        const entry = visibleById.get(id);
        return entry ? [entry] : [];
      });
    }

    const status = selectedStatus(args.status);
    const type = selectedType(args.type);
    const queryText = normalizeSearchText(args.query);
    const takeLimit = queryText
      ? indexedSearchOffsetTakeLimit(pageSize)
      : searchOffsetTakeLimit(pageSize);

    let matched: Doc<"transactions">[];
    let totalCount: number;
    let totalCountCapped: boolean;
    if (queryText) {
      const collected = await collectIndexedMatches(ctx, {
        selected,
        status,
        type,
        queryText,
        amountMin: args.amountMin,
        amountMax: args.amountMax,
        start: window.start,
        endExclusive: window.endExclusive,
        takeLimit,
      });
      matched = collected.matched;
      ({ totalCount, totalCountCapped } = searchOffsetTotalCount(
        matched.length,
        takeLimit,
        collected.hitSearchCeiling,
      ));
    } else {
      const collected = await collectStreamMatches(ctx, {
        selected,
        status,
        type,
        amountMin: args.amountMin,
        amountMax: args.amountMax,
        start: window.start,
        endExclusive: window.endExclusive,
        takeLimit,
      });
      matched = collected.matched;
      if (collected.hitCandidateBudget && matched.length < takeLimit) {
        // Incomplete scan — report what we found; do not pretend takeLimit matches exist.
        totalCount = matched.length;
        totalCountCapped = true;
      } else {
        ({ totalCount, totalCountCapped } = searchOffsetTotalCount(
          matched.length,
          takeLimit,
          matched.length >= takeLimit && !collected.streamDone,
        ));
      }
    }

    const start = (page - 1) * pageSize;
    const pageDocs = matched.slice(start, start + pageSize);

    const viewCaches = newViewCaches();
    const transactions = await Promise.all(
      pageDocs.map(async (txn) => {
        const entry = visibleById.get(txn.circleId);
        if (!entry) {
          throw new Error("Missing Circle for Transaction");
        }
        const view = await toTransactionView(
          ctx,
          txn,
          viewCaches,
          entry.membership._id,
          entry.membership.role === "owner",
        );
        return {
          ...view,
          circle: toMyTransactionCircle(entry.circle),
        };
      }),
    );

    return {
      transactions,
      pageNumber: page,
      pageSize,
      totalCount,
      totalCountCapped,
    };
  },
});
