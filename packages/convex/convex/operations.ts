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

import { buildRef } from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import { resolveCircleAccessForUser } from "./guard.js";
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
async function listActiveMembershipsWithCirclesForUser(ctx: OperationReader, user: Doc<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();

  const entries: { membership: Doc<"members">; circle: Doc<"circles"> }[] = [];
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
  const allowedSet = new Set(grant.allowedCircleIds);
  const entries = await listActiveMembershipsWithCirclesForUser(ctx, user);

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
