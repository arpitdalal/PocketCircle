import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";

/**
 * Denormalized Account Deletion blocker fields on `circles` (USR-3 / ADR 0029).
 * Personal Circles are never blocked. Regular Circles with >1 effective active
 * Member need transfer; a solo active setup-complete regular needs archive;
 * solo setup-incomplete or solo archived regulars are disposable.
 */

export type AccountDeletionBlockerAction = "archive" | "transfer";

export function accountDeletionBlockerFields(
  circle: Pick<Doc<"circles">, "kind" | "status" | "setupCompletedAt">,
  effectiveActiveMemberCount: number,
) {
  if (circle.kind === "personal") {
    return { accountDeletionBlocked: false as const, accountDeletionBlockerAction: undefined };
  }
  if (effectiveActiveMemberCount > 1) {
    return {
      accountDeletionBlocked: true as const,
      accountDeletionBlockerAction: "transfer" as const,
    };
  }
  if (circle.status === "active" && circle.setupCompletedAt !== null) {
    return {
      accountDeletionBlocked: true as const,
      accountDeletionBlockerAction: "archive" as const,
    };
  }
  return { accountDeletionBlocked: false as const, accountDeletionBlockerAction: undefined };
}

/** Counts whether a Circle has 0, 1, or more than 1 effective active Members. */
export async function countEffectiveActiveMembersUpTo(
  ctx: QueryCtx | MutationCtx,
  circleId: Id<"circles">,
  limit: number,
) {
  // Scan the full active index: status=active rows whose Users were already
  // deleted still appear until cleanup converts them, so a fixed overfetch can
  // miss a later living co-member and clear the transfer/archive blocker.
  const rows = await ctx.db
    .query("members")
    .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
    .collect();

  let count = 0;
  for (const member of rows) {
    if (await isEffectiveActiveMember(ctx, member)) {
      count += 1;
      if (count > limit) {
        return count;
      }
    }
  }
  return count;
}

/** Recomputes and patches blocker fields for one Circle. No-op if the Circle is gone. */
export async function recomputeAccountDeletionBlockers(ctx: MutationCtx, circleId: Id<"circles">) {
  const circle = await ctx.db.get(circleId);
  if (!circle) {
    return;
  }
  const effectiveActive = await countEffectiveActiveMembersUpTo(ctx, circleId, 1);
  const fields = accountDeletionBlockerFields(circle, effectiveActive);
  await ctx.db.patch(circleId, {
    accountDeletionBlocked: fields.accountDeletionBlocked,
    accountDeletionBlockerAction: fields.accountDeletionBlockerAction,
  });
}
