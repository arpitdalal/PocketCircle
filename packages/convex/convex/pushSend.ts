"use node";

import { createHash } from "node:crypto";
import { DEFAULT_VAPID_KEY_ID, pushTtlSeconds } from "@pocketcircle/domain";
import { v } from "convex/values";
import webpush from "web-push";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { classifyPushHttpStatus, pushHttpStatusFromError } from "./pushFailure.js";

/**
 * Node-only Push sender (ADR 0033). `web-push` needs Node crypto — keep this
 * module free of isolate imports that pull Convex mutations into the Node bundle
 * beyond `internal` API refs.
 *
 * Env (deployment secrets): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
 * `VAPID_SUBJECT` (mailto: or https: contact), optional `VAPID_KEY_ID`
 * (defaults to `"primary"`). Dev and prod use separate key pairs.
 */

/** RFC 8030 Topic: ≤32 base64url chars — hash the NC id so retries coalesce safely. */
export function pushTopicFromNotificationId(notificationId: string) {
  return createHash("sha256").update(notificationId).digest("base64url").slice(0, 32);
}

export async function sendWebPushNotification(args: {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: {
    title: string;
    body: string;
    tag: string;
  };
  ttlSeconds: number;
  vapidDetails: {
    subject: string;
    publicKey: string;
    privateKey: string;
  };
}) {
  await webpush.sendNotification(
    {
      endpoint: args.endpoint,
      keys: {
        p256dh: args.p256dh,
        auth: args.auth,
      },
    },
    JSON.stringify(args.payload),
    {
      TTL: args.ttlSeconds,
      vapidDetails: args.vapidDetails,
      topic: pushTopicFromNotificationId(args.payload.tag),
    },
  );
}

function resolveVapidDetailsForKeyId(vapidKeyId: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  const configuredKeyId = process.env.VAPID_KEY_ID?.trim() || DEFAULT_VAPID_KEY_ID;
  if (!publicKey || !privateKey || !subject) {
    return { kind: "missing_env" as const };
  }
  if (vapidKeyId !== configuredKeyId) {
    return { kind: "key_mismatch" as const };
  }
  return {
    kind: "ok" as const,
    details: { publicKey, privateKey, subject },
  };
}

export const sendOne = internalAction({
  args: {
    notificationId: v.id("notifications"),
    subscriptionId: v.id("pushSubscriptions"),
    invitationExpiresAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const prepared = await ctx.runQuery(internal.push.loadSendPayload, {
      notificationId: args.notificationId,
      subscriptionId: args.subscriptionId,
    });
    if (!prepared) {
      return;
    }

    const ttlSeconds = pushTtlSeconds({
      type: prepared.type,
      nowMs: Date.now(),
      invitationExpiresAtMs: args.invitationExpiresAtMs,
    });
    if (ttlSeconds <= 0) {
      return;
    }

    const vapid = resolveVapidDetailsForKeyId(prepared.vapidKeyId);
    if (vapid.kind !== "ok") {
      const error =
        vapid.kind === "missing_env"
          ? "VAPID env not configured; skipping push send"
          : "VAPID key id mismatch; skipping push send";
      console.error(error);
      await ctx.runMutation(internal.push.reportSendSkipped, {
        notificationId: args.notificationId,
        subscriptionId: args.subscriptionId,
        error,
      });
      return;
    }

    try {
      await sendWebPushNotification({
        endpoint: prepared.endpoint,
        p256dh: prepared.p256dh,
        auth: prepared.auth,
        payload: {
          title: prepared.title,
          body: prepared.body,
          tag: prepared.tag,
        },
        ttlSeconds,
        vapidDetails: vapid.details,
      });
    } catch (error) {
      const statusCode = pushHttpStatusFromError(error);
      if (statusCode === undefined) {
        throw error;
      }
      const classification = classifyPushHttpStatus(statusCode);
      if (classification === "gone") {
        try {
          await ctx.runMutation(internal.pushSubscriptions.removeInvalidPushSubscription, {
            endpoint: prepared.endpoint,
          });
        } catch (removeError) {
          console.error("Failed to prune invalid push subscription", removeError);
        }
        return;
      }
      if (classification === "permanent") {
        return;
      }
      throw error;
    }
  },
});
