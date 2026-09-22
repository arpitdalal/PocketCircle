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
 * My Transactions (#389 / ADR 0034): Paid-By-User list+filter across visible Circles.
 *
 * Per-Circle paid-by+status streams are already date-desc; `mergedStream` k-way merges them
 * so we only read ~takeLimit rows globally (not takeLimit × Circles × lifecycles).
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
    const takeLimit = searchOffsetTakeLimit(pageSize);
    const emptyMemberIds = new Set<Id<"members">>();
    const emptyCategoryIds = new Set<Id<"categories">>();
    const searchCaches = newSearchCaches();

    const sources = selected.flatMap((entry) => {
      const paidByMemberIds = new Set<Id<"members">>([entry.membership._id]);
      return streamLifecycleStatuses(status).map((streamStatus) =>
        streamByWindow(ctx, {
          circleId: entry.circle._id,
          status: streamStatus,
          paidByMemberIds,
          recordedByMemberIds: emptyMemberIds,
          start: window.start,
          endExclusive: window.endExclusive,
        }).filterWith((txn) =>
          matchesFilters(
            ctx,
            txn,
            {
              type,
              status,
              categoryIds: emptyCategoryIds,
              recordedByMemberIds: emptyMemberIds,
              paidByMemberIds,
              amountMin: args.amountMin,
              amountMax: args.amountMax,
              queryText,
            },
            searchCaches,
          ),
        ),
      );
    });
    if (sources.length === 0) {
      return empty();
    }
    const first = sources[0];
    if (!first) {
      return empty();
    }
    const source = sources.length === 1 ? first : mergedStream(sources, [...MY_TXN_MERGE_KEYS]);

    const matched = await source.take(takeLimit);
    const { totalCount, totalCountCapped } = searchOffsetTotalCount(matched.length, takeLimit);
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
