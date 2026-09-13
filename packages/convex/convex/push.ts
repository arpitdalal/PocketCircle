import { vOnCompleteValidator, Workpool } from "@convex-dev/workpool";
import {
  isInvitationPushType,
  parseNotificationLinkPath,
  pushBodyForNotificationType,
  pushTtlSeconds,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { listPushSubscriptionsForUser } from "./pushSubscriptions.js";
import { reportTerminalFailure } from "./terminalFailure.js";

/**
 * Best-effort Push mirror of Notification Center rows (ADR 0033 / #382).
 *
 * Dedicated pool — isolated from email so a slow push provider cannot starve
 * Invitation delivery. Free-plan action ceiling is 20 across ALL pools;
 * email takes 5, push takes 3.
 */

export const PUSH_RETRY_BEHAVIOR = {
  maxAttempts: 4,
  initialBackoffMs: 15_000,
  base: 2,
};

export const pushPool = new Workpool(components.pushWorkpool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: PUSH_RETRY_BEHAVIOR,
});

/**
 * After a Notification Center insert: one Push job per active subscription.
 * No-ops when the recipient has no subscriptions (most users / most tests).
 */
export async function enqueuePushForNotification(
  ctx: MutationCtx,
  args: {
    notificationId: Id<"notifications">;
    recipientUserId: Id<"users">;
    type: string;
    link?: string;
  },
) {
  const subscriptions = await listPushSubscriptionsForUser(ctx, args.recipientUserId);
  if (subscriptions.length === 0) {
    return;
  }

  const invitationExpiresAtMs = await resolveInvitationExpiresAtMs(ctx, args.type, args.link);
  const ttlSeconds = pushTtlSeconds({
    type: args.type,
    nowMs: Date.now(),
    invitationExpiresAtMs,
  });
  if (ttlSeconds <= 0) {
    return;
  }

  for (const subscription of subscriptions) {
    await pushPool.enqueueAction(
      ctx,
      internal.pushSend.sendOne,
      {
        notificationId: args.notificationId,
        subscriptionId: subscription._id,
        ttlSeconds,
      },
      {
        onComplete: internal.push.onSendComplete,
        context: {
          notificationId: args.notificationId,
          subscriptionId: subscription._id,
        },
      },
    );
  }
}

/** Payload for the Node sender — title from NC row, lock-screen-safe body. */
export const loadSendPayload = internalQuery({
  args: {
    notificationId: v.id("notifications"),
    subscriptionId: v.id("pushSubscriptions"),
  },
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    const subscription = await ctx.db.get(args.subscriptionId);
    if (!notification || !subscription) {
      return null;
    }
    if (subscription.userId !== notification.userId) {
      return null;
    }
    return {
      title: notification.title,
      body: pushBodyForNotificationType(notification.type),
      tag: notification._id,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      vapidKeyId: subscription.vapidKeyId,
    };
  },
});

export const onSendComplete = internalMutation({
  args: vOnCompleteValidator(
    v.object({
      notificationId: v.id("notifications"),
      subscriptionId: v.id("pushSubscriptions"),
    }),
  ),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "failed") {
      await reportTerminalFailure(ctx, {
        kind: "push_delivery_exhausted",
        entityId: `${context.notificationId}:${context.subscriptionId}`,
        error: result.error,
      });
    }
  },
});

async function resolveInvitationExpiresAtMs(
  ctx: MutationCtx,
  type: string,
  link: string | undefined,
) {
  if (!isInvitationPushType(type) || link === undefined) {
    return undefined;
  }
  const parsed = parseNotificationLinkPath(link, () => true);
  if (parsed?.kind !== "invitation") {
    return undefined;
  }
  const invitationId = ctx.db.normalizeId("invitations", parsed.invitationId);
  if (!invitationId) {
    return undefined;
  }
  const invitation = await ctx.db.get(invitationId);
  return invitation?.expiresAt;
}
