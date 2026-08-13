import { vOnCompleteValidator } from "@convex-dev/workpool";
import {
  accountDeletionEmail,
  buildRef,
  MUTATION_ERRORS,
  mutationErrorData,
} from "@pocketcircle/domain";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
  query,
} from "./_generated/server.js";
import { recomputeAccountDeletionBlockers } from "./accountDeletionBlockers.js";
import { assertNoAccountDeletionBlockers } from "./accountDeletionFinalize.js";
import { requireCurrentUser } from "./auth.js";
import { emailPool, sendEmailOrReport } from "./email.js";
import { circleEntity, recordEvent } from "./history.js";
import { reportTerminalFailure, sanitizeOperationalError } from "./terminalFailure.js";

export {
  assertNoAccountDeletionBlockers,
  createAccountDeletionCleanupJob,
  finalizeOnUserDelete,
} from "./accountDeletionFinalize.js";

/** Bounded cleanup batch size (USR-3 / ADR 0029). */
export const ACCOUNT_DELETION_BATCH_SIZE = 32;

const USER_PHASES = [
  "convertActiveMemberships",
  "convertRemovedMemberships",
  "revokeInvitesByInviter",
  "revokeInvitesByEmail",
  "deleteNotifications",
  "deleteFeedbackEmailEvents",
  "deleteInvitationEmailEventsByUser",
  "deleteE2eAccountDeletionTokens",
  "deleteOwnedCircles",
] as const;

type UserPhase = (typeof USER_PHASES)[number];

const CIRCLE_PHASES = [
  "histories",
  "transactionCategories",
  "transactionSearchDocuments",
  "transactions",
  "categories",
  "invitations",
  "invitationEmailEvents",
  "e2eInvitationTokens",
  "members",
  "circle",
] as const;

type CirclePhase = (typeof CIRCLE_PHASES)[number];

function isUserPhase(value: string): value is UserPhase {
  for (const phase of USER_PHASES) {
    if (phase === value) {
      return true;
    }
  }
  return false;
}

function isCirclePhase(value: string): value is CirclePhase {
  for (const phase of CIRCLE_PHASES) {
    if (phase === value) {
      return true;
    }
  }
  return false;
}

function nextUserPhase(phase: UserPhase) {
  const index = USER_PHASES.indexOf(phase);
  return USER_PHASES[index + 1];
}

function nextCirclePhase(phase: CirclePhase) {
  const index = CIRCLE_PHASES.indexOf(phase);
  return CIRCLE_PHASES[index + 1];
}

/** Paginated owned Circles that currently block Account Deletion. */
export const listAccountDeletionBlockers = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const result = await ctx.db
      .query("circles")
      .withIndex("by_owner_and_account_deletion_blocked", (q) =>
        q.eq("ownerUserId", user._id).eq("accountDeletionBlocked", true),
      )
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.map((circle) => ({
        circleId: circle._id,
        ref: buildRef(circle.name, circle._id),
        name: circle.name,
        action: circle.accountDeletionBlockerAction ?? "archive",
      })),
    };
  },
});

/**
 * Pending invitations created at or before a deletion job's `finalizedAt` must
 * not be accept-able during async revocation — otherwise a recreated account
 * (same email) or an invitee of a deleted inviter can accept a dead invite that
 * status-filtered cleanup will never revoke.
 */
export async function isInvitationBlockedByAccountDeletion(
  ctx: QueryCtx | MutationCtx,
  invitation: Pick<Doc<"invitations">, "emailLower" | "invitedByUserId" | "createdAt">,
) {
  const byInviter = await ctx.db
    .query("accountDeletionJobs")
    .withIndex("by_user", (q) => q.eq("userId", invitation.invitedByUserId))
    .collect();
  for (const job of byInviter) {
    if (invitation.createdAt <= job.finalizedAt) {
      return true;
    }
  }

  const byEmail = await ctx.db
    .query("accountDeletionJobs")
    .withIndex("by_email_lower", (q) => q.eq("emailLower", invitation.emailLower))
    .collect();
  for (const job of byEmail) {
    if (invitation.createdAt <= job.finalizedAt) {
      return true;
    }
  }
  return false;
}

/** Internal: recheck blockers then enqueue the verification email via the email pool. */
export const enqueueDeletionVerificationEmail = internalMutation({
  args: {
    mappedUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.mappedUserId);
    if (!userId) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.accountDeletionBlocked));
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.accountDeletionBlocked));
    }

    await assertNoAccountDeletionBlockers(ctx, userId);

    if (process.env.E2E_TEST_AUTH === "1") {
      await upsertE2eAccountDeletionToken(ctx, { userId, token: args.token });
    }

    await emailPool.enqueueAction(
      ctx,
      internal.accountDeletion.sendAccountDeletionEmail,
      {
        userId,
        email: args.email,
        displayName: args.displayName || user.displayName,
        token: args.token,
      },
      {
        onComplete: internal.accountDeletion.onAccountDeletionEmailComplete,
        context: { userId },
      },
    );
  },
});

async function upsertE2eAccountDeletionToken(
  ctx: MutationCtx,
  args: { userId: Id<"users">; token: string },
) {
  const existing = await ctx.db
    .query("e2eAccountDeletionTokens")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .unique();
  const row = { token: args.token, updatedAt: Date.now() };
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return;
  }
  await ctx.db.insert("e2eAccountDeletionTokens", {
    userId: args.userId,
    ...row,
  });
}

export const sendAccountDeletionEmail = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
    displayName: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const siteUrl = process.env.SITE_URL;
    if (!siteUrl) {
      throw new Error("SITE_URL is required to send the account deletion email");
    }
    const verifyLink = `${siteUrl}/delete-account/verify?token=${encodeURIComponent(args.token)}`;
    const { subject, html } = accountDeletionEmail({
      displayName: args.displayName,
      verifyLink,
    });
    await sendEmailOrReport(
      ctx,
      { kind: "account_deletion_email_exhausted", entityId: args.userId },
      {
        to: args.email,
        subject,
        html,
        idempotencyKey: `account-deletion:${args.userId}:${args.token}`,
      },
    );
  },
});

export const onAccountDeletionEmailComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ userId: v.id("users") })),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "failed") {
      await reportTerminalFailure(ctx, {
        kind: "account_deletion_email_exhausted",
        entityId: context.userId,
        error: result.error,
      });
    }
  },
});

/** Operational resume: safe to call repeatedly with a job id. */
export const resumeCleanup = internalMutation({
  args: { jobId: v.id("accountDeletionJobs") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.accountDeletion.runCleanupBatch, {
      jobId: args.jobId,
    });
  },
});

async function persistCleanupFailure(
  ctx: MutationCtx,
  jobId: Id<"accountDeletionJobs">,
  error: unknown,
) {
  const latest = await ctx.db.get(jobId);
  if (!latest) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await ctx.db.patch(jobId, {
    failure: sanitizeOperationalError(message),
    updatedAt: Date.now(),
  });
  await reportTerminalFailure(ctx, {
    kind: "account_deletion_cleanup_failed",
    entityId: jobId,
    error: message,
  });
}

async function patchCleanupProgress(
  ctx: MutationCtx,
  jobId: Id<"accountDeletionJobs">,
  fields: {
    phase?: string;
    circleId?: Id<"circles"> | undefined;
    circlePhase?: string | undefined;
  } = {},
) {
  await ctx.db.patch(jobId, {
    ...fields,
    failure: undefined,
    updatedAt: Date.now(),
  });
}

/** One bounded cleanup batch; schedules the next when work remains. */
export const runCleanupBatch = internalMutation({
  args: { jobId: v.id("accountDeletionJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      return;
    }

    try {
      await processCleanupBatch(ctx, job);
    } catch (caught) {
      await persistCleanupFailure(ctx, args.jobId, caught);
    }
  },
});

async function processCleanupBatch(ctx: MutationCtx, job: Doc<"accountDeletionJobs">) {
  const phase = job.phase;
  if (!isUserPhase(phase)) {
    await persistCleanupFailure(ctx, job._id, `unknown phase: ${phase}`);
    return;
  }

  const moreInPhase = await runUserPhaseBatch(ctx, job, phase);
  const latest = await ctx.db.get(job._id);
  if (!latest) {
    return;
  }

  if (moreInPhase) {
    await patchCleanupProgress(ctx, job._id);
    await ctx.scheduler.runAfter(0, internal.accountDeletion.runCleanupBatch, {
      jobId: job._id,
    });
    return;
  }

  if (phase === "deleteOwnedCircles") {
    await ctx.db.delete(job._id);
    return;
  }

  const next = nextUserPhase(phase);
  if (!next) {
    await ctx.db.delete(job._id);
    return;
  }

  await patchCleanupProgress(ctx, job._id, {
    phase: next,
    circleId: undefined,
    circlePhase: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.accountDeletion.runCleanupBatch, {
    jobId: job._id,
  });
}

async function runUserPhaseBatch(
  ctx: MutationCtx,
  job: Doc<"accountDeletionJobs">,
  phase: UserPhase,
) {
  switch (phase) {
    case "convertActiveMemberships":
      return await convertMembershipBatch(ctx, job.userId, "active");
    case "convertRemovedMemberships":
      return await convertMembershipBatch(ctx, job.userId, "removed");
    case "revokeInvitesByInviter":
      return await revokeInvitesByInviterBatch(ctx, job);
    case "revokeInvitesByEmail":
      return await revokeInvitesByEmailBatch(ctx, job);
    case "deleteNotifications":
      return await deleteNotificationsBatch(ctx, job.userId);
    case "deleteFeedbackEmailEvents":
      return await deleteFeedbackEventsBatch(ctx, job.userId);
    case "deleteInvitationEmailEventsByUser":
      return await deleteInvitationEmailEventsByUserBatch(ctx, job.userId);
    case "deleteE2eAccountDeletionTokens":
      return await deleteE2eAccountDeletionTokensBatch(ctx, job.userId);
    case "deleteOwnedCircles":
      return await deleteOwnedCirclesBatch(ctx, job);
  }
}

async function convertMembershipBatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  status: "active" | "removed",
) {
  const rows = await ctx.db
    .query("members")
    .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", status))
    .take(ACCOUNT_DELETION_BATCH_SIZE);

  if (rows.length === 0) {
    return false;
  }

  const now = Date.now();
  for (const member of rows) {
    await ctx.db.patch(member._id, {
      status: "deleted",
      image: undefined,
      deletedAt: now,
    });
    await recordEvent(ctx, {
      entity: circleEntity(member.circleId),
      actor: null,
      action: "member deleted",
      changes: [{ field: "member", from: member.displayName }],
    });
    await recomputeAccountDeletionBlockers(ctx, member.circleId);
  }
  return rows.length === ACCOUNT_DELETION_BATCH_SIZE;
}

async function revokeInvitesByInviterBatch(ctx: MutationCtx, job: Doc<"accountDeletionJobs">) {
  const invites = await ctx.db
    .query("invitations")
    .withIndex("by_inviter_status_createdAt", (q) =>
      q.eq("invitedByUserId", job.userId).eq("status", "pending").lte("createdAt", job.finalizedAt),
    )
    .take(ACCOUNT_DELETION_BATCH_SIZE);

  return await revokeInvitationBatch(ctx, invites);
}

async function revokeInvitesByEmailBatch(ctx: MutationCtx, job: Doc<"accountDeletionJobs">) {
  const invites = await ctx.db
    .query("invitations")
    .withIndex("by_email_status_createdAt", (q) =>
      q.eq("emailLower", job.emailLower).eq("status", "pending").lte("createdAt", job.finalizedAt),
    )
    .take(ACCOUNT_DELETION_BATCH_SIZE);

  return await revokeInvitationBatch(ctx, invites);
}

async function revokeInvitationBatch(ctx: MutationCtx, invites: Doc<"invitations">[]) {
  if (invites.length === 0) {
    return false;
  }
  for (const invite of invites) {
    if (invite.status !== "pending") {
      continue;
    }
    await ctx.db.patch(invite._id, { status: "revoked" });
    await recordEvent(ctx, {
      entity: circleEntity(invite.circleId),
      actor: null,
      action: "invitation revoked",
      changes: [{ field: "email", from: invite.emailLower }],
    });
  }
  return invites.length === ACCOUNT_DELETION_BATCH_SIZE;
}

async function deleteNotificationsBatch(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ACCOUNT_DELETION_BATCH_SIZE);
  return await deleteDocs(ctx, rows);
}

async function deleteFeedbackEventsBatch(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("feedbackEmailEvents")
    .withIndex("by_user_and_sentAt", (q) => q.eq("userId", userId))
    .take(ACCOUNT_DELETION_BATCH_SIZE);
  return await deleteDocs(ctx, rows);
}

async function deleteInvitationEmailEventsByUserBatch(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("invitationEmailEvents")
    .withIndex("by_user_and_sentAt", (q) => q.eq("invitedByUserId", userId))
    .take(ACCOUNT_DELETION_BATCH_SIZE);
  return await deleteDocs(ctx, rows);
}

async function deleteE2eAccountDeletionTokensBatch(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("e2eAccountDeletionTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ACCOUNT_DELETION_BATCH_SIZE);
  return await deleteDocs(ctx, rows);
}

async function deleteOwnedCirclesBatch(ctx: MutationCtx, job: Doc<"accountDeletionJobs">) {
  let circleId = job.circleId;
  let circlePhase: CirclePhase =
    job.circlePhase && isCirclePhase(job.circlePhase) ? job.circlePhase : CIRCLE_PHASES[0];

  if (!circleId) {
    const owned = await ctx.db
      .query("circles")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", job.userId))
      .first();
    if (!owned) {
      return false;
    }
    circleId = owned._id;
    circlePhase = CIRCLE_PHASES[0];
    await patchCleanupProgress(ctx, job._id, { circleId, circlePhase });
  }

  const moreInCirclePhase = await deleteCirclePhaseBatch(ctx, circleId, circlePhase);
  if (moreInCirclePhase) {
    await patchCleanupProgress(ctx, job._id, { circleId, circlePhase });
    return true;
  }

  if (circlePhase === "circle") {
    await patchCleanupProgress(ctx, job._id, {
      circleId: undefined,
      circlePhase: undefined,
    });
    return true;
  }

  const next = nextCirclePhase(circlePhase);
  await patchCleanupProgress(ctx, job._id, { circleId, circlePhase: next });
  return true;
}

async function deleteCirclePhaseBatch(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  phase: CirclePhase,
) {
  switch (phase) {
    case "histories":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("histories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "transactionCategories":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("transactionCategories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "transactionSearchDocuments":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("transactionSearchDocuments")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "transactions":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("transactions")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "categories":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("categories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "invitations":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("invitations")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "invitationEmailEvents":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("invitationEmailEvents")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "e2eInvitationTokens":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("e2eInvitationTokens")
          .withIndex("by_circle_and_email", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "members":
      return await deleteDocs(
        ctx,
        await ctx.db
          .query("members")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .take(ACCOUNT_DELETION_BATCH_SIZE),
      );
    case "circle": {
      const circle = await ctx.db.get(circleId);
      if (circle) {
        await ctx.db.delete(circleId);
      }
      return false;
    }
  }
}

async function deleteDocs(
  ctx: MutationCtx,
  rows: Array<{
    _id:
      | Id<"histories">
      | Id<"transactionCategories">
      | Id<"transactionSearchDocuments">
      | Id<"transactions">
      | Id<"categories">
      | Id<"invitations">
      | Id<"invitationEmailEvents">
      | Id<"e2eInvitationTokens">
      | Id<"members">
      | Id<"notifications">
      | Id<"feedbackEmailEvents">
      | Id<"e2eAccountDeletionTokens">;
  }>,
) {
  if (rows.length === 0) {
    return false;
  }
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length === ACCOUNT_DELETION_BATCH_SIZE;
}
