/**
 * Shared domain operations for an already-resolved PocketCircle User (#316).
 *
 * Browser-authenticated public queries resolve the User from Better Auth, then
 * call these. Trusted server entry points (future MCP bridge) pass an explicit
 * User without a browser session. Ops take only the DB reader they need — not
 * public Convex functions and not a full server ctx — so a Worker never gets
 * raw DB access or browser auth APIs.
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
export async function resolveUserById(
  ctx: OperationReader,
  userId: Id<"users"> | string,
): Promise<Doc<"users"> | null> {
  const id = typeof userId === "string" ? ctx.db.normalizeId("users", userId) : userId;
  if (!id) {
    return null;
  }
  return await ctx.db.get(id);
}

/**
 * Current-User view the protected layout and settings read (ADR 0003). Derived
 * from the User row so the client cannot drift from the backend contract.
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

/** Current-User view for an already-resolved User (no session required). */
export function getCurrentUserForUser(user: Doc<"users">) {
  return toCurrentUserView(user);
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

/**
 * Circles the User is an active Member of (Circle Visibility): Personal Circle
 * first, then by creation time. Includes Archived Circles; excludes removed
 * memberships and missing Circles (missing ≡ inaccessible, not an error).
 */
export async function listMyCirclesForUser(ctx: OperationReader, user: Doc<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();

  const circles: Doc<"circles">[] = [];
  for (const membership of memberships) {
    if (membership.status !== "active") {
      continue;
    }
    const circle = await ctx.db.get(membership.circleId);
    if (circle) {
      circles.push(circle);
    }
  }

  circles.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "personal" ? -1 : 1;
    }
    return a.createdAt - b.createdAt;
  });

  return circles.map(toCircleView);
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
