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
  comparisonWindowMonths,
  isValidPlainMonth,
  normalizeMcpImage,
  parseRef,
  TRANSACTION_LIST_PAGE_SIZE,
} from "@pocketcircle/domain";
import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import {
  type CategoryDetailView,
  type CategoryView,
  filterCategoriesForAccess,
  getCategoryForAccess,
  listCategoryHistoryForAccess,
  listRecentCategoryTransactionsForAccess,
} from "./categories.js";
import { type AuthorizedCircle, resolveCircleAccessForUser } from "./guard.js";
import { circleEntity, paginateEntityHistory, transactionEntity } from "./history.js";
import { newActorCache, toHistoryEventView } from "./historyView.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";
import { toMemberView } from "./memberViews.js";
import { collectMonthActiveTransactions, monthDateRange, sumMonthTotals } from "./monthActivity.js";
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
  paginateCircleTransactionsForAccess,
  type TransactionDetailView,
  type TransactionView,
  toTransactionDetailView,
  toTransactionView,
} from "./transactions.js";

export type { OperationReader } from "./operationReader.js";

/** Dashboard recent feed cap (PRD story 75). Shared by web Dashboard and MCP. */
export const RECENT_TRANSACTIONS_LIMIT = 5;

export async function monthlyLedgerSummaryForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  month: string,
) {
  const monthTxns = await collectMonthActiveTransactions(ctx, access.circle._id, month);
  return {
    totals: sumMonthTotals(monthTxns),
    currency: access.circle.currency,
  };
}

export async function paginateMonthlyLedgerTransactionsForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  month: string,
  paginationOpts: PaginationOptions,
) {
  return paginateCircleTransactionsForAccess(ctx, access, paginationOpts, {
    month,
    status: "active",
  });
}

export async function dashboardForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  month: string,
) {
  const monthTxns = await collectMonthActiveTransactions(ctx, access.circle._id, month);
  const recentDocs = [...monthTxns]
    .sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime)
    .slice(0, RECENT_TRANSACTIONS_LIMIT);
  const caches = newViewCaches();
  const recent = await Promise.all(
    recentDocs.map((txn) =>
      toTransactionView(ctx, txn, caches, access.membership._id, access.isOwner),
    ),
  );
  return {
    totals: sumMonthTotals(monthTxns),
    recent,
    currency: access.circle.currency,
    month,
  };
}

export async function monthlyComparisonForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  endMonth: string,
  rangeMonths: 1 | 3 | 6 | 12,
) {
  const series = await Promise.all(
    comparisonWindowMonths(endMonth, rangeMonths).map(async (month) => {
      const monthTxns = await collectMonthActiveTransactions(ctx, access.circle._id, month);
      return { month, ...sumMonthTotals(monthTxns) };
    }),
  );
  return { series, currency: access.circle.currency };
}

function compareCategoryAnalyticsSort(
  a: { taggedTotalMinor: number; name: string; ref: string },
  b: { taggedTotalMinor: number; name: string; ref: string },
) {
  return (
    b.taggedTotalMinor - a.taggedTotalMinor ||
    a.name.localeCompare(b.name) ||
    a.ref.localeCompare(b.ref)
  );
}

export async function categoryAnalyticsForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  month: string,
  type?: "expense" | "income",
) {
  const monthTxns = await collectMonthActiveTransactions(ctx, access.circle._id, month);
  const scopedTxns = type ? monthTxns.filter((txn) => txn.type === type) : monthTxns;

  const linkLoads = await asyncMapChunked(scopedTxns, DEFAULT_READ_CONCURRENCY, async (txn) => ({
    txn,
    links: await ctx.db
      .query("transactionCategories")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect(),
  }));

  const accum = new Map<Id<"categories">, { taggedTotalMinor: number; txnCount: number }>();
  for (const { txn, links } of linkLoads) {
    for (const link of links) {
      const existing = accum.get(link.categoryId) ?? { taggedTotalMinor: 0, txnCount: 0 };
      existing.taggedTotalMinor += txn.amountMinorUnits;
      existing.txnCount += 1;
      accum.set(link.categoryId, existing);
    }
  }

  const categoryIds = [...accum.keys()];
  const loadedCategories = await asyncMapChunked(
    categoryIds,
    DEFAULT_READ_CONCURRENCY,
    (categoryId) => ctx.db.get(categoryId),
  );
  const rows = [];
  for (const [index, categoryId] of categoryIds.entries()) {
    const category = loadedCategories[index];
    if (!category) {
      continue;
    }
    const totals = accum.get(categoryId);
    if (!totals) {
      continue;
    }
    rows.push({
      categoryId,
      name: category.name,
      color: category.color,
      status: category.status,
      taggedTotalMinor: totals.taggedTotalMinor,
      txnCount: totals.txnCount,
    });
  }

  rows.sort((a, b) =>
    compareCategoryAnalyticsSort(
      {
        taggedTotalMinor: a.taggedTotalMinor,
        name: a.name,
        ref: buildRef(a.name, a.categoryId),
      },
      {
        taggedTotalMinor: b.taggedTotalMinor,
        name: b.name,
        ref: buildRef(b.name, b.categoryId),
      },
    ),
  );

  return { rows, currency: access.circle.currency };
}

const MCP_CATEGORY_ANALYTICS_DEFAULT_PAGE_SIZE = 50;

type CategoryAnalyticsPageRow = {
  ref: string;
  name: string;
  taggedTotalMinor: number;
  txnCount: number;
};

type CategoryAnalyticsCursor = {
  revision: string;
  taggedTotalMinor: number;
  name: string;
  ref: string;
};

function computeCategoryAnalyticsRankingRevision(rows: readonly CategoryAnalyticsPageRow[]) {
  let hash = 2_166_136_261;
  for (const row of rows) {
    const chunk = `${row.ref}:${row.taggedTotalMinor}:${row.txnCount}`;
    for (let index = 0; index < chunk.length; index++) {
      hash ^= chunk.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return `${rows.length}:${hash >>> 0}`;
}

function parseCategoryAnalyticsCursor(cursor: string | null) {
  if (!cursor) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "revision" in parsed &&
      "taggedTotalMinor" in parsed &&
      "name" in parsed &&
      "ref" in parsed &&
      typeof parsed.revision === "string" &&
      typeof parsed.taggedTotalMinor === "number" &&
      typeof parsed.name === "string" &&
      typeof parsed.ref === "string"
    ) {
      return {
        revision: parsed.revision,
        taggedTotalMinor: parsed.taggedTotalMinor,
        name: parsed.name,
        ref: parsed.ref,
      } satisfies CategoryAnalyticsCursor;
    }
  } catch {
    return null;
  }
  return null;
}

function encodeCategoryAnalyticsCursor(row: CategoryAnalyticsPageRow, revision: string) {
  return JSON.stringify({
    revision,
    taggedTotalMinor: row.taggedTotalMinor,
    name: row.name,
    ref: row.ref,
  });
}

function paginateSortedCategoryAnalyticsRows<T extends CategoryAnalyticsPageRow>(
  rows: readonly T[],
  paginationOpts: PaginationOptions,
  rankingRevision: string,
) {
  const numItems = Math.min(Math.max(paginationOpts.numItems, 1), 100);
  const cursor = parseCategoryAnalyticsCursor(paginationOpts.cursor);
  if (paginationOpts.cursor && cursor === null) {
    return { stale: true as const };
  }
  if (cursor !== null && cursor.revision !== rankingRevision) {
    return { stale: true as const };
  }
  const remaining = cursor
    ? rows.filter((row) => compareCategoryAnalyticsSort(cursor, row) < 0)
    : rows;
  const page = remaining.slice(0, numItems);
  const isDone = page.length < numItems || page.length === remaining.length;
  const last = page.at(-1);
  return {
    stale: false as const,
    page,
    isDone,
    continueCursor: isDone || !last ? "" : encodeCategoryAnalyticsCursor(last, rankingRevision),
    rankingRevision,
  };
}

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

/** Resolves a canonical or bare Category reference without exposing lookup errors. */
export function resolveCategoryRef(ctx: OperationReader, categoryRef: string) {
  const parsed = parseRef(
    categoryRef,
    (candidate) => ctx.db.normalizeId("categories", candidate) !== null,
  );
  if (parsed) {
    return ctx.db.normalizeId("categories", parsed.id);
  }
  return ctx.db.normalizeId("categories", categoryRef);
}

function toMcpCategoryCreatorView(creator: CategoryView["creator"]) {
  return {
    displayName: creator.displayName,
    image: normalizeMcpImage(creator.image ?? null),
  };
}

function toMcpCategorySummaryView(category: CategoryView) {
  return {
    ref: category.ref,
    name: category.name,
    type: category.type,
    color: category.color,
    status: category.status,
    creator: toMcpCategoryCreatorView(category.creator),
  };
}

function toMcpCategoryDetailView(category: CategoryDetailView) {
  return {
    ...toMcpCategorySummaryView(category),
    canEditFields: category.canEditFields,
    canArchive: category.canArchive,
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

export { type MemberView, toMemberView } from "./memberViews.js";

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
    if (filters.dateFrom !== undefined || filters.dateTo !== undefined) {
      return { ok: false as const };
    }
    if (!isValidPlainMonth(filters.month)) {
      return { ok: false as const };
    }
    const range = monthDateRange(filters.month);
    return { ok: true as const, start: range.start, endExclusive: range.endExclusive };
  }
  return resolveSearchWindow({
    dateFrom: filters?.dateFrom,
    dateTo: filters?.dateTo,
  });
}

function mcpSearchPaginationConflict(args: McpSearchTransactionsArgs) {
  return (
    args.paginationOpts !== undefined && (args.page !== undefined || args.pageSize !== undefined)
  );
}

async function mapSearchTransactionsForAccess(
  ctx: OperationReader,
  access: NonNullable<Awaited<ReturnType<typeof resolveCircleAccessForUser>>>,
  args: McpSearchTransactionsArgs,
) {
  if (mcpSearchPaginationConflict(args)) {
    return { ok: false as const, error: "invalid_filters" as const };
  }
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

/** Shared explicit-User Monthly Ledger read for MCP (#323). */
export async function getMonthlyLedgerForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: { month: string; paginationOpts?: PaginationOptions },
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return { ok: false as const, error: "circle_inaccessible" as const };
  }
  if (!isValidPlainMonth(args.month)) {
    return { ok: false as const, error: "invalid_filters" as const };
  }

  const paginationOpts = args.paginationOpts ?? {
    numItems: TRANSACTION_LIST_PAGE_SIZE,
    cursor: null,
  };
  const summary = await monthlyLedgerSummaryForAccess(ctx, access, args.month);
  const transactions = await paginateMonthlyLedgerTransactionsForAccess(
    ctx,
    access,
    args.month,
    paginationOpts,
  );

  return {
    ok: true as const,
    value: {
      month: args.month,
      ...summary,
      transactions: {
        ...transactions,
        page: transactions.page.map((txn) =>
          toMcpTransactionSummaryView(txn, access.circle.currency),
        ),
      },
    },
  };
}

/** Shared explicit-User Dashboard read for MCP (#323). */
export async function getDashboardForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: { month: string },
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return { ok: false as const, error: "circle_inaccessible" as const };
  }

  if (!isValidPlainMonth(args.month)) {
    return { ok: false as const, error: "invalid_filters" as const };
  }

  const dashboard = await dashboardForAccess(ctx, access, args.month);
  return {
    ok: true as const,
    value: {
      ...dashboard,
      recent: dashboard.recent.map((txn) =>
        toMcpTransactionSummaryView(txn, access.circle.currency),
      ),
    },
  };
}

/** Shared explicit-User monthly comparison read for MCP (#323). */
export async function getMonthlyComparisonForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: { endMonth: string; rangeMonths: 1 | 3 | 6 | 12 },
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return { ok: false as const, error: "circle_inaccessible" as const };
  }

  if (!isValidPlainMonth(args.endMonth)) {
    return { ok: false as const, error: "invalid_filters" as const };
  }

  return {
    ok: true as const,
    value: await monthlyComparisonForAccess(ctx, access, args.endMonth, args.rangeMonths),
  };
}

/** Shared explicit-User category analytics read for MCP (#323). */
export async function getCategoryAnalyticsForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: {
    month: string;
    type: "expense" | "income";
    paginationOpts?: PaginationOptions;
  },
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return { ok: false as const, error: "circle_inaccessible" as const };
  }

  if (!isValidPlainMonth(args.month)) {
    return { ok: false as const, error: "invalid_filters" as const };
  }

  const paginationOpts = args.paginationOpts ?? {
    numItems: MCP_CATEGORY_ANALYTICS_DEFAULT_PAGE_SIZE,
    cursor: null,
  };
  const analytics = await categoryAnalyticsForAccess(ctx, access, args.month, args.type);
  const mcpRows = analytics.rows.map((row) => ({
    ref: buildRef(row.name, row.categoryId),
    name: row.name,
    color: row.color,
    status: row.status,
    taggedTotalMinor: row.taggedTotalMinor,
    txnCount: row.txnCount,
  }));
  const rankingRevision = computeCategoryAnalyticsRankingRevision(mcpRows);
  const page = paginateSortedCategoryAnalyticsRows(mcpRows, paginationOpts, rankingRevision);
  if (page.stale) {
    return { ok: false as const, error: "stale_pagination" as const };
  }
  return {
    ok: true as const,
    value: {
      month: args.month,
      type: args.type,
      nonAdditive: true as const,
      currency: analytics.currency,
      rankingRevision: page.rankingRevision,
      page: page.page,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    },
  };
}

export type McpListCategoriesArgs = {
  filters?: {
    type?: "all" | "expense" | "income";
    status?: "active" | "archived" | "all";
    query?: string;
  };
  paginationOpts?: PaginationOptions;
};

/** Shared explicit-User Category list read for MCP (#324). */
export async function listCategoriesForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  args: McpListCategoriesArgs,
) {
  const emptyPage = emptyPaginationPage();
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return emptyPage;
  }
  const filters = args.filters ?? {};
  return filterCategoriesForAccess(ctx, access, {
    type: filters.type ?? "all",
    status: filters.status ?? "active",
    ...(filters.query === undefined ? {} : { query: filters.query }),
    paginationOpts: args.paginationOpts ?? { numItems: 50, cursor: null },
  }).then((result) => ({
    ...result,
    page: result.page.map(toMcpCategorySummaryView),
  }));
}

/** Shared explicit-User Category Detail read for MCP (#324). */
export async function getCategoryForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  categoryRef: string,
  user: Doc<"users">,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return null;
  }
  const categoryId = resolveCategoryRef(ctx, categoryRef);
  if (!categoryId) {
    return null;
  }
  const category = await getCategoryForAccess(ctx, access, categoryId);
  return category ? toMcpCategoryDetailView(category) : null;
}

/** Shared explicit-User Category recent Transactions read for MCP (#324). */
export async function listCategoryTransactionsForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  categoryRef: string,
  user: Doc<"users">,
) {
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return [];
  }
  const categoryId = resolveCategoryRef(ctx, categoryRef);
  if (!categoryId) {
    return [];
  }
  const transactions = await listRecentCategoryTransactionsForAccess(ctx, access, categoryId);
  return transactions.map((txn) => toMcpTransactionSummaryView(txn, access.circle.currency));
}

/** Shared explicit-User Category History read for MCP (#324). */
export async function listCategoryHistoryForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  categoryRef: string,
  user: Doc<"users">,
  paginationOpts: PaginationOptions,
) {
  const emptyPage = emptyPaginationPage();
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return emptyPage;
  }
  const categoryId = resolveCategoryRef(ctx, categoryRef);
  if (!categoryId) {
    return emptyPage;
  }
  const history = await listCategoryHistoryForAccess(ctx, access, categoryId, paginationOpts);
  return {
    ...history,
    page: history.page.map((event) => ({
      ...event,
      actor: event.actor
        ? { ...event.actor, image: normalizeMcpImage(event.actor.image ?? null) }
        : null,
    })),
  };
}
