import {
  buildRef,
  CIRCLE_CAPACITY_LIMIT,
  inviteEmailSchema,
  MUTATION_ERRORS,
  mutationErrorData,
} from "@pocketcircle/domain";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { isInvitationBlockedByAccountDeletion } from "./accountDeletion.js";
import { recomputeAccountDeletionBlockers } from "./accountDeletionBlockers.js";
import { markActivationMilestone } from "./activation.js";
import { getCurrentUserOrNull, requireCurrentUser } from "./auth.js";
import { emailPool } from "./email.js";
import { requireCircleAccess, resolveCircleAccess } from "./guard.js";
import { circleEntity, recordEvent } from "./history.js";
import { generateInvitationToken, hashInvitationToken } from "./invitationToken.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";
import {
  notifyInvitationAccepted,
  notifyInvitationReceived,
  notifyInvitationResent,
  notifyInvitationRevoked,
} from "./notify.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_INVITATION_EMAIL_CAP = 100;
const PER_EMAIL_RESEND_CAP = 3;
const PER_EMAIL_CREATE_CAP = 2;
const MIGRATION_BATCH_SIZE = 50;
const REMINDER_DAYS_BEFORE = [3, 1] as const;

async function invitationIsActionableForLifecycle(
  ctx: QueryCtx | MutationCtx,
  invitation: Doc<"invitations">,
) {
  if (invitation.status !== "pending") {
    return false;
  }
  if (await isInvitationBlockedByAccountDeletion(ctx, invitation)) {
    return false;
  }
  const circle = await ctx.db.get(invitation.circleId);
  if (circle === null || circle.setupCompletedAt === null || circle.status !== "active") {
    return false;
  }
  const inviter = await ctx.db.get(invitation.invitedByUserId);
  return inviter !== null;
}

/** Shared expiry write — callers already validated generation / deadline / actionability. */
async function materializeInvitationExpired(ctx: MutationCtx, invitationId: Id<"invitations">) {
  await ctx.db.patch(invitationId, { status: "expired" });
}

async function scheduleInvitationExpiry(
  ctx: MutationCtx,
  invitation: Pick<
    Doc<"invitations">,
    "_id" | "resendCount" | "expiresAt" | "expiryScheduledResendCount"
  >,
) {
  if (invitation.expiryScheduledResendCount === invitation.resendCount) {
    return;
  }
  await ctx.db.patch(invitation._id, {
    expiryScheduledResendCount: invitation.resendCount,
  });
  await ctx.scheduler.runAt(invitation.expiresAt, internal.invitations.expireInvitation, {
    invitationId: invitation._id,
    expectedResendCount: invitation.resendCount,
    expectedExpiresAt: invitation.expiresAt,
  });
}

async function scheduleInvitationReminders(
  ctx: MutationCtx,
  invitation: Pick<
    Doc<"invitations">,
    "_id" | "resendCount" | "expiresAt" | "remindersScheduledResendCount"
  >,
  now: number,
) {
  if (invitation.remindersScheduledResendCount === invitation.resendCount) {
    return;
  }
  await ctx.db.patch(invitation._id, {
    remindersScheduledResendCount: invitation.resendCount,
  });
  for (const daysBefore of REMINDER_DAYS_BEFORE) {
    const at = invitation.expiresAt - daysBefore * DAY_MS;
    if (at <= now) {
      continue;
    }
    await ctx.scheduler.runAt(at, internal.notify.deliverInvitationExpiryReminder, {
      invitationId: invitation._id,
      expectedResendCount: invitation.resendCount,
      expectedExpiresAt: invitation.expiresAt,
      daysBefore,
    });
  }
}

async function scheduleInvitationLifecycle(
  ctx: MutationCtx,
  invitation: Doc<"invitations">,
  now: number,
) {
  await scheduleInvitationExpiry(ctx, invitation);
  await scheduleInvitationReminders(ctx, invitation, now);
}

async function assertUnderDailyInvitationCap(ctx: MutationCtx, userId: Id<"users">, now: number) {
  const windowStart = now - DAY_MS;
  const recent = await ctx.db
    .query("invitationEmailEvents")
    .withIndex("by_user_and_sentAt", (q) =>
      q.eq("invitedByUserId", userId).gt("sentAt", windowStart),
    )
    .take(DAILY_INVITATION_EMAIL_CAP);
  if (recent.length >= DAILY_INVITATION_EMAIL_CAP) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached));
  }
}

async function assertUnderCreateAddressCap(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  emailLower: string,
  now: number,
) {
  const windowStart = now - DAY_MS;
  const events = await ctx.db
    .query("invitationEmailEvents")
    .withIndex("by_circle_email_and_sentAt", (q) =>
      q.eq("circleId", circleId).eq("emailLower", emailLower).gt("sentAt", windowStart),
    )
    .collect();
  const createCount = events.filter((event) => event.kind === "create").length;
  if (createCount >= PER_EMAIL_CREATE_CAP) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteAddressCapReached));
  }
}

async function assertUnderResendAddressCap(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  emailLower: string,
  now: number,
) {
  const windowStart = now - DAY_MS;
  const events = await ctx.db
    .query("invitationEmailEvents")
    .withIndex("by_circle_email_and_sentAt", (q) =>
      q.eq("circleId", circleId).eq("emailLower", emailLower).gt("sentAt", windowStart),
    )
    .collect();
  const resendCount = events.filter((event) => event.kind === "resend").length;
  if (resendCount >= PER_EMAIL_RESEND_CAP) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteResendCapReached));
  }
}

async function countActiveMembers(ctx: MutationCtx, circleId: Id<"circles">) {
  const active = await ctx.db
    .query("members")
    .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
    .collect();
  let count = 0;
  for (const member of active) {
    if (await isEffectiveActiveMember(ctx, member)) {
      count += 1;
    }
  }
  return count;
}

async function countUnexpiredPendingInvitations(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  now: number,
) {
  // Indexed range scan over live seats only: the `expiresAt > now` bound excludes
  // expired-but-still-"pending" rows at the index level, so the read is bounded by
  // the 256 cap and never scans the unbounded terminal-state invitation history.
  const pending = await ctx.db
    .query("invitations")
    .withIndex("by_circle_status_and_expiresAt", (q) =>
      q.eq("circleId", circleId).eq("status", "pending").gt("expiresAt", now),
    )
    .collect();
  return pending.length;
}

async function recordEmailSend(
  ctx: MutationCtx,
  args: {
    invitedByUserId: Id<"users">;
    circleId: Id<"circles">;
    emailLower: string;
    kind: "create" | "resend";
    sentAt: number;
  },
) {
  await ctx.db.insert("invitationEmailEvents", args);
}

/** Creates a hashed, 7-day Invitation for a regular Circle (MEM-2) and enqueues email delivery (EML-2). */
export const createInvitation = mutation({
  args: {
    circleId: v.id("circles"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);

    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteForbidden));
    }

    access.assertWritable();

    if (access.circle.kind === "personal") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.invitePersonalCircle));
    }

    access.assertSetupComplete();

    const { email } = inviteEmailSchema.parse({ email: args.email });

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingUser) {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", args.circleId).eq("userId", existingUser._id),
        )
        .unique();
      if (membership && (await isEffectiveActiveMember(ctx, membership))) {
        throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteAlreadyMember));
      }
    }

    const now = Date.now();
    const existingInvites = await ctx.db
      .query("invitations")
      .withIndex("by_circle_and_email", (q) =>
        q.eq("circleId", args.circleId).eq("emailLower", email),
      )
      .collect();
    const hasPending = existingInvites.some(
      (invite) => invite.status === "pending" && invite.expiresAt > now,
    );
    if (hasPending) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteAlreadyPending));
    }

    const occupied =
      (await countActiveMembers(ctx, args.circleId)) +
      (await countUnexpiredPendingInvitations(ctx, args.circleId, now));
    if (occupied >= CIRCLE_CAPACITY_LIMIT) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleCapacityFull));
    }

    await assertUnderDailyInvitationCap(ctx, access.user._id, now);
    await assertUnderCreateAddressCap(ctx, args.circleId, email, now);

    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);

    const invitationId = await ctx.db.insert("invitations", {
      circleId: args.circleId,
      emailLower: email,
      tokenHash,
      status: "pending",
      invitedByUserId: access.user._id,
      resendCount: 0,
      resendTimestamps: [],
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
    });

    const invitation = await ctx.db.get(invitationId);
    if (invitation === null) {
      throw new Error("invitation insert missing");
    }
    await scheduleInvitationLifecycle(ctx, invitation, now);

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "member invited",
      changes: [{ field: "email", to: email }],
    });

    await emailPool.enqueueAction(
      ctx,
      internal.email.sendInvitationEmail,
      { invitationId, token, resendCount: 0 },
      {
        onComplete: internal.email.onInvitationRunComplete,
        context: { invitationId },
      },
    );

    await recordEmailSend(ctx, {
      invitedByUserId: access.user._id,
      circleId: args.circleId,
      emailLower: email,
      kind: "create",
      sentAt: now,
    });

    if (existingUser) {
      await notifyInvitationReceived(ctx, {
        inviteeUserId: existingUser._id,
        actorUserId: access.user._id,
        circle: access.circle,
        invitationId,
      });
    }
  },
});

async function resolvePendingInvitation(ctx: QueryCtx | MutationCtx, token: string) {
  const tokenHash = await hashInvitationToken(token);
  const invitation = await ctx.db
    .query("invitations")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (
    invitation === null ||
    invitation.expiresAt <= Date.now() ||
    invitation.status !== "pending"
  ) {
    return null;
  }

  if (await isInvitationBlockedByAccountDeletion(ctx, invitation)) {
    return null;
  }

  const circle = await ctx.db.get(invitation.circleId);
  if (circle === null || circle.setupCompletedAt === null || circle.status !== "active") {
    return null;
  }

  return { invitation, circle };
}

/**
 * Public, token-scoped preview for the Invitation landing page (MEM-3). Returns
 * only the four fields the UI renders — no circleId, invitation id, or status
 * (ADR 0016).
 */
export const getInvitationPreview = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolvePendingInvitation(ctx, args.token);
    if (!resolved) {
      return null;
    }
    return invitationPreviewFields(ctx, resolved.invitation, resolved.circle);
  },
});

/**
 * Authenticated preview by Invitation id (#375). Returns the token-preview fields
 * plus the canonical Invitation `ref` for ADR 0016 rewrite when the current User's
 * live email matches a still-actionable pending Invitation; otherwise null.
 */
export const getInvitationPreviewById = query({
  args: { invitationId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      return null;
    }
    const invitationId = ctx.db.normalizeId("invitations", args.invitationId);
    if (invitationId === null) {
      return null;
    }
    const invitation = await ctx.db.get(invitationId);
    if (invitation === null) {
      return null;
    }

    const resolved = await resolveActionablePendingInvitationForEmail(
      ctx,
      invitation,
      user.email.toLowerCase(),
    );
    if (!resolved) {
      return null;
    }

    const fields = await invitationPreviewFields(ctx, resolved.invitation, resolved.circle);
    if (!fields) {
      return null;
    }
    return {
      ...fields,
      ref: buildRef(resolved.circle.name, resolved.invitation._id),
    };
  },
});

async function invitationPreviewFields(
  ctx: QueryCtx | MutationCtx,
  invitation: Doc<"invitations">,
  circle: Doc<"circles">,
) {
  const ownerUser = await ctx.db.get(circle.ownerUserId);
  if (!ownerUser) {
    return null;
  }
  return {
    circleName: circle.name,
    ownerDisplayName: ownerUser.displayName,
    ownerImage: ownerUser.image ?? null,
    invitedEmail: invitation.emailLower,
  };
}

/**
 * Pending Invitation that is still accept-able for `emailLower`: unexpired,
 * email match, not deletion-blocked, Circle active + setup-complete.
 * Shared by authenticated preview, accept, and Notification link resolution.
 */
export async function resolveActionablePendingInvitationForEmail(
  ctx: QueryCtx | MutationCtx,
  invitation: Doc<"invitations">,
  emailLower: string,
) {
  if (
    invitation.status !== "pending" ||
    invitation.expiresAt <= Date.now() ||
    invitation.emailLower !== emailLower
  ) {
    return null;
  }

  if (await isInvitationBlockedByAccountDeletion(ctx, invitation)) {
    return null;
  }

  const circle = await ctx.db.get(invitation.circleId);
  if (circle === null || circle.setupCompletedAt === null || circle.status !== "active") {
    return null;
  }

  return { invitation, circle };
}

/**
 * Shared accept path for token and authenticated-id entry points (MEM-3 / #375).
 * Reactivates a Removed Member's existing row on rejoin (PRD 44); all failure
 * branches return the same generic signal (ADR 0016).
 */
async function acceptPendingInvitationForUser(
  ctx: MutationCtx,
  invitation: Doc<"invitations">,
  user: Doc<"users">,
) {
  const resolved = await resolveActionablePendingInvitationForEmail(
    ctx,
    invitation,
    user.email.toLowerCase(),
  );
  if (!resolved) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
  }
  const { circle } = resolved;

  const existingMembership = await ctx.db
    .query("members")
    .withIndex("by_circle_and_user", (q) => q.eq("circleId", circle._id).eq("userId", user._id))
    .unique();

  if (existingMembership && (await isEffectiveActiveMember(ctx, existingMembership))) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
  }

  if ((await countActiveMembers(ctx, circle._id)) >= CIRCLE_CAPACITY_LIMIT) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleCapacityReached));
  }

  let membership: Doc<"members">;
  if (existingMembership?.status === "removed") {
    await ctx.db.patch(existingMembership._id, {
      status: "active",
      displayName: user.displayName,
      image: user.image ?? undefined,
      removedAt: undefined,
    });
    const reactivated = await ctx.db.get(existingMembership._id);
    if (!reactivated) {
      // unreachable: row existed immediately before patch
      throw new Error("Member row missing after reactivation");
    }
    membership = reactivated;
  } else if (existingMembership?.status === "deleted") {
    // Deleted Members never reconnect (USR-3), even if userId somehow collides.
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
  } else {
    const memberId = await ctx.db.insert("members", {
      circleId: circle._id,
      userId: user._id,
      role: "member",
      status: "active",
      displayName: user.displayName,
      image: user.image ?? undefined,
      joinedAt: Date.now(),
    });
    const inserted = await ctx.db.get(memberId);
    if (!inserted) {
      // unreachable: insert returned an id
      throw new Error("Member row missing after insert");
    }
    membership = inserted;
  }

  await ctx.db.patch(invitation._id, { status: "accepted" });

  await recordEvent(ctx, {
    entity: circleEntity(circle._id),
    actor: membership,
    action: "member joined",
    changes: [{ field: "member", to: membership.displayName }],
  });

  await recomputeAccountDeletionBlockers(ctx, circle._id);

  await markActivationMilestone(ctx, invitation.invitedByUserId, "sharedMemberJoinedAt");

  await notifyInvitationAccepted(ctx, {
    inviterUserId: invitation.invitedByUserId,
    acceptorUserId: user._id,
    acceptorDisplayName: user.displayName,
    circle,
  });

  return { circleId: circle._id };
}

/**
 * Accepts a pending Invitation for the signed-in User whose Google Account Email
 * matches the invite (MEM-3). Token entry from the emailed Invitation Link.
 */
export const acceptInvitation = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);

    const tokenHash = await hashInvitationToken(args.token);
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    if (invitation === null) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    return acceptPendingInvitationForUser(ctx, invitation, user);
  },
});

/**
 * Authenticated accept by Invitation identity (#375). No emailed token; email
 * match still required against the live Google Account Email.
 */
export const acceptInvitationById = mutation({
  args: { invitationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const invitationId = ctx.db.normalizeId("invitations", args.invitationId);
    if (invitationId === null) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }
    const invitation = await ctx.db.get(invitationId);
    if (invitation === null) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }
    return acceptPendingInvitationForUser(ctx, invitation, user);
  },
});

/** Owner-only pending invitations for a Circle (MEM-4). */
export const listPendingInvitations = query({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access?.isOwner) {
      return null;
    }

    const now = Date.now();
    // Indexed range scan over live seats only (≤ the 256 cap): the `expiresAt > now`
    // bound skips expired-but-still-"pending" rows and the terminal-state history.
    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_circle_status_and_expiresAt", (q) =>
        q.eq("circleId", args.circleId).eq("status", "pending").gt("expiresAt", now),
      )
      .collect();

    return invitations.map((invitation) => ({
      id: invitation._id,
      email: invitation.emailLower,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      resendCount: invitation.resendCount,
    }));
  },
});

/** Rotates a pending invitation's token and refreshes its expiry (MEM-4). */
export const resendInvitation = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    const access = await requireCircleAccess(ctx, invitation.circleId);

    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteForbidden));
    }

    access.assertWritable();

    if (invitation.circleId !== access.circle._id) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    const now = Date.now();
    if (invitation.status !== "pending" || invitation.expiresAt <= now) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    access.assertSetupComplete();

    await assertUnderResendAddressCap(ctx, invitation.circleId, invitation.emailLower, now);
    await assertUnderDailyInvitationCap(ctx, access.user._id, now);

    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const expiresAt = now + INVITE_TTL_MS;
    const resendCount = invitation.resendCount + 1;

    await ctx.db.patch(args.invitationId, {
      tokenHash,
      expiresAt,
      resendCount,
      resendTimestamps: [...(invitation.resendTimestamps ?? []), now],
      remindersSent: [],
    });

    const renewed = await ctx.db.get(args.invitationId);
    if (renewed === null) {
      throw new Error("invitation patch missing");
    }
    await scheduleInvitationLifecycle(ctx, renewed, now);

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "invitation resent",
      changes: [{ field: "email", to: invitation.emailLower }],
    });
    await emailPool.enqueueAction(
      ctx,
      internal.email.sendInvitationEmail,
      { invitationId: args.invitationId, token, resendCount },
      {
        onComplete: internal.email.onInvitationRunComplete,
        context: { invitationId: args.invitationId },
      },
    );

    await recordEmailSend(ctx, {
      invitedByUserId: access.user._id,
      circleId: invitation.circleId,
      emailLower: invitation.emailLower,
      kind: "resend",
      sentAt: now,
    });

    const invitee = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", invitation.emailLower))
      .unique();
    if (invitee) {
      await notifyInvitationResent(ctx, {
        inviteeUserId: invitee._id,
        actorUserId: access.user._id,
        circle: access.circle,
        invitationId: args.invitationId,
      });
    }
  },
});

/** Revokes every pending invitation for a Circle — no per-invite history (MEM-8). */
export async function revokePendingInvitationsForCircle(ctx: MutationCtx, circleId: Id<"circles">) {
  // Read only pending rows via the index prefix — skips the accepted/revoked/expired
  // history. Expired-but-still-"pending" rows are swept too (harmless, keeps state clean).
  const invitations = await ctx.db
    .query("invitations")
    .withIndex("by_circle_status_and_expiresAt", (q) =>
      q.eq("circleId", circleId).eq("status", "pending"),
    )
    .collect();
  for (const invitation of invitations) {
    await ctx.db.patch(invitation._id, { status: "revoked" });
  }
}

/** Revokes a pending invitation (MEM-4). Exempt from setup gating — access-reducing cleanup; anomalous pending invites on incomplete Circles stay revocable. */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    const access = await requireCircleAccess(ctx, invitation.circleId);

    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteForbidden));
    }

    access.assertWritable();

    if (invitation.circleId !== access.circle._id) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    if (invitation.status !== "pending") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid));
    }

    await ctx.db.patch(args.invitationId, { status: "revoked" });

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "invitation revoked",
      changes: [{ field: "email", from: invitation.emailLower }],
    });

    const invitee = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", invitation.emailLower))
      .unique();
    if (invitee) {
      await notifyInvitationRevoked(ctx, {
        inviteeUserId: invitee._id,
        actorUserId: access.user._id,
        circleName: access.circle.name,
      });
    }
  },
});

/** Materializes `status: "expired"` at the scheduled deadline (#315). */
export const expireInvitation = internalMutation({
  args: {
    invitationId: v.id("invitations"),
    expectedResendCount: v.number(),
    expectedExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (
      invitation === null ||
      invitation.status !== "pending" ||
      invitation.resendCount !== args.expectedResendCount ||
      invitation.expiresAt !== args.expectedExpiresAt
    ) {
      return;
    }

    if (Date.now() < args.expectedExpiresAt) {
      return;
    }

    if (!(await invitationIsActionableForLifecycle(ctx, invitation))) {
      return;
    }

    await materializeInvitationExpired(ctx, invitation._id);
  },
});

/** Bounded one-time backfill: expire overdue pending rows and schedule live deadlines. */
export const backfillInvitationExpiry = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("invitations").paginate({
      cursor: args.cursor ?? null,
      numItems: MIGRATION_BATCH_SIZE,
    });
    let expired = 0;
    let scheduled = 0;
    let skipped = 0;
    const now = Date.now();

    for (const invitation of page.page) {
      if (invitation.status !== "pending") {
        skipped += 1;
        continue;
      }
      if (!(await invitationIsActionableForLifecycle(ctx, invitation))) {
        skipped += 1;
        continue;
      }

      if (invitation.expiresAt <= now) {
        await materializeInvitationExpired(ctx, invitation._id);
        expired += 1;
        continue;
      }

      if (invitation.expiryScheduledResendCount === invitation.resendCount) {
        skipped += 1;
        continue;
      }
      await scheduleInvitationExpiry(ctx, invitation);
      scheduled += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.invitations.backfillInvitationExpiry, {
        cursor: page.continueCursor,
      });
    }

    return {
      done: page.isDone,
      expired,
      scheduled,
      skipped,
      continueCursor: page.continueCursor,
    };
  },
});

/** Bounded backfill: schedule only still-future reminder thresholds for pending invites. */
export const backfillInvitationReminders = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("invitations").paginate({
      cursor: args.cursor ?? null,
      numItems: MIGRATION_BATCH_SIZE,
    });
    let scheduled = 0;
    let skipped = 0;
    const now = Date.now();

    for (const invitation of page.page) {
      if (invitation.status !== "pending" || invitation.expiresAt <= now) {
        skipped += 1;
        continue;
      }
      if (!(await invitationIsActionableForLifecycle(ctx, invitation))) {
        skipped += 1;
        continue;
      }
      if (invitation.remindersScheduledResendCount === invitation.resendCount) {
        skipped += 1;
        continue;
      }
      await scheduleInvitationReminders(ctx, invitation, now);
      scheduled += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.invitations.backfillInvitationReminders, {
        cursor: page.continueCursor,
      });
    }

    return {
      done: page.isDone,
      scheduled,
      skipped,
      continueCursor: page.continueCursor,
    };
  },
});
