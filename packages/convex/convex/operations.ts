/**
 * Shared domain operations for an already-resolved PocketCircle User (#316).
 *
 * Browser-authenticated public queries resolve the User from Better Auth, then
 * call these. Trusted Convex server code (future MCP HTTP bridge) passes an
 * explicit User without a browser session. Ops take only an `OperationReader`
 * (DB reads) — not auth APIs, schedulers, or a full server ctx.
 *
 * The future Worker never imports or calls these functions: it hits a narrow
 * Convex bridge that loads the grant's User and runs ops inside Convex. The
 * Worker therefore never receives a DB handle or browser credentials.
 *
 * Explicit User resolution uses the stable PocketCircle User id (ADR 0024).
 * Never match a User by email.
 */

import {
  buildRef,
  clampSearchPage,
  clampSearchPageSize,
  currentMonth,
  isValidPlainMonth,
  normalizeMcpImage,
  parseRef,
  TRANSACTION_LIST_PAGE_SIZE,
} from "@pocketcircle/domain";
import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import { resolveCircleAccessForUser } from "./guard.js";
import { circleEntity, paginateEntityHistory, transactionEntity } from "./history.js";
import { newActorCache, toHistoryEventView } from "./historyView.js";
import { isEffectiveActiveMember, resolveMemberIdentity } from "./memberIdentity.js";
import { monthDateRange } from "./monthActivity.js";
import type { OperationReader } from "./operationReader.js";
import {
  collectTransactionViews,
  normalizeCommonFilters,
  resolveSearchWindow,
  searchTransactionsOffsetPage,
  validAmountBoundary,
} from "./search.js";
import {
  newViewCaches,
  type TransactionDetailView,
  type TransactionView,
  toTransactionDetailView,
} from "./transactions.js";

export type { OperationReader } from "./operationReader.js";

/**
 * Load a User by stable PocketCircle id. Malformed ids and missing rows are
 * null — never falls back to email lookup.
 */
export async function resolveUserById(ctx: OperationReader, userId: Id<"users"> | string) {
  const id = typeof userId === "string" ? ctx.db.normalizeId("users", userId) : userId;
  if (!id) {
    return null;
  }
  return await ctx.db.get(id);
}

/**
 * Current-User view the protected layout and settings read (ADR 0003). Derived
 * from the User row so the client cannot drift from the backend contract. Also
 * the shared current-User operation for an already-resolved User (#316).
 */
export function toCurrentUserView(user: Doc<"users">) {
  return {
    id: user._id,
    email: user.email,
    displayName: user.displayName,
    image: user.image,
    onboardingComplete: user.onboardingCompletedAt !== null,
    analyticsEnabled: user.analyticsEnabled,
    createdAt: user.createdAt,
    acknowledgedFeatureAnnouncementIds: user.acknowledgedFeatureAnnouncementIds ?? [],
  };
}

/** Safe granted-User view for MCP (#319, omitting UI bookkeeping and email). */
export function toMcpCurrentUserView(user: Doc<"users">) {
  return {
    id: user._id,
    displayName: user.displayName,
    image: normalizeMcpImage(user.image),
    createdAt: user.createdAt,
  };
}

/** A Circle plus its canonical ref, shaped for the client. */
export function toCircleView(circle: Doc<"circles">) {
  return {
    id: circle._id,
    ref: buildRef(circle.name, circle._id),
    name: circle.name,
    kind: circle.kind,
    currency: circle.currency,
    color: circle.color,
    mark: circle.mark,
    status: circle.status,
    setupAnswers: circle.setupAnswers,
    setupComplete: circle.setupCompletedAt !== null,
    currencyLocked: circle.currencyLocked,
    nameCustomized: circle.personalNameCustomizedAt !== undefined,
  };
}

/** An authorized Circle shaped for MCP consumers (#319). */
export function toMcpCircleView(circle: Doc<"circles">, isOwner: boolean) {
  return {
    id: circle._id,
    ref: buildRef(circle.name, circle._id),
    name: circle.name,
    kind: circle.kind,
    currency: circle.currency,
    color: circle.color,
    mark: circle.mark,
    status: circle.status,
    setupComplete: circle.setupCompletedAt !== null,
    currencyLocked: circle.currencyLocked,
    isOwner,
  };
}

/** Resolves a canonical or bare Circle reference without exposing lookup errors. */
export function resolveCircleRef(ctx: OperationReader, circleRef: string) {
  const parsed = parseRef(
    circleRef,
    (candidate) => ctx.db.normalizeId("circles", candidate) !== null,
  );
  return parsed ? ctx.db.normalizeId("circles", parsed.id) : null;
}

export function toMcpMemberView(member: Awaited<ReturnType<typeof toMemberView>>) {
  return {
    ...member,
    image: normalizeMcpImage(member.image),
  };
}

/** The shared Member List projection used by web, search, and MCP reads. */
export async function toMemberView(
  ctx: OperationReader,
  member: Doc<"members">,
  currentMemberId: Doc<"members">["_id"],
) {
  const identity = await resolveMemberIdentity(ctx, member);
  return {
    id: member._id,
    displayName: identity.displayName,
    image: identity.image,
    role: member.role,
    status: identity.status,
    joinedAt: member.joinedAt,
    isSelf: member._id === currentMemberId,
  };
}

export type MemberView = Awaited<ReturnType<typeof toMemberView>>;

function emptyPaginationPage() {
  return { page: [], isDone: true, continueCursor: "" };
}

/** Shared explicit-User Member List read used by the web path. */
export async function listMembersForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  includeHistorical = false,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return null;
  }

  const members = await ctx.db
    .query("members")
    .withIndex("by_circle", (q) => q.eq("circleId", circleId))
    .collect();
  const visible: Doc<"members">[] = [];
  for (const member of members) {
    if (includeHistorical || (await isEffectiveActiveMember(ctx, member))) {
      visible.push(member);
    }
  }
  visible.sort((a, b) => {
    if (a.role !== b.role) {
      return a.role === "owner" ? -1 : 1;
    }
    return a.joinedAt - b.joinedAt;
  });

  return await Promise.all(
    visible.map((member) => toMemberView(ctx, member, access.membership._id)),
  );
}

interface MemberPageCursor {
  initialOwnerMemberId: string | null;
  memberCursor: string | null;
  lastJoinedAt: number | null;
  lastMemberId: string | null;
}

function decodeMemberPageCursor(cursor: string) {
  try {
    const value: unknown = JSON.parse(cursor);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const initialOwnerMemberId =
      "initialOwnerMemberId" in value &&
      (value.initialOwnerMemberId === null || typeof value.initialOwnerMemberId === "string")
        ? value.initialOwnerMemberId
        : "ownerMemberIds" in value && isStringArray(value.ownerMemberIds)
          ? (value.ownerMemberIds[0] ?? null)
          : null;
    if (
      "initialOwnerMemberId" in value &&
      value.initialOwnerMemberId !== null &&
      typeof value.initialOwnerMemberId !== "string"
    ) {
      return null;
    }
    const memberCursor =
      "memberCursor" in value &&
      (value.memberCursor === null || typeof value.memberCursor === "string")
        ? value.memberCursor
        : null;
    const lastJoinedAt =
      "lastJoinedAt" in value &&
      (value.lastJoinedAt === null ||
        (typeof value.lastJoinedAt === "number" && Number.isInteger(value.lastJoinedAt)))
        ? value.lastJoinedAt
        : null;
    const lastMemberId =
      "lastMemberId" in value &&
      (value.lastMemberId === null || typeof value.lastMemberId === "string")
        ? value.lastMemberId
        : null;
    return {
      initialOwnerMemberId,
      memberCursor,
      lastJoinedAt,
      lastMemberId,
    };
  } catch {
    return null;
  }
}

function encodeMemberPageCursor(cursor: MemberPageCursor) {
  return JSON.stringify(cursor);
}

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

async function readActiveMemberPage(
  ctx: OperationReader,
  circleId: Id<"circles">,
  cursor: MemberPageCursor,
  pageSize: number,
  currentMemberId: Id<"members">,
) {
  const storedActiveMembers = await ctx.db
    .query("members")
    .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
    .collect();
  const visibleMembers = [];
  for (const member of storedActiveMembers) {
    if (
      member._id !== cursor.initialOwnerMemberId &&
      (await isEffectiveActiveMember(ctx, member))
    ) {
      visibleMembers.push(member);
    }
  }
  visibleMembers.sort((a, b) =>
    a.joinedAt === b.joinedAt
      ? a._id < b._id
        ? -1
        : a._id > b._id
          ? 1
          : 0
      : a.joinedAt - b.joinedAt,
  );

  const { lastJoinedAt, lastMemberId } = cursor;
  const firstMemberAfterCursor =
    lastJoinedAt === null || lastMemberId === null
      ? 0
      : visibleMembers.findIndex(
          (member) =>
            member.joinedAt > lastJoinedAt ||
            (member.joinedAt === lastJoinedAt && member._id > lastMemberId),
        );
  const memberStart =
    firstMemberAfterCursor === -1 ? visibleMembers.length : firstMemberAfterCursor;
  const memberPage = visibleMembers.slice(memberStart, memberStart + pageSize);
  const page = await Promise.all(
    memberPage.map(async (member) =>
      toMcpMemberView(await toMemberView(ctx, member, currentMemberId)),
    ),
  );

  return {
    page,
    isDone: memberStart + memberPage.length >= visibleMembers.length,
    lastMember: memberPage.at(-1),
    memberCursor: null,
  };
}

/** Bounded explicit-User Member List read for MCP. */
export async function paginateMembersForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  includeHistorical: boolean,
  paginationOpts: PaginationOptions,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  const emptyPage = emptyPaginationPage();
  if (!access) {
    return emptyPage;
  }
  const decodedCursor = paginationOpts.cursor
    ? decodeMemberPageCursor(paginationOpts.cursor)
    : { initialOwnerMemberId: null, memberCursor: null, lastJoinedAt: null, lastMemberId: null };
  if (!decodedCursor) {
    return emptyPage;
  }

  const owner = await ctx.db
    .query("members")
    .withIndex("by_circle_and_user", (q) =>
      q.eq("circleId", circleId).eq("userId", access.circle.ownerUserId),
    )
    .unique();
  const ownerIsVisible =
    owner !== null && (includeHistorical || (await isEffectiveActiveMember(ctx, owner)));
  const ownerView = ownerIsVisible ? await toMemberView(ctx, owner, access.membership._id) : null;
  const firstPage = paginationOpts.cursor === null;
  const initialOwnerMemberId = firstPage
    ? (ownerView?.id ?? null)
    : decodedCursor.initialOwnerMemberId;
  const memberItems =
    firstPage && ownerView ? Math.max(0, paginationOpts.numItems - 1) : paginationOpts.numItems;
  const activeResult = includeHistorical
    ? null
    : await readActiveMemberPage(
        ctx,
        circleId,
        {
          initialOwnerMemberId,
          memberCursor: null,
          lastJoinedAt: firstPage ? null : decodedCursor.lastJoinedAt,
          lastMemberId: firstPage ? null : decodedCursor.lastMemberId,
        },
        memberItems,
        access.membership._id,
      );
  const historicalResult = includeHistorical
    ? await (initialOwnerMemberId
        ? ctx.db
            .query("members")
            .withIndex("by_circle_and_joinedAt", (q) => q.eq("circleId", circleId))
            .filter((q) => q.neq(q.field("_id"), initialOwnerMemberId))
            .order("asc")
            .paginate({
              numItems: Math.max(1, memberItems),
              cursor: decodedCursor.memberCursor,
            })
        : ctx.db
            .query("members")
            .withIndex("by_circle_and_joinedAt", (q) => q.eq("circleId", circleId))
            .order("asc")
            .paginate({
              numItems: Math.max(1, memberItems),
              cursor: decodedCursor.memberCursor,
            }))
    : null;
  const historicalPage = (historicalResult?.page ?? []).filter(
    (member) => member._id !== initialOwnerMemberId,
  );
  const result = activeResult ?? {
    page: await Promise.all(
      (memberItems === 0 ? [] : historicalPage).map(async (member) =>
        toMcpMemberView(await toMemberView(ctx, member, access.membership._id)),
      ),
    ),
    isDone:
      memberItems === 0
        ? (historicalResult?.isDone ?? true) && (historicalResult?.page.length ?? 0) === 0
        : (historicalResult?.isDone ?? true),
    memberCursor: memberItems === 0 ? null : (historicalResult?.continueCursor ?? null),
    lastMember: undefined,
  };
  const page = firstPage && ownerView ? [toMcpMemberView(ownerView), ...result.page] : result.page;
  return {
    page,
    isDone: result.isDone,
    continueCursor: result.isDone
      ? ""
      : encodeMemberPageCursor({
          initialOwnerMemberId,
          memberCursor: includeHistorical ? result.memberCursor : null,
          lastJoinedAt: includeHistorical
            ? null
            : (result.lastMember?.joinedAt ?? decodedCursor.lastJoinedAt),
          lastMemberId: includeHistorical
            ? null
            : (result.lastMember?._id ?? decodedCursor.lastMemberId),
        }),
  };
}

/** Shared explicit-User Circle History read used by web and MCP. */
export async function listCircleHistoryForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  paginationOpts: PaginationOptions,
) {
  const emptyPage = emptyPaginationPage();
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return emptyPage;
  }
  const result = await paginateEntityHistory(ctx, circleEntity(circleId), paginationOpts);
  const cache = newActorCache();
  const page = await Promise.all(result.page.map((event) => toHistoryEventView(ctx, event, cache)));
  return {
    ...result,
    page: access.isOwner
      ? page
      : page.map((event) => ({
          ...event,
          changes: event.changes.filter((change) => change.field !== "email"),
        })),
  };
}

function compareCirclesPersonalFirst(a: Doc<"circles">, b: Doc<"circles">) {
  if (a.kind !== b.kind) {
    return a.kind === "personal" ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

/**
 * Active Circle memberships with their loaded Circles for an active User.
 * Personal Circle first, then by creation time. Excludes inactive memberships
 * and missing Circles.
 */
export type ActiveMembershipWithCircle = {
  membership: Doc<"members">;
  circle: Doc<"circles">;
};

export async function listActiveMembershipsWithCirclesForUser(
  ctx: OperationReader,
  user: Doc<"users">,
) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();

  const entries: ActiveMembershipWithCircle[] = [];
  for (const membership of memberships) {
    if (membership.status !== "active") {
      continue;
    }
    const circle = await ctx.db.get(membership.circleId);
    if (circle) {
      entries.push({ membership, circle });
    }
  }

  entries.sort((a, b) => compareCirclesPersonalFirst(a.circle, b.circle));
  return entries;
}

/**
 * Circles the User is an active Member of (Circle Visibility): Personal Circle
 * first, then by creation time. Includes Archived Circles; excludes removed
 * memberships and missing Circles (missing ≡ inaccessible, not an error).
 */
export async function listMyCirclesForUser(ctx: OperationReader, user: Doc<"users">) {
  const entries = await listActiveMembershipsWithCirclesForUser(ctx, user);
  return entries.map((entry) => toCircleView(entry.circle));
}

/**
 * Circles the User is an active Member of AND that are permitted by the MCP grant.
 * Personal Circle first, then by creation time (#319).
 */
export async function listAuthorizedCirclesForGrant(
  ctx: OperationReader,
  grant: Doc<"mcpGrants">,
  user: Doc<"users">,
) {
  const entries = await listActiveMembershipsWithCirclesForUser(ctx, user);

  return listAuthorizedCirclesFromMemberships(grant, entries);
}

/** Filters a previously loaded membership set for one MCP grant. */
export function listAuthorizedCirclesFromMemberships(
  grant: Doc<"mcpGrants">,
  entries: ActiveMembershipWithCircle[],
) {
  const allowedSet = new Set(grant.allowedCircleIds);

  return entries
    .filter((entry) => allowedSet.has(entry.circle._id))
    .map((entry) => toMcpCircleView(entry.circle, entry.membership.role === "owner"));
}

/**
 * One Circle by id for an already-resolved User. Missing, malformed, and
 * inaccessible ids all return null (ADR 0016).
 */
export async function getCircleForUser(ctx: OperationReader, circleId: string, user: Doc<"users">) {
  const id = ctx.db.normalizeId("circles", circleId);
  if (!id) {
    return null;
  }
  const access = await resolveCircleAccessForUser(ctx, id, user);
  return access ? toCircleView(access.circle) : null;
}

function toMcpMemberAttributionView(member: { displayName: string; image?: string }) {
  return {
    displayName: member.displayName,
    image: normalizeMcpImage(member.image ?? null),
  };
}

function toMcpCategoryAttributionView(category: { id: string; name: string; color: string }) {
  return {
    ref: buildRef(category.name, category.id),
    name: category.name,
    color: category.color,
  };
}

export function toMcpTransactionSummaryView(view: TransactionView, currency: string) {
  return {
    ref: view.ref,
    type: view.type,
    title: view.title,
    ...(view.note === undefined ? {} : { note: view.note }),
    amountMinorUnits: view.amountMinorUnits,
    currency,
    date: view.date,
    month: view.month,
    status: view.status,
    recordedBy: toMcpMemberAttributionView(view.recordedBy),
    paidBy: toMcpMemberAttributionView(view.paidBy),
    categories: view.categories.map(toMcpCategoryAttributionView),
    canEditFields: view.canEditFields,
    canArchive: view.canArchive,
  };
}

export function toMcpTransactionDetailView(view: TransactionDetailView, currency: string) {
  const summary = toMcpTransactionSummaryView(view, currency);
  return {
    ...summary,
    audit: {
      createdBy: toMcpMemberAttributionView(view.audit.createdBy),
      createdAt: view.audit.createdAt,
      updatedBy: toMcpMemberAttributionView(view.audit.updatedBy),
      updatedAt: view.audit.updatedAt,
    },
  };
}

/** Resolves a canonical or bare Transaction reference without exposing lookup errors. */
export function resolveTransactionRef(ctx: OperationReader, transactionRef: string) {
  const parsed = parseRef(
    transactionRef,
    (candidate) => ctx.db.normalizeId("transactions", candidate) !== null,
  );
  if (parsed) {
    return ctx.db.normalizeId("transactions", parsed.id);
  }
  return ctx.db.normalizeId("transactions", transactionRef);
}

function normalizeCategoryRefs(ctx: OperationReader, refs: string[] | undefined) {
  const ids = new Set<Id<"categories">>();
  let sawValue = false;
  for (const ref of refs ?? []) {
    sawValue = true;
    const parsed = parseRef(
      ref,
      (candidate) => ctx.db.normalizeId("categories", candidate) !== null,
    );
    const id = parsed
      ? ctx.db.normalizeId("categories", parsed.id)
      : ctx.db.normalizeId("categories", ref);
    if (id) {
      ids.add(id);
    }
  }
  return { ids, hasOnlyUnknown: sawValue && ids.size === 0 };
}

export type McpSearchTransactionsArgs = {
  filters?: {
    query?: string;
    type?: "all" | "expense" | "income";
    status?: "active" | "archived" | "all";
    categoryRefs?: string[];
    recordedByMemberIds?: string[];
    paidByMemberIds?: string[];
    dateFrom?: string;
    dateTo?: string;
    amountMin?: number;
    amountMax?: number;
    month?: string;
  };
  page?: number;
  pageSize?: number;
  paginationOpts?: PaginationOptions;
};

function resolveMcpSearchWindow(filters: McpSearchTransactionsArgs["filters"]) {
  if (filters?.month !== undefined) {
    const month = isValidPlainMonth(filters.month) ? filters.month : currentMonth(new Date());
    const range = monthDateRange(month);
    return { ok: true as const, start: range.start, endExclusive: range.endExclusive };
  }
  return resolveSearchWindow({
    dateFrom: filters?.dateFrom,
    dateTo: filters?.dateTo,
  });
}

async function mapSearchTransactionsForAccess(
  ctx: OperationReader,
  access: NonNullable<Awaited<ReturnType<typeof resolveCircleAccessForUser>>>,
  args: McpSearchTransactionsArgs,
) {
  const filters = args.filters ?? {};
  const pageSize = clampSearchPageSize(args.pageSize);
  const page = clampSearchPage(args.page ?? 1);
  const window = resolveMcpSearchWindow(filters);
  if (
    !window.ok ||
    !validAmountBoundary(filters.amountMin) ||
    !validAmountBoundary(filters.amountMax)
  ) {
    return { ok: false as const, error: "invalid_filters" as const };
  }
  if ("empty" in window && window.empty) {
    return args.paginationOpts
      ? {
          ok: true as const,
          value: { pagination: "cursor" as const, page: [], isDone: true, continueCursor: "" },
        }
      : {
          ok: true as const,
          value: {
            pagination: "offset" as const,
            transactions: [],
            pageNumber: page,
            pageSize,
            totalCount: 0,
            totalCountCapped: false,
          },
        };
  }
  if (
    filters.amountMin !== undefined &&
    filters.amountMax !== undefined &&
    filters.amountMin > filters.amountMax
  ) {
    return args.paginationOpts
      ? {
          ok: true as const,
          value: { pagination: "cursor" as const, page: [], isDone: true, continueCursor: "" },
        }
      : {
          ok: true as const,
          value: {
            pagination: "offset" as const,
            transactions: [],
            pageNumber: page,
            pageSize,
            totalCount: 0,
            totalCountCapped: false,
          },
        };
  }

  const categoryRefs = normalizeCategoryRefs(ctx, filters.categoryRefs);
  const common = normalizeCommonFilters(ctx, {
    type: filters.type ?? "all",
    status: filters.status ?? "active",
    query: filters.query,
    categoryIds: [...categoryRefs.ids],
    recordedByMemberIds: filters.recordedByMemberIds,
    paidByMemberIds: filters.paidByMemberIds,
  });
  if (categoryRefs.hasOnlyUnknown || common.hasOnlyUnknownIds) {
    return args.paginationOpts
      ? {
          ok: true as const,
          value: { pagination: "cursor" as const, page: [], isDone: true, continueCursor: "" },
        }
      : {
          ok: true as const,
          value: {
            pagination: "offset" as const,
            transactions: [],
            pageNumber: page,
            pageSize,
            totalCount: 0,
            totalCountCapped: false,
          },
        };
  }

  const currency = access.circle.currency;
  const searchArgs = {
    circleId: access.circle._id,
    viewerMemberId: access.membership._id,
    viewerIsOwner: access.isOwner,
    status: common.status,
    paidByMemberIds: common.paidByMemberIds.ids,
    recordedByMemberIds: common.recordedByMemberIds.ids,
    start: window.start,
    endExclusive: window.endExclusive,
    filters: {
      type: common.type,
      categoryIds: common.categoryIds.ids,
      amountMin: filters.amountMin,
      amountMax: filters.amountMax,
      queryText: common.queryText,
    },
  };

  if (args.paginationOpts) {
    const result = await collectTransactionViews(ctx, {
      ...searchArgs,
      paginationOpts: args.paginationOpts,
    });
    return {
      ok: true as const,
      value: {
        pagination: "cursor" as const,
        page: result.page.map((txn) => toMcpTransactionSummaryView(txn, currency)),
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      },
    };
  }

  const result = await searchTransactionsOffsetPage(ctx, {
    ...searchArgs,
    page,
    pageSize,
  });
  return {
    ok: true as const,
    value: {
      pagination: "offset" as const,
      transactions: result.transactions.map((txn) => toMcpTransactionSummaryView(txn, currency)),
      pageNumber: result.pageNumber,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      totalCountCapped: result.totalCountCapped,
    },
  };
}

/** Shared explicit-User Transaction search for web-shaped filters and MCP (#322). */
export async function searchTransactionsForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: McpSearchTransactionsArgs,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    const pageSize = clampSearchPageSize(args.pageSize ?? TRANSACTION_LIST_PAGE_SIZE);
    const page = clampSearchPage(args.page ?? 1);
    return args.paginationOpts
      ? {
          ok: true as const,
          value: { pagination: "cursor" as const, page: [], isDone: true, continueCursor: "" },
        }
      : {
          ok: true as const,
          value: {
            pagination: "offset" as const,
            transactions: [],
            pageNumber: page,
            pageSize,
            totalCount: 0,
            totalCountCapped: false,
          },
        };
  }
  return mapSearchTransactionsForAccess(ctx, access, args);
}

export async function getTransactionForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  transactionRef: string,
  user: Doc<"users">,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return null;
  }
  const transactionId = resolveTransactionRef(ctx, transactionRef);
  if (!transactionId) {
    return null;
  }
  const txn = await ctx.db.get(transactionId);
  if (!txn || txn.circleId !== circleId) {
    return null;
  }
  const detail = await toTransactionDetailView(
    ctx,
    txn,
    newViewCaches(),
    access.membership._id,
    access.isOwner,
  );
  return toMcpTransactionDetailView(detail, access.circle.currency);
}

export async function listTransactionHistoryForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  transactionRef: string,
  user: Doc<"users">,
  paginationOpts: PaginationOptions,
) {
  const emptyPage = { page: [], isDone: true, continueCursor: "" };
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return emptyPage;
  }
  const transactionId = resolveTransactionRef(ctx, transactionRef);
  if (!transactionId) {
    return emptyPage;
  }
  const txn = await ctx.db.get(transactionId);
  if (!txn || txn.circleId !== circleId) {
    return emptyPage;
  }
  const result = await paginateEntityHistory(
    ctx,
    transactionEntity(transactionId, access.circle._id),
    paginationOpts,
  );
  const cache = newActorCache();
  const page = await Promise.all(result.page.map((event) => toHistoryEventView(ctx, event, cache)));
  return {
    ...result,
    page: page.map((event) => ({
      ...event,
      actor: event.actor
        ? { ...event.actor, image: normalizeMcpImage(event.actor.image ?? null) }
        : null,
    })),
  };
}
