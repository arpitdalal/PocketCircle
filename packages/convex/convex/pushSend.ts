"use node";

import { createHash } from "node:crypto";
import { DEFAULT_VAPID_KEY_ID, isTrustedPushEndpoint, pushTtlSeconds } from "@pocketcircle/domain";
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
 * (defaults to `"primary"`). During rotation also set `VAPID_KEY_ID_PREVIOUS`,
 * `VAPID_PUBLIC_KEY_PREVIOUS`, `VAPID_PRIVATE_KEY_PREVIOUS` (same subject).
 */

/** Bound hung push-service sockets so Workpool slots are not stuck for minutes. */
export const PUSH_SEND_TIMEOUT_MS = 30_000;

/** RFC 8030 Topic: ≤32 base64url chars — hash the NC id so retries coalesce safely. */
export function pushTopicFromNotificationId(notificationId: string) {
  return createHash("sha256").update(notificationId).digest("base64url").slice(0, 32);
}

export function isValidVapidSubject(subject: string) {
  return subject.startsWith("mailto:") || subject.startsWith("https:");
}

function decodeVapidKeyBytes(key: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length > 128) {
    return null;
  }
  try {
    const bytes = Buffer.from(key, "base64url");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Uncompressed P-256 public key (65 bytes) as URL-safe base64. */
export function isValidVapidPublicKey(key: string) {
  return decodeVapidKeyBytes(key)?.length === 65;
}

/** P-256 private key (32 bytes) as URL-safe base64. */
export function isValidVapidPrivateKey(key: string) {
  return decodeVapidKeyBytes(key)?.length === 32;
}

/** Local encrypt/setup failures from bad subscription material (no HTTP status). */
export function isLikelyInvalidSubscriptionCryptoError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /p256dh|auth|encrypt|crypto|Invalid key|unsupported|asymmetric/i.test(message);
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
      timeout: PUSH_SEND_TIMEOUT_MS,
    },
  );
}

function readVapidPair(args: {
  keyId: string;
  publicKey: string | undefined;
  privateKey: string | undefined;
  subject: string | undefined;
}) {
  const publicKey = args.publicKey?.trim();
  const privateKey = args.privateKey?.trim();
  const subject = args.subject?.trim();
  if (!publicKey || !privateKey || !subject) {
    return null;
  }
  if (
    !isValidVapidSubject(subject) ||
    !isValidVapidPublicKey(publicKey) ||
    !isValidVapidPrivateKey(privateKey)
  ) {
    return { kind: "invalid_env" as const };
  }
  return {
    kind: "ok" as const,
    keyId: args.keyId,
    details: { publicKey, privateKey, subject },
  };
}

function resolveVapidDetailsForKeyId(vapidKeyId: string) {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const currentKeyId = process.env.VAPID_KEY_ID?.trim() || DEFAULT_VAPID_KEY_ID;
  const current = readVapidPair({
    keyId: currentKeyId,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject,
  });
  if (!current) {
    return { kind: "missing_env" as const };
  }
  if (current.kind === "invalid_env") {
    return current;
  }

  const previousKeyId = process.env.VAPID_KEY_ID_PREVIOUS?.trim();
  const previous =
    previousKeyId === undefined || previousKeyId.length === 0
      ? null
      : readVapidPair({
          keyId: previousKeyId,
          publicKey: process.env.VAPID_PUBLIC_KEY_PREVIOUS,
          privateKey: process.env.VAPID_PRIVATE_KEY_PREVIOUS,
          subject,
        });

  if (vapidKeyId === current.keyId) {
    return current;
  }
  if (previous?.kind === "ok" && vapidKeyId === previous.keyId) {
    return previous;
  }
  if (previous?.kind === "invalid_env") {
    return previous;
  }
  return { kind: "key_mismatch" as const };
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

    // Defense in depth: bind already requires trusted hosts; never POST elsewhere.
    if (!isTrustedPushEndpoint(prepared.endpoint)) {
      await ctx.runMutation(internal.pushSubscriptions.removeInvalidPushSubscription, {
        subscriptionId: args.subscriptionId,
        endpoint: prepared.endpoint,
        p256dh: prepared.p256dh,
        auth: prepared.auth,
      });
      return;
    }

    const vapid = resolveVapidDetailsForKeyId(prepared.vapidKeyId);
    if (vapid.kind !== "ok") {
      const error =
        vapid.kind === "missing_env"
          ? "VAPID env not configured; skipping push send"
          : vapid.kind === "invalid_env"
            ? "VAPID env malformed; skipping push send"
            : "VAPID key id mismatch; skipping push send";
      console.error(error);
      await ctx.runMutation(internal.push.reportSendSkipped, {
        notificationId: args.notificationId,
        subscriptionId: args.subscriptionId,
        error,
      });
      return;
    }

    const pruneArgs = {
      subscriptionId: args.subscriptionId,
      endpoint: prepared.endpoint,
      p256dh: prepared.p256dh,
      auth: prepared.auth,
    };

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
        if (isLikelyInvalidSubscriptionCryptoError(error)) {
          await ctx.runMutation(
            internal.pushSubscriptions.removeInvalidPushSubscription,
            pruneArgs,
          );
          return;
        }
        throw error;
      }
      const classification = classifyPushHttpStatus(statusCode);
      if (classification === "gone") {
        await ctx.runMutation(internal.pushSubscriptions.removeInvalidPushSubscription, pruneArgs);
        return;
      }
      if (classification === "permanent") {
        await ctx.runMutation(internal.push.reportSendSkipped, {
          notificationId: args.notificationId,
          subscriptionId: args.subscriptionId,
          error: `Push service permanent rejection: ${statusCode}`,
        });
        return;
      }
      throw error;
    }
  },
});
