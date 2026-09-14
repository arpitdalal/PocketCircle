import { vOnCompleteValidator, Workpool } from "@convex-dev/workpool";
import {
  isInvitationPushType,
  parseNotificationLinkPath,
  pushBodyForNotificationType,
  pushTitleForNotificationType,
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
 *
 * `PUSH_DELIVERY_ENABLED=1` gates enqueue/send so production can deploy the
 * display-capable service worker before any silent Push reaches Safari
 * (which may revoke permission). Unset/other values skip delivery.
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

/** True only when ops explicitly enabled delivery after the display SW is live. */
export function isPushDeliveryEnabled() {
  return process.env.PUSH_DELIVERY_ENABLED === "1";
}

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
    invitationExpiresAt?: number;
  },
) {
  if (!isPushDeliveryEnabled()) {
    return;
  }
  const subscriptions = await listPushSubscriptionsForUser(ctx, args.recipientUserId);
  if (subscriptions.length === 0) {
    return;
  }

  const invitationExpiresAtMs =
    args.invitationExpiresAt ?? (await resolveInvitationExpiresAtMs(ctx, args.type, args.link));
  const ttlSeconds = pushTtlSeconds({
    type: args.type,
    nowMs: Date.now(),
    invitationExpiresAtMs,
  });
  if (ttlSeconds <= 0) {
    return;
  }

  for (const subscription of subscriptions) {
    try {
      await pushPool.enqueueAction(
        ctx,
        internal.pushSend.sendOne,
        {
          notificationId: args.notificationId,
          subscriptionId: subscription._id,
          invitationExpiresAtMs,
        },
        {
          onComplete: internal.push.onSendComplete,
          context: {
            notificationId: args.notificationId,
            subscriptionId: subscription._id,
          },
        },
      );
    } catch (error) {
      // Keep fan-out going: one enqueue failure must not strand remaining subs.
      console.error(
        "Push enqueue failed for subscription",
        subscription._id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** Payload for the Node sender — lock-screen-safe title/body from event type. */
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
      type: notification.type,
      title: pushTitleForNotificationType(notification.type),
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

/** VAPID skip / key mismatch — record once without Workpool retry. */
export const reportSendSkipped = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    subscriptionId: v.id("pushSubscriptions"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await reportTerminalFailure(ctx, {
      kind: "push_delivery_exhausted",
      entityId: `${args.notificationId}:${args.subscriptionId}`,
      error: args.error,
    });
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
