import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  canonicalEmail,
  DEFAULT_CURRENCY,
  initials,
  isSupportedCurrency,
  PERSONAL_CIRCLE_COLOR_ID,
  personalCircleName,
} from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { accountDeletionBlockerFields } from "./accountDeletionBlockers.js";

/**
 * Bootstrap helpers for new User creation. These hold no dependency on the
 * Better Auth wiring (that lives in auth.ts), so they are easy to unit-test
 * with convex-test. Permission and lifecycle checks live in guard.ts (ADR 0015).
 */

export interface NewUserProfile {
  email: string;
  displayName: string;
  image?: string;
  currency?: string;
}

/**
 * Creates the PocketCircle User and their always-solo Personal Circle (PRD
 * stories 1, 3, 4). Invoked by the Better Auth `onCreateUser` trigger on first
 * sign-in, and reusable as the bootstrap invariant in tests.
 */
export async function createUserWithPersonalCircle(
  ctx: MutationCtx,
  profile: NewUserProfile,
): Promise<Id<"users">> {
  const now = Date.now();
  const personalName = personalCircleName(profile.displayName);

  const userId = await ctx.db.insert("users", {
    email: canonicalEmail(profile.email),
    displayName: profile.displayName,
    image: profile.image,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
    acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
    acceptedAt: now,
    analyticsEnabled: true,
    onboardingCompletedAt: null,
    createdAt: now,
  });

  const currency =
    profile.currency && isSupportedCurrency(profile.currency) ? profile.currency : DEFAULT_CURRENCY;

  const circleId = await ctx.db.insert("circles", {
    name: personalName,
    kind: "personal",
    currency,
    color: PERSONAL_CIRCLE_COLOR_ID,
    mark: initials(personalName),
    ownerUserId: userId,
    status: "active",
    currencyLocked: false,
    setupCompletedAt: now,
    ...accountDeletionBlockerFields(
      { kind: "personal", status: "active", setupCompletedAt: now },
      1,
    ),
    createdAt: now,
  });

  await ctx.db.insert("members", {
    circleId,
    userId,
    role: "owner",
    status: "active",
    displayName: profile.displayName,
    image: profile.image,
    joinedAt: now,
  });

  // Empty Activation Checklist row so New Users skip the existing-User evidence path
  // (ADR 0030). Writers only fill timestamps; they never fabricate completion.
  await ctx.db.insert("userActivation", { userId, initializedAt: now });

  return userId;
}

/** The User's Personal Circle, if present — at most one per owner (PRD story 1). */
export async function getPersonalCircleForOwner(
  ctx: QueryCtx | MutationCtx,
  ownerUserId: Id<"users">,
): Promise<Doc<"circles"> | null> {
  return await ctx.db
    .query("circles")
    .withIndex("by_owner_and_kind", (q) => q.eq("ownerUserId", ownerUserId).eq("kind", "personal"))
    .first();
}

/**
 * Keeps the Personal Circle aligned with the User's Display Name (USR-1).
 * Name auto-tracks only while `personalNameCustomizedAt` is absent; after a manual
 * rename the name is left alone. Mark always derives from the circle's current name
 * via `initials()`. Patches directly — no Circle History event.
 */
export async function reconcilePersonalCircleFromDisplayName(
  ctx: MutationCtx,
  ownerUserId: Id<"users">,
  displayName: string,
): Promise<void> {
  const personalCircle = await getPersonalCircleForOwner(ctx, ownerUserId);
  if (!personalCircle) {
    return;
  }

  const patch: Partial<Doc<"circles">> = {};

  if (personalCircle.personalNameCustomizedAt === undefined) {
    const reconciledName = personalCircleName(displayName);
    if (personalCircle.name !== reconciledName) {
      patch.name = reconciledName;
    }
  }

  const nextMark = initials(patch.name ?? personalCircle.name);
  if (personalCircle.mark !== nextMark) {
    patch.mark = nextMark;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(personalCircle._id, patch);
  }
}

/**
 * Mirrors a User's owned Display Name onto their PocketCircle User row and every
 * ACTIVE membership's materialized identity (ADR 0018, USR-1). Removed memberships
 * are left untouched so they stay frozen at the name they showed when the Member
 * left. Profile Picture is not synced here — Google seeds it once (ADR 0024).
 */
export async function setUserDisplayName(
  ctx: MutationCtx,
  userId: Id<"users">,
  displayName: string,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) {
    return;
  }

  await ctx.db.patch(userId, { displayName });

  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const membership of memberships) {
    if (membership.status === "active") {
      await ctx.db.patch(membership._id, { displayName });
    }
  }
}

/**
 * Keeps the PocketCircle User's Google Account Email current (ADR 0024). Email is
 * not part of materialized member identity, so this is a single-row patch.
 */
export async function syncUserEmail(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) {
    return;
  }
  await ctx.db.patch(userId, { email: canonicalEmail(email) });
}
