import {
  buildRef,
  clampSearchPage,
  clampSearchPageSize,
  normalizeSearchText,
  searchOffsetTakeLimit,
  searchOffsetTotalCount,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { mergedStream } from "convex-helpers/server/stream";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import type { OperationReader } from "./operationReader.js";
import { listActiveMembershipsWithCirclesForUser } from "./operations.js";
import {
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
 * Max underlying index rows scanned when text/type/amount post-filters thin matches.
 * One global budget (not per-Circle) so sparse filters cannot walk every Paid-By row.
 */
export const MY_TRANSACTIONS_CANDIDATE_READ_CEILING = 4096;

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

function emptyMatchedResult() {
  const matched: Doc<"transactions">[] = [];
  return { matched, streamDone: true, hitCandidateBudget: false };
}

/**
 * Date-desc paid-by streams, k-way merged (ADR 0034 sort). Text/type/amount are
 * post-filters with one global candidate read budget — never a relevance-ranked
 * prefix, never a per-Circle multiplied ceiling.
 */
async function collectMatchedTransactions(
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
  const searchCaches = newSearchCaches();
  const hasSparsePostFilters = Boolean(
    args.queryText || args.type || args.amountMin !== undefined || args.amountMax !== undefined,
  );
  const candidateBudget = hasSparsePostFilters
    ? MY_TRANSACTIONS_CANDIDATE_READ_CEILING
    : args.takeLimit;

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
            queryText: args.queryText,
          },
          searchCaches,
        ),
      ),
    );
  });
  if (sources.length === 0) {
    return emptyMatchedResult();
  }
  const first = sources[0];
  if (!first) {
    return emptyMatchedResult();
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
    candidatesRead += Math.max(page.page.length, 1);
    if (streamDone || page.page.length === 0) {
      break;
    }
  }

  return { matched, streamDone, hitCandidateBudget };
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
 * My Transactions (#389 / ADR 0034): Paid-By-User list+filter across visible Circles.
 *
 * One date-desc merged paid-by stream path (text included). Sparse post-filters share a
 * global candidate budget; `scanIncomplete` is true when that budget ends before the
 * stream does — never reported as an exhaustive empty result.
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
      scanIncomplete: false,
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
    const takeLimit = searchOffsetTakeLimit(pageSize);

    const collected = await collectMatchedTransactions(ctx, {
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
    const matched = collected.matched;
    const scanIncomplete = collected.hitCandidateBudget && !collected.streamDone;

    let totalCount: number;
    let totalCountCapped: boolean;
    if (scanIncomplete && matched.length < takeLimit) {
      // Incomplete prefix — report found rows only; UI must not treat empty as exhaustive.
      totalCount = matched.length;
      totalCountCapped = true;
    } else {
      ({ totalCount, totalCountCapped } = searchOffsetTotalCount(
        matched.length,
        takeLimit,
        matched.length >= takeLimit && !collected.streamDone,
      ));
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
      scanIncomplete,
    };
  },
});
