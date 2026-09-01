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

import { buildRef, parseRef } from "@pocketcircle/domain";
import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import { resolveCircleAccessForUser } from "./guard.js";
import { circleEntity, paginateEntityHistory } from "./history.js";
import { newActorCache, toHistoryEventView } from "./historyView.js";
import { isEffectiveActiveMember, resolveMemberIdentity } from "./memberIdentity.js";
import type { OperationReader } from "./operationReader.js";

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
    image: user.image ?? null,
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
    image: member.image ?? null,
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
  ownerIncluded: boolean;
  memberCursor: string | null;
}

interface ActiveMemberPageCursor {
  ownerIncluded: boolean;
  lastJoinedAt: number | null;
  lastMemberId: string | null;
}

function decodeMemberPageCursor(cursor: string) {
  try {
    const value: unknown = JSON.parse(cursor);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    if (!("ownerIncluded" in value) || typeof value.ownerIncluded !== "boolean") {
      return null;
    }
    if (
      !("memberCursor" in value) ||
      (value.memberCursor !== null && typeof value.memberCursor !== "string")
    ) {
      return null;
    }
    return { ownerIncluded: value.ownerIncluded, memberCursor: value.memberCursor };
  } catch {
    return null;
  }
}

function encodeMemberPageCursor(cursor: MemberPageCursor) {
  return JSON.stringify(cursor);
}

function decodeActiveMemberPageCursor(cursor: string) {
  try {
    const value: unknown = JSON.parse(cursor);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    if (!("ownerIncluded" in value) || typeof value.ownerIncluded !== "boolean") {
      return null;
    }
    if (
      !("lastJoinedAt" in value) ||
      (value.lastJoinedAt !== null &&
        (typeof value.lastJoinedAt !== "number" || !Number.isInteger(value.lastJoinedAt)))
    ) {
      return null;
    }
    if (
      !("lastMemberId" in value) ||
      (value.lastMemberId !== null && typeof value.lastMemberId !== "string")
    ) {
      return null;
    }
    return {
      ownerIncluded: value.ownerIncluded,
      lastJoinedAt: value.lastJoinedAt,
      lastMemberId: value.lastMemberId,
    };
  } catch {
    return null;
  }
}

function encodeActiveMemberPageCursor(cursor: ActiveMemberPageCursor) {
  return JSON.stringify(cursor);
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

  if (!includeHistorical) {
    const decodedCursor = paginationOpts.cursor
      ? decodeActiveMemberPageCursor(paginationOpts.cursor)
      : { ownerIncluded: false, lastJoinedAt: null, lastMemberId: null };
    if (!decodedCursor) {
      return emptyPage;
    }

    const owner = decodedCursor.ownerIncluded
      ? null
      : await ctx.db
          .query("members")
          .withIndex("by_circle_and_user", (q) =>
            q.eq("circleId", circleId).eq("userId", access.circle.ownerUserId),
          )
          .unique();
    const ownerIsVisible = owner !== null && (await isEffectiveActiveMember(ctx, owner));
    const ownerView = ownerIsVisible ? await toMemberView(ctx, owner, access.membership._id) : null;
    const storedActiveMembers = await ctx.db
      .query("members")
      .withIndex("by_circle_and_role_status_joinedAt", (q) =>
        q.eq("circleId", circleId).eq("role", "member").eq("status", "active"),
      )
      .collect();
    const visibleMembers = [];
    for (const member of storedActiveMembers) {
      if (await isEffectiveActiveMember(ctx, member)) {
        visibleMembers.push(member);
      }
    }
    visibleMembers.sort((a, b) =>
      a.joinedAt === b.joinedAt ? a._id.localeCompare(b._id) : a.joinedAt - b.joinedAt,
    );
    const { lastJoinedAt, lastMemberId } = decodedCursor;
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

    if (ownerView && paginationOpts.numItems === 1 && !decodedCursor.ownerIncluded) {
      const hasMembers = visibleMembers.length > 0;
      return {
        page: [toMcpMemberView(ownerView)],
        isDone: !hasMembers,
        continueCursor: hasMembers
          ? encodeActiveMemberPageCursor({
              ownerIncluded: true,
              lastJoinedAt: null,
              lastMemberId: null,
            })
          : "",
      };
    }

    const memberItems =
      ownerView && !decodedCursor.ownerIncluded
        ? paginationOpts.numItems - 1
        : paginationOpts.numItems;
    const memberPage = visibleMembers.slice(memberStart, memberStart + memberItems);
    const members = await Promise.all(
      memberPage.map(async (member) =>
        toMcpMemberView(await toMemberView(ctx, member, access.membership._id)),
      ),
    );
    const lastMember = memberPage.at(-1);
    const isDone = memberStart + memberPage.length >= visibleMembers.length;
    const page =
      ownerView && !decodedCursor.ownerIncluded
        ? [toMcpMemberView(ownerView), ...members]
        : members;
    return {
      page,
      isDone,
      continueCursor: isDone
        ? ""
        : encodeActiveMemberPageCursor({
            ownerIncluded: true,
            lastJoinedAt: lastMember?.joinedAt ?? null,
            lastMemberId: lastMember?._id ?? null,
          }),
    };
  }

  const decodedCursor = paginationOpts.cursor
    ? decodeMemberPageCursor(paginationOpts.cursor)
    : { ownerIncluded: false, memberCursor: null };
  if (!decodedCursor) {
    return emptyPage;
  }

  const owner = decodedCursor.ownerIncluded
    ? null
    : await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", access.circle.ownerUserId),
        )
        .unique();
  const ownerIsVisible =
    owner !== null && (includeHistorical || (await isEffectiveActiveMember(ctx, owner)));
  const ownerView = ownerIsVisible ? await toMemberView(ctx, owner, access.membership._id) : null;
  const memberQuery = ctx.db
    .query("members")
    .withIndex("by_circle_and_role_joinedAt", (q) =>
      q.eq("circleId", circleId).eq("role", "member"),
    )
    .order("asc");

  if (ownerView && paginationOpts.numItems === 1 && !decodedCursor.ownerIncluded) {
    const hasMembers = (await memberQuery.first()) !== null;
    return {
      page: [toMcpMemberView(ownerView)],
      isDone: !hasMembers,
      continueCursor: hasMembers
        ? encodeMemberPageCursor({ ownerIncluded: true, memberCursor: null })
        : "",
    };
  }

  const memberItems =
    ownerView && !decodedCursor.ownerIncluded
      ? paginationOpts.numItems - 1
      : paginationOpts.numItems;
  const result = await memberQuery.paginate({
    numItems: Math.max(1, memberItems),
    cursor: decodedCursor.memberCursor,
  });
  const members = [];
  for (const member of result.page) {
    if (!includeHistorical && !(await isEffectiveActiveMember(ctx, member))) {
      continue;
    }
    members.push(toMcpMemberView(await toMemberView(ctx, member, access.membership._id)));
  }
  const page =
    ownerView && !decodedCursor.ownerIncluded ? [toMcpMemberView(ownerView), ...members] : members;
  const isDone = result.isDone;
  return {
    page,
    isDone,
    continueCursor: isDone
      ? ""
      : encodeMemberPageCursor({ ownerIncluded: true, memberCursor: result.continueCursor }),
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
