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
import { isPushDeliveryEnabled, isSubscriptionEligibleForPushDelivery } from "./pushDelivery.js";
import { listPushSubscriptionsForUser } from "./pushSubscriptions.js";
import { reportTerminalFailure } from "./terminalFailure.js";

export {
  isPushDeliveryEnabled,
  isSubscriptionEligibleForPushDelivery,
  pushDeliverySinceMs,
} from "./pushDelivery.js";

/**
 * Best-effort Push mirror of Notification Center rows (ADR 0033 / #382).
 *
 * Dedicated pool — isolated from email so a slow push provider cannot starve
 * Invitation delivery. Free-plan action ceiling is 20 across ALL pools;
 * email takes 5, push takes 3.
 *
 * Jobs are always enqueued from NC. `PUSH_DELIVERY_ENABLED=1` gates actual
 * delivery: while unset/other, `sendOne` defers (re-enqueues with delay) so
 * rollout can pause without dropping Workpool jobs. Optional
 * `PUSH_DELIVERY_SINCE_MS` further requires subscription `lastSeenAt` at/after
 * that floor (devices that opened the app after the display SW).
 */

export const PUSH_RETRY_BEHAVIOR = {
  maxAttempts: 4,
  initialBackoffMs: 15_000,
  base: 2,
};

/** How long to wait before retrying a send while delivery is paused. */
export const PUSH_DELIVERY_PAUSE_POLL_MS = 30_000;

export const pushPool = new Workpool(components.pushWorkpool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: PUSH_RETRY_BEHAVIOR,
});

type SendOneArgs = {
  notificationId: Id<"notifications">;
  subscriptionId: Id<"pushSubscriptions">;
  invitationExpiresAtMs?: number;
};

async function enqueueSendOne(
  ctx: MutationCtx,
  args: SendOneArgs,
  options?: { runAfter?: number },
) {
  await pushPool.enqueueAction(ctx, internal.pushSend.sendOne, args, {
    runAfter: options?.runAfter,
    onComplete: internal.push.onSendComplete,
    context: {
      notificationId: args.notificationId,
      subscriptionId: args.subscriptionId,
    },
  });
}

/**
 * After a Notification Center insert: one Push job per active subscription.
 * No-ops when the recipient has no subscriptions (most users / most tests).
 * Still enqueues while delivery is paused — send defers until enabled.
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
  const subscriptions = (await listPushSubscriptionsForUser(ctx, args.recipientUserId)).filter(
    (subscription) => isSubscriptionEligibleForPushDelivery(subscription.lastSeenAt),
  );
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
      await enqueueSendOne(ctx, {
        notificationId: args.notificationId,
        subscriptionId: subscription._id,
        invitationExpiresAtMs,
      });
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

/**
 * Re-enqueue a send after delivery was paused mid-flight. Drops jobs whose TTL
 * is already expired so a long pause does not poll forever. If delivery is now
 * enabled, enqueue immediately; otherwise poll again after a delay.
 */
export const deferSendWhileDeliveryPaused = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    subscriptionId: v.id("pushSubscriptions"),
    invitationExpiresAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification) {
      return;
    }
    const ttlSeconds = pushTtlSeconds({
      type: notification.type,
      nowMs: Date.now(),
      invitationExpiresAtMs: args.invitationExpiresAtMs,
    });
    if (ttlSeconds <= 0) {
      return;
    }
    if (isPushDeliveryEnabled()) {
      await enqueueSendOne(ctx, args);
      return;
    }
    await enqueueSendOne(ctx, args, { runAfter: PUSH_DELIVERY_PAUSE_POLL_MS });
  },
});

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
      lastSeenAt: subscription.lastSeenAt,
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
