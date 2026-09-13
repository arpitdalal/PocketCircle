/**
 * Per-device Web Push subscription constraints (ADR 0033 / issue #381).
 * Structural checks only — Convex re-validates at the mutation boundary.
 * Node send path additionally resolves DNS and rejects private addresses.
 */

import { Address4, Address6 } from "ip-address";

/** Soft cap on active subscriptions per User; enable prunes then LRU-replaces. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** Default VAPID key identity when `VAPID_KEY_ID` env is unset (v1 single key). */
export const DEFAULT_VAPID_KEY_ID = "primary";

/** Non-empty https Push endpoint (browser Push API). */
export function isValidPushEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0 || trimmed !== endpoint || endpoint.length > 4096) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function normalizeHostname(host: string) {
  // `localhost.` and similar absolute forms should still fail local checks.
  return host.replace(/\.+$/, "").toLowerCase();
}

function isIpLiteralHostname(host: string) {
  if (host.startsWith("[") && host.endsWith("]")) {
    return true;
  }
  if (host.includes(":")) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * True when the address is not globally reachable (private, loopback, link-local,
 * CGNAT, documentation, benchmarking, multicast, reserved, ULA, …). Uses
 * `ip-address` IANA special-purpose registries — fail closed on unparseable.
 */
export function isPrivateOrReservedIpAddress(ip: string) {
  const value = ip.trim();
  if (value.length === 0) {
    return true;
  }
  try {
    const address = value.includes(":") ? new Address6(value) : new Address4(value);
    return !address.isGlobal();
  } catch {
    return true;
  }
}

/**
 * HTTPS Push endpoint structurally safe to attempt (SSRF hostname gate).
 *
 * Browsers pick opaque push-service hosts — no vendor allowlist. Reject
 * loopback / link-local / internal hostnames and IP literals. The Node sender
 * must still resolve DNS and reject private/reserved addresses before POST.
 */
export function isSafePushEndpoint(endpoint: string) {
  if (!isValidPushEndpoint(endpoint)) {
    return false;
  }
  const host = normalizeHostname(new URL(endpoint).hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".corp") ||
    host.endsWith(".lan") ||
    host === "metadata.google.internal"
  ) {
    return false;
  }
  if (isIpLiteralHostname(host)) {
    return false;
  }
  return true;
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) {
    return null;
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const binary = atob(normalized + "=".repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Endpoint + encryption keys present and structurally usable for web-push encrypt. */
export function isValidPushSubscriptionMaterial(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId?: string;
}) {
  if (!isSafePushEndpoint(input.endpoint)) {
    return false;
  }
  const p256dh = decodeBase64Url(input.p256dh.trim());
  const auth = decodeBase64Url(input.auth.trim());
  if (!p256dh || !auth) {
    return false;
  }
  // RFC 8291: user-agent p256dh is 65-byte uncompressed (0x04 || X || Y); auth is 16 bytes.
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) {
    return false;
  }
  return (
    input.vapidKeyId === undefined ||
    (input.vapidKeyId.trim().length > 0 && input.vapidKeyId.length <= 128)
  );
}
