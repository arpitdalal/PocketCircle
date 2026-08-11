import { MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { getCurrentUserOrNull } from "./auth.js";

/**
 * The single Circle-access module (ADR 0015). Every Convex function that
 * operates on an existing Circle resolves identity, membership, and
 * capabilities through here instead of re-deriving them inline, so the
 * missing≡inaccessible rule (ADR 0016) and the read-only-when-archived rule each
 * have exactly one home.
 *
 * Two functions over one resolver:
 *   - `resolveCircleAccess` NEVER throws — a missing Circle, a non-member, a
 *     removed Member, and an unauthenticated caller all collapse to `null`. It
 *     feeds queries and the staged route guard (`circles.getCircle`).
 *   - `requireCircleAccess` is `resolve ?? throw` — the single home of the throw.
 *     It feeds mutations.
 * There is deliberately no `{ throwOnMissing }` flag: a boolean that flips the
 * error mode makes the return type conditional and callers get it wrong. Pick
 * resolve (null) or require (throw) at the call site.
 *
 * Boundary: this module is for operations on an EXISTING Circle. Circle-less
 * operations keep `requireCurrentUser` (auth.ts): `listMyCircles` (lists across
 * Circles), `createCircle` (no prior access), `users.setAnalyticsEnabled`.
 *
 * Capabilities here are Circle-level only (`isOwner`, `isWritable`,
 * `assertSetupComplete`). Entity-level permission — a Transaction editable only
 * by its Recorded By Member, a Category by its creator, the Owner able to archive
 * either — composes OVER this rather than being inlined; the intended shape:
 *
 *   async function requireTransactionAccess(ctx, txnId) {
 *     const txn = await ctx.db.get(txnId)
 *     const access = await requireCircleAccess(ctx, txn.circleId)  // reuse, don't re-derive
 *     return { ...access, transaction: txn,
 *       isRecorder: txn.recordedByMemberId === access.membership._id,
 *       canArchive: txn.recordedByMemberId === access.membership._id || access.isOwner }
 *   }
 *
 * (`canModerate` is intentionally absent: it would be a synonym for `isOwner`
 * today — one adapter, a hypothetical seam — and is added only when a non-owner
 * moderation case actually appears.)
 *
 * Setup completion (ADR 0023) is an OPT-IN write capability, not folded into
 * resolve/require:
 *   - Normal mutating handlers call `access.assertSetupComplete()` after access
 *     and existing permission/lifecycle checks.
 *   - Reads stay setup-agnostic after normal access control.
 *   - Transition/escape mutations (`createCircle`, `completeCircleSetup`,
 *     color-only settings, `deleteCircle`, `transferOwnership`, `leaveCircle`,
 *     `revokeInvitation`) intentionally skip the assertion.
 *
 * Canonical mutating-handler shape (the pattern to copy):
 *   const access = await requireCircleAccess(ctx, circleId)
 *   access.assertWritable()                  // skip for read-only queries
 *   access.assertSetupComplete()             // skip for setup transitions/escapes
 *   // ... perform the mutation ...
 *   await recordEvent(ctx, { entity, actor: access.membership, action, changes })
 */

/**
 * A Circle the caller can currently access, with their membership and the
 * Circle-level capabilities derived once. Returned by `resolveCircleAccess`
 * (nullable) and `requireCircleAccess` (non-null).
 */
export interface AuthorizedCircle {
  user: Doc<"users">;
  membership: Doc<"members">;
  circle: Doc<"circles">;
  /** The caller is the Circle's Owner. */
  isOwner: boolean;
  /** The Circle is active; an archived Circle is read-only (PRD story 79). */
  isWritable: boolean;
  /**
   * Throws coded `ConvexError` data unless the Circle is writable. Uses
   * `ConvexError` so the payload survives Convex production redaction (plain
   * `Error` messages become a generic "Server Error" on the client); other guard
   * throws stay plain errors by design (ADR 0016).
   */
  assertWritable(): void;
  /**
   * Throws coded `ConvexError` data unless Circle Setup is complete
   * (`setupCompletedAt !== null`). Opt-in at normal write handlers — not called
   * from resolve/require, entity accessors, or starter-seeding helpers (ADR 0023).
   */
  assertSetupComplete(): void;
}

/** Returns the caller's active membership in a Circle, or null when not an active member. */
export async function getActiveMembership(
  ctx: QueryCtx | MutationCtx,
  circleId: Id<"circles">,
  userId: Id<"users">,
): Promise<Doc<"members"> | null> {
  const membership = await ctx.db
    .query("members")
    .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", userId))
    .unique();
  if (membership?.status !== "active") {
    return null;
  }
  return membership;
}

function toAuthorizedCircle(
  user: Doc<"users">,
  membership: Doc<"members">,
  circle: Doc<"circles">,
): AuthorizedCircle {
  const isOwner = membership.role === "owner";
  const isWritable = circle.status === "active";
  return {
    user,
    membership,
    circle,
    isOwner,
    isWritable,
    assertWritable() {
      if (!isWritable) {
        throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived));
      }
    },
    assertSetupComplete() {
      if (circle.setupCompletedAt === null) {
        throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete));
      }
    },
  };
}

/**
 * Resolves Circle access for a known User without re-reading auth. Callers that
 * already hold the current User (e.g. a batched notification page) use this so
 * membership/circle lookups can be memoized per `circleId`.
 */
export async function resolveCircleAccessForUser(
  ctx: QueryCtx | MutationCtx,
  circleId: Id<"circles">,
  user: Doc<"users">,
): Promise<AuthorizedCircle | null> {
  const circle = await ctx.db.get(circleId);
  if (!circle) {
    return null;
  }
  const membership = await getActiveMembership(ctx, circleId, user._id);
  if (!membership) {
    return null;
  }
  return toAuthorizedCircle(user, membership, circle);
}

/**
 * Resolves Circle access without ever throwing. The single home of the
 * missing≡inaccessible rule (ADR 0016): an unauthenticated caller, a missing
 * Circle, a non-member, and a removed Member are all indistinguishable `null`.
 */
export async function resolveCircleAccess(
  ctx: QueryCtx | MutationCtx,
  circleId: Id<"circles">,
): Promise<AuthorizedCircle | null> {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) {
    return null;
  }
  return resolveCircleAccessForUser(ctx, circleId, user);
}

/**
 * Resolves Circle access or throws. The single home of the throw; feeds
 * mutations. Uses the same generic "Circle not found" message for missing and
 * inaccessible so nothing about a Circle's existence leaks (ADR 0016).
 *
 * Note this folds auth in: an UNAUTHENTICATED caller also gets "Circle not
 * found", not "Not authenticated". That is intentional — the UI never shows a
 * mutating form to an unauthenticated User (the protected layout gates the app,
 * ADR 0017), so this throw is reached only by a session that expired/was revoked
 * mid-flight or a direct API call, and in those cases the anti-enumeration stance
 * (ADR 0016) says not to confirm the Circle exists either. This is server-side
 * defense-in-depth (ADR 0015), independent of what the client rendered.
 */
export async function requireCircleAccess(
  ctx: QueryCtx | MutationCtx,
  circleId: Id<"circles">,
): Promise<AuthorizedCircle> {
  const access = await resolveCircleAccess(ctx, circleId);
  if (!access) {
    throw new Error("Circle not found");
  }
  return access;
}

/**
 * Circle access for an existing Transaction, with the entity-level capabilities
 * composed OVER {@link requireCircleAccess} — the shape promised in this module's
 * header, the single home of Transaction permission so handlers never re-derive
 * "is this the Recorded By Member?" inline (ADR 0015).
 *
 *   - `isRecorder` — the caller IS the Recorded By Member. It compares the
 *     Transaction's `recordedByMemberId` to the caller's RESOLVED `membership._id`,
 *     and since there is exactly one member row per (Circle, User) and rejoin
 *     reactivates that SAME row, a Removed→rejoined User naturally matches again
 *     and regains field-edit rights with no rejoin special-case (PRD stories 38,
 *     44). Only the Recorded By Member edits a Transaction's fields (TXN-2).
 *   - `canArchive` — Recorded By OR the Owner. The Owner moderates lifecycle
 *     (archive/restore — TXN-3) but may NOT edit another Member's fields, so the
 *     two capabilities are deliberately distinct.
 *
 * Anti-enumeration (ADR 0016): a missing Transaction and one whose Circle the
 * caller can't access collapse to the SAME "Transaction not found" throw, so
 * nothing about a Transaction's existence leaks. The entity here is the
 * Transaction, so the message names it (not the Circle).
 */
export interface AuthorizedTransaction extends AuthorizedCircle {
  transaction: Doc<"transactions">;
  /** The caller is the Recorded By Member (may edit fields — TXN-2). */
  isRecorder: boolean;
  /** The caller may archive/restore: Recorded By or the Owner (TXN-3). */
  canArchive: boolean;
}

export async function requireTransactionAccess(
  ctx: QueryCtx | MutationCtx,
  transactionId: Id<"transactions">,
): Promise<AuthorizedTransaction> {
  const transaction = await ctx.db.get(transactionId);
  if (!transaction) {
    throw new Error("Transaction not found");
  }
  // resolve (not require) so an inaccessible Circle throws the SAME entity-named
  // message as a missing Transaction — never the Circle-level "Circle not found",
  // which would leak that the Transaction (and its Circle) exists.
  const access = await resolveCircleAccess(ctx, transaction.circleId);
  if (!access) {
    throw new Error("Transaction not found");
  }
  const isRecorder = transaction.recordedByMemberId === access.membership._id;
  return { ...access, transaction, isRecorder, canArchive: isRecorder || access.isOwner };
}

/**
 * Circle access for an existing Category, with the entity-level capabilities
 * composed OVER {@link requireCircleAccess} — the same shape as
 * {@link requireTransactionAccess}, because Category permissions deliberately
 * mirror Transaction permissions (CAT-2; PRD stories 55, 56):
 *
 *   - `isCreator` — the caller IS the creating Member. Categories store
 *     `creatorUserId` (a User id, unlike a Transaction's Member id) because a
 *     Category is Circle-scoped data the creator owns across membership churn;
 *     comparing to the caller's resolved `user._id` means a Removed→rejoined
 *     creator naturally matches again and regains field-edit rights with no
 *     rejoin special-case (PRD 44 applied to Categories). Only the creator may
 *     rename or recolor — the Owner is NOT allowed here.
 *   - `canArchive` — creator OR the Owner. The Owner moderates lifecycle
 *     (archive/restore) but may not rewrite another Member's Category fields,
 *     so the two capabilities are deliberately distinct.
 *
 * Anti-enumeration (ADR 0016): a missing Category and one whose Circle the
 * caller can't access collapse to the SAME "Category not found" throw.
 */
export interface AuthorizedCategory extends AuthorizedCircle {
  category: Doc<"categories">;
  /** The caller created the Category (may edit name/color — CAT-2). */
  isCreator: boolean;
  /** The caller may archive/restore: the creator or the Owner (CAT-2). */
  canArchive: boolean;
}

export async function requireCategoryAccess(
  ctx: QueryCtx | MutationCtx,
  categoryId: Id<"categories">,
): Promise<AuthorizedCategory> {
  const category = await ctx.db.get(categoryId);
  if (!category) {
    throw new Error("Category not found");
  }
  // resolve (not require) so an inaccessible Circle throws the SAME entity-named
  // message as a missing Category (ADR 0016).
  const access = await resolveCircleAccess(ctx, category.circleId);
  if (!access) {
    throw new Error("Category not found");
  }
  const isCreator = category.creatorUserId === access.user._id;
  return { ...access, category, isCreator, canArchive: isCreator || access.isOwner };
}
