"use node";

import { DEFAULT_VAPID_KEY_ID } from "@pocketcircle/domain";
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
      // Collapse key for push-service dedupe on Workpool retry (max 32 octets).
      topic: args.payload.tag.slice(0, 32),
    },
  );
}

function resolveVapidDetailsForKeyId(vapidKeyId: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  const configuredKeyId = process.env.VAPID_KEY_ID?.trim() || DEFAULT_VAPID_KEY_ID;
  if (!publicKey || !privateKey || !subject) {
    return null;
  }
  if (vapidKeyId !== configuredKeyId) {
    // Subscription bound to a key we no longer hold — skip without retry/pruning.
    return null;
  }
  return { publicKey, privateKey, subject };
}

export const sendOne = internalAction({
  args: {
    notificationId: v.id("notifications"),
    subscriptionId: v.id("pushSubscriptions"),
    ttlSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    const prepared = await ctx.runQuery(internal.push.loadSendPayload, {
      notificationId: args.notificationId,
      subscriptionId: args.subscriptionId,
    });
    if (!prepared) {
      return;
    }

    const vapidDetails = resolveVapidDetailsForKeyId(prepared.vapidKeyId);
    if (!vapidDetails) {
      console.error("VAPID env not configured or key id mismatch; skipping push send");
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
        ttlSeconds: args.ttlSeconds,
        vapidDetails,
      });
    } catch (error) {
      const statusCode = pushHttpStatusFromError(error);
      if (statusCode !== undefined && classifyPushHttpStatus(statusCode) === "gone") {
        await ctx.runMutation(internal.pushSubscriptions.removeInvalidPushSubscription, {
          endpoint: prepared.endpoint,
        });
        return;
      }
      throw error;
    }
  },
});
