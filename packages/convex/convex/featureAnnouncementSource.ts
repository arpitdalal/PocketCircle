import { buildRef } from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { type QueryCtx, query } from "./_generated/server.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import { requireCurrentUser } from "./auth.js";
import { resolveCircleAccessForUser } from "./guard.js";

/**
 * Newest active Transaction in a Circle by record time (`createdAt`), not
 * Transaction Date. Feature Announcement CTA source selection (#282).
 */
async function newestActiveTransaction(ctx: QueryCtx, circleId: Id<"circles">) {
  return await ctx.db
    .query("transactions")
    .withIndex("by_circle_status_createdAt", (q) =>
      q.eq("circleId", circleId).eq("status", "active"),
    )
    .order("desc")
    .first();
}

function isEligibleAnnouncementCircle(circle: Doc<"circles">) {
  return circle.status === "active" && circle.setupCompletedAt !== null;
}

function sourceRefs(circle: Doc<"circles">, transaction: Doc<"transactions">) {
  return {
    circleRef: buildRef(circle.name, circle._id),
    transactionRef: buildRef(transaction.title, transaction._id),
  };
}

/**
 * Dedicated Feature Announcement CTA source (#282). Home Summary and list
 * queries apply unrelated filters/scopes — do not reuse them.
 *
 * - Omit `circleId`: newest active Transaction across the User's active,
 *   setup-complete visible Circles (Home).
 * - With `circleId`: newest active Transaction in that Circle when it is
 *   active, setup-complete, and visible to the caller.
 *
 * Returns only safe refs for Transaction Detail, or `null` (never why).
 */
export const getFeatureAnnouncementSource = query({
  args: { circleId: v.optional(v.id("circles")) },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);

    if (args.circleId !== undefined) {
      const access = await resolveCircleAccessForUser(ctx, args.circleId, user);
      if (!access || !isEligibleAnnouncementCircle(access.circle)) {
        return null;
      }
      const transaction = await newestActiveTransaction(ctx, access.circle._id);
      if (!transaction) {
        return null;
      }
      return sourceRefs(access.circle, transaction);
    }

    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user_and_status", (q) => q.eq("userId", user._id).eq("status", "active"))
      .collect();

    const candidates = await asyncMapChunked(
      memberships,
      DEFAULT_READ_CONCURRENCY,
      async (membership) => {
        const circle = await ctx.db.get(membership.circleId);
        if (!circle || !isEligibleAnnouncementCircle(circle)) {
          return null;
        }
        const transaction = await newestActiveTransaction(ctx, circle._id);
        if (!transaction) {
          return null;
        }
        return { circle, transaction };
      },
    );

    let best: { circle: Doc<"circles">; transaction: Doc<"transactions"> } | null = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (
        !best ||
        candidate.transaction.createdAt > best.transaction.createdAt ||
        (candidate.transaction.createdAt === best.transaction.createdAt &&
          candidate.transaction._creationTime > best.transaction._creationTime)
      ) {
        best = candidate;
      }
    }

    return best ? sourceRefs(best.circle, best.transaction) : null;
  },
});
