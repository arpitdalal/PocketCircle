/**
 * Per-device Web Push subscription constraints (ADR 0033 / issue #381).
 * Structural checks only — Convex re-validates at the mutation boundary.
 */

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

function isIpLiteralHostname(host: string) {
  // IPv6 URL hostnames are bracketed; IPv4 is dotted-decimal.
  if (host.startsWith("[") && host.endsWith("]")) {
    return true;
  }
  if (host.includes(":")) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * HTTPS Push endpoint safe to POST from the server (SSRF).
 *
 * Browsers pick opaque push-service hosts — do not require a vendor allowlist.
 * Reject loopback / link-local / internal hostnames and IP literals so the
 * Node sender cannot be aimed at private network destinations.
 */
export function isSafePushEndpoint(endpoint: string) {
  if (!isValidPushEndpoint(endpoint)) {
    return false;
  }
  const host = new URL(endpoint).hostname.toLowerCase();
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
  // Uncompressed (65) or compressed (33) P-256 public key; auth secret is 16 bytes.
  if ((p256dh.length !== 65 && p256dh.length !== 33) || auth.length !== 16) {
    return false;
  }
  return (
    input.vapidKeyId === undefined ||
    (input.vapidKeyId.trim().length > 0 && input.vapidKeyId.length <= 128)
  );
}
