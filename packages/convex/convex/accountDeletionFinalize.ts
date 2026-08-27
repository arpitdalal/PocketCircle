import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { betterAuthMappedUserSchema } from "./accountDeletionAuth.js";
import { revokeAllMcpGrantsForUser } from "./mcpGrant.js";

/** First cleanup phase — must match `USER_PHASES[0]` in accountDeletion.ts. */
const INITIAL_CLEANUP_PHASE = "convertActiveMemberships" as const;

export async function assertNoAccountDeletionBlockers(ctx: MutationCtx, ownerUserId: Id<"users">) {
  const blocker = await ctx.db
    .query("circles")
    .withIndex("by_owner_and_account_deletion_blocked", (q) =>
      q.eq("ownerUserId", ownerUserId).eq("accountDeletionBlocked", true),
    )
    .first();
  if (blocker) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.accountDeletionBlocked));
  }
}

export async function createAccountDeletionCleanupJob(
  ctx: MutationCtx,
  args: { userId: Id<"users">; emailLower: string; finalizedAt: number },
) {
  const existing = await ctx.db
    .query("accountDeletionJobs")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .first();
  if (existing) {
    return existing._id;
  }
  const now = Date.now();
  return await ctx.db.insert("accountDeletionJobs", {
    userId: args.userId,
    emailLower: args.emailLower,
    finalizedAt: args.finalizedAt,
    phase: INITIAL_CLEANUP_PHASE,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Better Auth `user.onDelete` handoff: recheck blockers, create the cleanup job,
 * delete the app `users` row, schedule the first batch. Throw aborts auth deletion.
 *
 * Lives outside `auth.ts` ↔ `accountDeletion.ts` so auth can statically import it
 * (mutations cannot use runtime `import()`).
 */
export async function finalizeOnUserDelete(ctx: MutationCtx, authUser: unknown) {
  const parsed = betterAuthMappedUserSchema.parse(authUser);
  const userId = ctx.db.normalizeId("users", parsed.userId);
  if (!userId) {
    throw new Error("Account deletion user mapping missing");
  }

  await assertNoAccountDeletionBlockers(ctx, userId);

  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error("Account deletion user missing");
  }

  const finalizedAt = Date.now();
  // Disable MCP grants before async cleanup / User row delete so the next
  // authorization check fails closed even if Worker token cleanup lags (#317).
  await revokeAllMcpGrantsForUser(ctx, { userId, now: finalizedAt });

  const jobId = await createAccountDeletionCleanupJob(ctx, {
    userId,
    emailLower: user.email,
    finalizedAt,
  });

  await ctx.db.delete(userId);
  await ctx.scheduler.runAfter(0, internal.accountDeletion.runCleanupBatch, { jobId });
  return jobId;
}
