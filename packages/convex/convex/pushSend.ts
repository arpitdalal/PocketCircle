"use node";

import { createECDH, createHash, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import https from "node:https";
import {
  DEFAULT_VAPID_KEY_ID,
  isPrivateOrReservedIpAddress,
  isSafePushEndpoint,
  pushTtlSeconds,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import webpush from "web-push";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { isPushDeliveryEnabled, isSubscriptionEligibleForPushDelivery } from "./pushDelivery.js";
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
  try {
    const parsed = new URL(subject);
    if (parsed.protocol === "https:") {
      return parsed.hostname.length > 0;
    }
    if (parsed.protocol === "mailto:") {
      return subject.slice("mailto:".length).trim().length > 0;
    }
    return false;
  } catch {
    return false;
  }
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

/** Uncompressed P-256 public key (65 bytes, 0x04 prefix) as URL-safe base64. */
export function isValidVapidPublicKey(key: string) {
  const bytes = decodeVapidKeyBytes(key);
  return bytes?.length === 65 && bytes[0] === 0x04;
}

/** P-256 private key (32 bytes) as URL-safe base64. */
export function isValidVapidPrivateKey(key: string) {
  return decodeVapidKeyBytes(key)?.length === 32;
}

/**
 * True when `publicKey` is the P-256 point derived from `privateKey`.
 * Length-valid but mismatched pairs would otherwise sign with one key and
 * advertise another — permanent push-service rejections until env is fixed.
 */
export function isMatchingVapidKeyPair(publicKey: string, privateKey: string) {
  const publicBytes = decodeVapidKeyBytes(publicKey);
  const privateBytes = decodeVapidKeyBytes(privateKey);
  if (
    !publicBytes ||
    publicBytes.length !== 65 ||
    publicBytes[0] !== 0x04 ||
    !privateBytes ||
    privateBytes.length !== 32
  ) {
    return false;
  }
  try {
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(privateBytes);
    const derived = curve.getPublicKey();
    if (derived.length !== publicBytes.length) {
      return false;
    }
    return timingSafeEqual(derived, publicBytes);
  } catch {
    return false;
  }
}

/** Local encrypt failures that name subscription key material (not VAPID/runtime). */
export function isLikelyInvalidSubscriptionCryptoError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  // Node rejects off-curve p256dh during ECDH without naming "p256dh" in the message.
  // Match the errno only — message-only would false-prune unrelated crypto noise.
  if (code === "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY") {
    return true;
  }
  // Require an explicit subscription-key token so OpenSSL/VAPID/"crypto" noise
  // does not prune healthy bindings.
  const namesSubscriptionKey = /\bp256dh\b/i.test(message) || /\bauth\b/i.test(message);
  const looksLikeEncryptFailure = /encrypt|decrypt|Invalid key|bad key|unsupported key/i.test(
    message,
  );
  return namesSubscriptionKey && looksLikeEncryptFailure;
}

/**
 * Resolve the endpoint host and classify for SSRF / rebinding.
 * Hostname spelling alone is insufficient — DNS may point a public name at RFC1918.
 * Callers must pin `public` addresses into the outbound request (custom Agent lookup).
 *
 * All DNS exceptions are `lookup_failed` (Workpool retry). Node documents that
 * `ENOTFOUND` is not only NXDOMAIN — e.g. no free FDs — so pruning on it would
 * wipe healthy FCM/Mozilla/Apple bindings under resource pressure. Empty answers
 * and private/reserved addresses stay `unsafe` (SSRF / unusable).
 */
export async function resolvePushEndpointAddresses(endpoint: string) {
  if (!isSafePushEndpoint(endpoint)) {
    return { kind: "unsafe" as const };
  }
  const host = new URL(endpoint).hostname.replace(/\.+$/, "");
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return { kind: "unsafe" as const };
    }
    if (records.some((record) => isPrivateOrReservedIpAddress(record.address))) {
      return { kind: "unsafe" as const };
    }
    return { kind: "public" as const, addresses: records };
  } catch (cause) {
    return { kind: "lookup_failed" as const, cause };
  }
}

/** Boolean helper used by unit tests; prefer {@link resolvePushEndpointAddresses}. */
export async function endpointResolvesToPublicAddress(endpoint: string) {
  const resolved = await resolvePushEndpointAddresses(endpoint);
  return resolved.kind === "public";
}

/** Pin validated A/AAAA results so send cannot rebind after the SSRF check. */
export function createPinnedHttpsAgent(addresses: { address: string; family: number }[]) {
  const preferred = addresses[0];
  if (!preferred) {
    throw new Error("expected validated DNS addresses");
  }
  return new https.Agent({
    lookup(_hostname, options, callback) {
      const cb = typeof options === "function" ? options : callback;
      if (typeof cb !== "function") {
        return;
      }
      const wantsAll = typeof options === "object" && options !== null && options.all === true;
      if (wantsAll) {
        cb(
          null,
          addresses.map((entry) => ({ address: entry.address, family: entry.family })),
        );
        return;
      }
      const family =
        typeof options === "object" && options !== null && typeof options.family === "number"
          ? options.family
          : undefined;
      const match =
        family === undefined
          ? preferred
          : (addresses.find((entry) => entry.family === family) ?? preferred);
      cb(null, match.address, match.family);
    },
  });
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
  agent?: https.Agent;
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
      ...(args.agent ? { agent: args.agent } : {}),
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
    !isValidVapidPrivateKey(privateKey) ||
    !isMatchingVapidKeyPair(publicKey, privateKey)
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
    // Gate here: Workpool jobs queued before/during a rollout disable must not
    // deliver silent Push. Defer (re-enqueue) instead of ack-success so jobs
    // survive until PUSH_DELIVERY_ENABLED=1 without burning retry budget.
    if (!isPushDeliveryEnabled()) {
      await ctx.runMutation(internal.push.deferSendWhileDeliveryPaused, {
        notificationId: args.notificationId,
        subscriptionId: args.subscriptionId,
        invitationExpiresAtMs: args.invitationExpiresAtMs,
      });
      return;
    }
    const prepared = await ctx.runQuery(internal.push.loadSendPayload, {
      notificationId: args.notificationId,
      subscriptionId: args.subscriptionId,
    });
    if (!prepared) {
      return;
    }
    if (
      !isSubscriptionEligibleForPushDelivery({
        lastSeenAt: prepared.lastSeenAt,
        pushSwVersion: prepared.pushSwVersion,
      })
    ) {
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

    // Defense in depth: structural public HTTPS + resolved public addresses only.
    // Pin those addresses into the Agent so send cannot TOCTOU-rebind.
    const resolved = await resolvePushEndpointAddresses(prepared.endpoint);
    if (resolved.kind === "lookup_failed") {
      throw resolved.cause instanceof Error
        ? resolved.cause
        : new Error("Push endpoint DNS lookup failed");
    }
    if (resolved.kind === "unsafe") {
      await ctx.runMutation(internal.pushSubscriptions.removeInvalidPushSubscription, {
        subscriptionId: args.subscriptionId,
        endpoint: prepared.endpoint,
        p256dh: prepared.p256dh,
        auth: prepared.auth,
      });
      return;
    }
    const agent = createPinnedHttpsAgent(resolved.addresses);

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
        agent,
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
