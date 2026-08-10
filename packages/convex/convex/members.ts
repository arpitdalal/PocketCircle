import { MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { recomputeAccountDeletionBlockers } from "./accountDeletionBlockers.js";
import { requireCircleAccess, resolveCircleAccess } from "./guard.js";
import { circleEntity, recordEvent } from "./history.js";
import { isEffectiveActiveMember, resolveMemberIdentity } from "./memberIdentity.js";
import { notifyOwnershipTransferred, notifyRemovedFromCircle } from "./notify.js";

/**
 * A Member shaped for the client. Reads effective identity (USR-3): app User
 * absence is an immediate Deleted Member tombstone (Display Name kept, no image)
 * even before durable cleanup materializes `status: "deleted"`.
 */
export async function toMemberView(
  ctx: QueryCtx | MutationCtx,
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

/**
 * Lists a Circle's Members, effective-active-only by default, Owner first
 * (PRD story 43). Resolver query (ADR 0016): an inaccessible or missing Circle
 * returns `null`. `includeHistorical` widens to Removed + Deleted Members for
 * history/search/Paid-By-filter attribution (USR-3).
 */
export const listMembers = query({
  args: {
    circleId: v.id("circles"),
    includeHistorical: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null; // missing ≡ inaccessible (ADR 0016)
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
      .collect();

    const visible: Doc<"members">[] = [];
    for (const member of members) {
      if (args.includeHistorical) {
        visible.push(member);
        continue;
      }
      if (await isEffectiveActiveMember(ctx, member)) {
        visible.push(member);
      }
    }

    // Owner first, then stable by join time — a fixed anchor for the management
    // surfaces and the Paid By selector that consume this.
    visible.sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === "owner" ? -1 : 1;
      }
      return a.joinedAt - b.joinedAt;
    });

    return await Promise.all(
      visible.map((member) => toMemberView(ctx, member, access.membership._id)),
    );
  },
});

/**
 * Transfers Circle ownership to an active Member (MEM-7). Updates both
 * `members.role` and `circles.ownerUserId` atomically — they must stay in lockstep.
 * Archived Circles may still transfer (USR-3 narrow lifecycle exception).
 */
export const transferOwnership = mutation({
  args: {
    circleId: v.id("circles"),
    toMemberId: v.id("members"),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);

    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferForbidden));
    }

    if (access.circle.kind === "personal") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferPersonalCircle));
    }

    const targetMember = await ctx.db.get(args.toMemberId);
    if (!targetMember || targetMember.circleId !== args.circleId) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberNotFound));
    }

    if (!(await isEffectiveActiveMember(ctx, targetMember))) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferTargetNotMember));
    }

    if (targetMember.role === "owner") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferToSelf));
    }

    await ctx.db.patch(args.toMemberId, { role: "owner" });
    await ctx.db.patch(access.membership._id, { role: "member" });
    await ctx.db.patch(args.circleId, { ownerUserId: targetMember.userId });

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "ownership transferred",
      changes: [
        {
          field: "owner",
          from: access.membership.displayName,
          to: targetMember.displayName,
        },
      ],
    });

    await recomputeAccountDeletionBlockers(ctx, args.circleId);

    await notifyOwnershipTransferred(ctx, {
      newOwnerUserId: targetMember.userId,
      actorUserId: access.user._id,
      circle: access.circle,
    });
  },
});

/**
 * Removes an active non-owner Member from a regular Circle (MEM-5). Status flip
 * only — the row stays so frozen identity and rejoin (MEM-3) keep working.
 */
export const removeMember = mutation({
  args: {
    circleId: v.id("circles"),
    memberId: v.id("members"),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);

    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberRemoveForbidden));
    }

    access.assertWritable();

    if (access.circle.kind === "personal") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberNotFound));
    }

    const target = await ctx.db.get(args.memberId);
    if (!target || target.circleId !== args.circleId) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberNotFound));
    }

    if (target.role === "owner") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberCannotRemoveOwner));
    }

    if (!(await isEffectiveActiveMember(ctx, target))) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberNotFound));
    }

    const now = Date.now();
    await ctx.db.patch(args.memberId, { status: "removed", removedAt: now });

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "member removed",
      changes: [{ field: "member", from: target.displayName }],
    });

    await recomputeAccountDeletionBlockers(ctx, args.circleId);

    await notifyRemovedFromCircle(ctx, {
      removedUserId: target.userId,
      actorUserId: access.user._id,
      circle: access.circle,
    });
  },
});

/**
 * A Member removes themselves from a regular Circle (PRD 18, MEM-6). Status flip,
 * never delete — the same row is reactivated on rejoin (MEM-3). Owners must transfer
 * first (MEM-7); Personal Circles are always solo and cannot be left.
 */
export const leaveCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);

    if (access.circle.kind === "personal") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.leavePersonalCircle));
    }

    if (access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.ownerMustTransfer));
    }

    // Leaving is not gated on `assertWritable()` — an archived Circle's members may
    // still exit; the status flip preserves frozen identity regardless of Circle lifecycle.

    const now = Date.now();
    await ctx.db.patch(access.membership._id, { status: "removed", removedAt: now });

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "member left",
      changes: [{ field: "member", from: access.membership.displayName }],
    });

    await recomputeAccountDeletionBlockers(ctx, args.circleId);
  },
});
