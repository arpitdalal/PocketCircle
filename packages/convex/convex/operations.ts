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

/** Loads one Circle through the explicit-User access path. */
export async function getMcpCircleForUser(
  ctx: OperationReader,
  circleRef: string,
  user: Doc<"users">,
) {
  const circleId = resolveCircleRef(ctx, circleRef);
  if (!circleId) {
    return null;
  }
  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  return access ? toMcpCircleView(access.circle, access.isOwner) : null;
}

export function toMcpMemberView(
  member: Doc<"members">,
  identity: Awaited<ReturnType<typeof resolveMemberIdentity>>,
  currentMemberId: Doc<"members">["_id"],
) {
  return {
    id: member._id,
    displayName: identity.displayName,
    image: identity.image ?? null,
    role: member.role,
    status: identity.status,
    joinedAt: member.joinedAt,
    isSelf: member._id === currentMemberId,
  };
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
    visible.map(async (member) => {
      const identity = await resolveMemberIdentity(ctx, member);
      return {
        id: member._id,
        displayName: identity.displayName,
        image: identity.image,
        role: member.role,
        status: identity.status,
        joinedAt: member.joinedAt,
        isSelf: member._id === access.membership._id,
      };
    }),
  );
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
  const emptyPage = { page: [], isDone: true, continueCursor: "" };
  if (!access) {
    return emptyPage;
  }

  const result = includeHistorical
    ? await ctx.db
        .query("members")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .order("asc")
        .paginate(paginationOpts)
    : await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .order("asc")
        .paginate(paginationOpts);

  const page = [];
  for (const member of result.page) {
    if (!includeHistorical && !(await isEffectiveActiveMember(ctx, member))) {
      continue;
    }
    const identity = await resolveMemberIdentity(ctx, member);
    page.push(toMcpMemberView(member, identity, access.membership._id));
  }
  return { ...result, page };
}

/** Shared explicit-User Circle History read used by web and MCP. */
export async function listCircleHistoryForUser(
  ctx: OperationReader,
  circleId: Id<"circles">,
  user: Doc<"users">,
  paginationOpts: PaginationOptions,
) {
  const emptyPage = { page: [], isDone: true, continueCursor: "" };
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
