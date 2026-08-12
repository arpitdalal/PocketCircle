import {
  buildCategoryNotificationLink,
  buildCircleNotificationLink,
  buildRef,
  buildTransactionNotificationLink,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./_generated/server.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";

/** Closed set of v1 notification types — a typo can't create an unknown type. */
export const NOTIFICATION_TYPES = [
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

/**
 * Single-recipient delivery seam (NTF-2 / ADR 0027). The sole writer of
 * `notifications` — actor-skip is enforced at enqueue time; this guard is a
 * backstop for direct internal calls.
 */
export const deliverOne = internalMutation({
  args: deliverOneArgsValidator,
  handler: async (ctx, args) => {
    if (isActorSkip(args.recipientUserId, args.actorUserId)) {
      return;
    }

    const recipient = await ctx.db.get("users", args.recipientUserId);
    if (!recipient) {
      return;
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
