import {
  buildCategoryNotificationLink,
  buildCircleNotificationLink,
  buildInvitationNotificationLink,
  buildRef,
  buildTransactionNotificationLink,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./_generated/server.js";
import { isInvitationBlockedByAccountDeletion } from "./accountDeletion.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Closed set of v1 notification types — a typo can't create an unknown type. */
export const NOTIFICATION_TYPES = [
  "invitation.received",
  "invitation.resent",
  "invitation.expiring_soon",
  "invitation.expiring_tomorrow",
  "invitation.accepted",
  "invitation.revoked",
  "member.removed",
  "ownership.transferred",
  "circle.archived",
  "circle.restored",
  "transaction.paid_by",
  "transaction.archived",
  "transaction.restored",
  "category.archived",
  "category.restored",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationTypeValidator = v.union(
  v.literal("invitation.received"),
  v.literal("invitation.resent"),
  v.literal("invitation.expiring_soon"),
  v.literal("invitation.expiring_tomorrow"),
  v.literal("invitation.accepted"),
  v.literal("invitation.revoked"),
  v.literal("member.removed"),
  v.literal("ownership.transferred"),
  v.literal("circle.archived"),
  v.literal("circle.restored"),
  v.literal("transaction.paid_by"),
  v.literal("transaction.archived"),
  v.literal("transaction.restored"),
  v.literal("category.archived"),
  v.literal("category.restored"),
);

const deliverOneArgsValidator = {
  recipientUserId: v.id("users"),
  actorUserId: v.id("users"),
  type: notificationTypeValidator,
  title: v.string(),
  body: v.optional(v.string()),
  link: v.optional(v.string()),
};

type DeliverOneArgs = {
  recipientUserId: Id<"users">;
  actorUserId: Id<"users">;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
};

/** The single actor-skip rule: we never notify an actor of their own action. */
function isActorSkip(recipientUserId: Id<"users">, actorUserId: Id<"users">) {
  return recipientUserId === actorUserId;
}

/** Sole `notifications` insert path — actor-driven and system events share it (#315 / #309). */
async function insertNotificationRow(
  ctx: MutationCtx,
  args: {
    recipientUserId: Id<"users">;
    type: NotificationType;
    title: string;
    body?: string;
    link?: string;
  },
) {
  const recipient = await ctx.db.get("users", args.recipientUserId);
  if (!recipient) {
    return false;
  }

  await ctx.db.insert("notifications", {
    userId: args.recipientUserId,
    type: args.type,
    title: args.title,
    body: args.body,
    link: args.link,
    read: false,
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Single-recipient delivery seam (NTF-2 / ADR 0027). The sole writer of
 * `notifications` for actor-driven events — actor-skip is enforced at enqueue
 * time; this guard is a backstop for direct internal calls.
 */
export const deliverOne = internalMutation({
  args: deliverOneArgsValidator,
  handler: async (ctx, args) => {
    if (isActorSkip(args.recipientUserId, args.actorUserId)) {
      return;
    }

    await insertNotificationRow(ctx, args);
  },
});

const reminderDaysBeforeValidator = v.union(v.literal(3), v.literal(1));

/**
 * System reminder delivery (#315): validate + insert in one transaction so
 * acceptance/resend/archive/deletion between jobs cannot orphan a notification.
 */
export const deliverInvitationExpiryReminder = internalMutation({
  args: {
    invitationId: v.id("invitations"),
    expectedResendCount: v.number(),
    expectedExpiresAt: v.number(),
    daysBefore: reminderDaysBeforeValidator,
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

    const now = Date.now();
    if (now >= invitation.expiresAt) {
      return;
    }

    const thresholdAt = invitation.expiresAt - args.daysBefore * DAY_MS;
    if (now < thresholdAt) {
      return;
    }
    // Late 3-day jobs skip once the 1-day window opens; 1-day jobs skip at expiry.
    if (args.daysBefore === 3 && now >= invitation.expiresAt - DAY_MS) {
      return;
    }

    if (await isInvitationBlockedByAccountDeletion(ctx, invitation)) {
      return;
    }

    const circle = await ctx.db.get(invitation.circleId);
    if (circle === null || circle.setupCompletedAt === null || circle.status !== "active") {
      return;
    }

    const inviter = await ctx.db.get(invitation.invitedByUserId);
    if (inviter === null) {
      return;
    }

    const invitee = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", invitation.emailLower))
      .unique();
    if (invitee === null) {
      return;
    }

    const membership = await ctx.db
      .query("members")
      .withIndex("by_circle_and_user", (q) =>
        q.eq("circleId", invitation.circleId).eq("userId", invitee._id),
      )
      .unique();
    if (membership && (await isEffectiveActiveMember(ctx, membership))) {
      return;
    }

    const sent = invitation.remindersSent ?? [];
    if (sent.includes(args.daysBefore)) {
      return;
    }

    const type =
      args.daysBefore === 3 ? "invitation.expiring_soon" : "invitation.expiring_tomorrow";
    const title =
      args.daysBefore === 3 ? "Invitation expires in 3 days" : "Invitation expires in 1 day";
    const inserted = await insertNotificationRow(ctx, {
      recipientUserId: invitee._id,
      type,
      title,
      body: `Your invitation to ${circle.name} is waiting for a response.`,
      link: buildInvitationNotificationLink(invitationRef(circle, invitation._id)),
    });
    if (!inserted) {
      return;
    }

    await ctx.db.patch(invitation._id, {
      remindersSent: [...sent, args.daysBefore],
    });
  },
});

/** Fan-out coordinator for circle archive/restore — schedules one deliverOne per Member. */
export const fanOutCircleLifecycle = internalMutation({
  args: {
    circleId: v.id("circles"),
    actorUserId: v.id("users"),
    actorDisplayName: v.string(),
    action: v.union(v.literal("archived"), v.literal("restored")),
  },
  handler: async (ctx, args) => {
    const circle = await ctx.db.get(args.circleId);
    if (!circle) {
      return;
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_circle_and_status", (q) =>
        q.eq("circleId", args.circleId).eq("status", "active"),
      )
      .collect();

    const link = buildCircleNotificationLink(circleRef(circle));
    const archived = args.action === "archived";
    const type = archived ? "circle.archived" : "circle.restored";
    const title = archived ? "Circle archived" : "Circle restored";
    const body = archived
      ? `${args.actorDisplayName} archived ${circle.name}.`
      : `${args.actorDisplayName} restored ${circle.name}.`;

    for (const member of members) {
      if (!(await isEffectiveActiveMember(ctx, member))) {
        continue;
      }
      await scheduleDeliverOne(ctx, {
        recipientUserId: member.userId,
        actorUserId: args.actorUserId,
        type,
        title,
        body,
        link,
      });
    }
  },
});

async function scheduleDeliverOne(ctx: MutationCtx, args: DeliverOneArgs) {
  if (isActorSkip(args.recipientUserId, args.actorUserId)) {
    return;
  }
  await ctx.scheduler.runAfter(0, internal.notify.deliverOne, args);
}

function circleRef(circle: Doc<"circles">) {
  return buildRef(circle.name, circle._id);
}

function invitationRef(circle: Doc<"circles">, invitationId: Id<"invitations">) {
  return buildRef(circle.name, invitationId);
}

async function notifyInvitationOffer(
  ctx: MutationCtx,
  opts: {
    inviteeUserId: Id<"users">;
    actorUserId: Id<"users">;
    circle: Doc<"circles">;
    invitationId: Id<"invitations">;
    type: "invitation.received" | "invitation.resent";
    title: string;
    body: string;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.inviteeUserId,
    actorUserId: opts.actorUserId,
    type: opts.type,
    title: opts.title,
    body: opts.body,
    link: buildInvitationNotificationLink(invitationRef(opts.circle, opts.invitationId)),
  });
}

export async function notifyInvitationReceived(
  ctx: MutationCtx,
  opts: {
    inviteeUserId: Id<"users">;
    actorUserId: Id<"users">;
    circle: Doc<"circles">;
    invitationId: Id<"invitations">;
  },
) {
  await notifyInvitationOffer(ctx, {
    ...opts,
    type: "invitation.received",
    title: "Circle invitation",
    body: `You've been invited to ${opts.circle.name}.`,
  });
}

export async function notifyInvitationResent(
  ctx: MutationCtx,
  opts: {
    inviteeUserId: Id<"users">;
    actorUserId: Id<"users">;
    circle: Doc<"circles">;
    invitationId: Id<"invitations">;
  },
) {
  await notifyInvitationOffer(ctx, {
    ...opts,
    type: "invitation.resent",
    title: "Invitation resent",
    body: `Your invitation to ${opts.circle.name} was resent.`,
  });
}

export async function notifyInvitationAccepted(
  ctx: MutationCtx,
  opts: {
    inviterUserId: Id<"users">;
    acceptorUserId: Id<"users">;
    acceptorDisplayName: string;
    circle: Doc<"circles">;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.inviterUserId,
    actorUserId: opts.acceptorUserId,
    type: "invitation.accepted",
    title: "Invitation accepted",
    body: `${opts.acceptorDisplayName} joined ${opts.circle.name}.`,
    link: buildCircleNotificationLink(circleRef(opts.circle)),
  });
}

export async function notifyInvitationRevoked(
  ctx: MutationCtx,
  opts: {
    inviteeUserId: Id<"users">;
    actorUserId: Id<"users">;
    circleName: string;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.inviteeUserId,
    actorUserId: opts.actorUserId,
    type: "invitation.revoked",
    title: "Invitation revoked",
    body: `Your invitation to ${opts.circleName} was revoked.`,
  });
}

export async function notifyRemovedFromCircle(
  ctx: MutationCtx,
  opts: {
    removedUserId: Id<"users">;
    actorUserId: Id<"users">;
    circle: Doc<"circles">;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.removedUserId,
    actorUserId: opts.actorUserId,
    type: "member.removed",
    title: "Removed from Circle",
    body: `You were removed from ${opts.circle.name}.`,
    link: buildCircleNotificationLink(circleRef(opts.circle)),
  });
}

export async function notifyOwnershipTransferred(
  ctx: MutationCtx,
  opts: {
    newOwnerUserId: Id<"users">;
    actorUserId: Id<"users">;
    circle: Doc<"circles">;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.newOwnerUserId,
    actorUserId: opts.actorUserId,
    type: "ownership.transferred",
    title: "Ownership transferred",
    body: `You are now the Owner of ${opts.circle.name}.`,
    link: buildCircleNotificationLink(circleRef(opts.circle)),
  });
}

export async function notifyCircleLifecycleChange(
  ctx: MutationCtx,
  opts: {
    circle: Doc<"circles">;
    actorUserId: Id<"users">;
    actorDisplayName: string;
    action: "archived" | "restored";
  },
) {
  // Always schedule: a fixed raw-member sample can miss living non-actors that
  // sit after stale active rows (deleted Users not yet converted). Fan-out still
  // skips the actor and ineffective members.
  await ctx.scheduler.runAfter(0, internal.notify.fanOutCircleLifecycle, {
    circleId: opts.circle._id,
    actorUserId: opts.actorUserId,
    actorDisplayName: opts.actorDisplayName,
    action: opts.action,
  });
}

export async function notifyPaidBySet(
  ctx: MutationCtx,
  opts: {
    paidByUserId: Id<"users">;
    actorUserId: Id<"users">;
    actorDisplayName: string;
    circle: Doc<"circles">;
    transaction: Doc<"transactions">;
  },
) {
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.paidByUserId,
    actorUserId: opts.actorUserId,
    type: "transaction.paid_by",
    title: "Paid By updated",
    body: `${opts.actorDisplayName} set you as Paid By on ${opts.transaction.title}.`,
    link: buildTransactionNotificationLink(
      circleRef(opts.circle),
      buildRef(opts.transaction.title, opts.transaction._id),
    ),
  });
}

export async function notifyTransactionLifecycleChange(
  ctx: MutationCtx,
  opts: {
    recorderUserId: Id<"users">;
    actorUserId: Id<"users">;
    actorDisplayName: string;
    circle: Doc<"circles">;
    transaction: Doc<"transactions">;
    action: "archived" | "restored";
  },
) {
  const archived = opts.action === "archived";
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.recorderUserId,
    actorUserId: opts.actorUserId,
    type: archived ? "transaction.archived" : "transaction.restored",
    title: archived ? "Transaction archived" : "Transaction restored",
    body: archived
      ? `${opts.actorDisplayName} archived ${opts.transaction.title}.`
      : `${opts.actorDisplayName} restored ${opts.transaction.title}.`,
    link: buildTransactionNotificationLink(
      circleRef(opts.circle),
      buildRef(opts.transaction.title, opts.transaction._id),
    ),
  });
}

export async function notifyCategoryLifecycleChange(
  ctx: MutationCtx,
  opts: {
    creatorUserId: Id<"users">;
    actorUserId: Id<"users">;
    actorDisplayName: string;
    circle: Doc<"circles">;
    category: Doc<"categories">;
    action: "archived" | "restored";
  },
) {
  const archived = opts.action === "archived";
  await scheduleDeliverOne(ctx, {
    recipientUserId: opts.creatorUserId,
    actorUserId: opts.actorUserId,
    type: archived ? "category.archived" : "category.restored",
    title: archived ? "Category archived" : "Category restored",
    body: archived
      ? `${opts.actorDisplayName} archived ${opts.category.name}.`
      : `${opts.actorDisplayName} restored ${opts.category.name}.`,
    link: buildCategoryNotificationLink(
      circleRef(opts.circle),
      buildRef(opts.category.name, opts.category._id),
    ),
  });
}
