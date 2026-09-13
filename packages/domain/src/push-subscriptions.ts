/**
 * Per-device Web Push subscription constraints (ADR 0033 / issue #381).
 * Structural checks only — Convex re-validates at the mutation boundary.
 */

/** Soft cap on active subscriptions per User; enable prunes then LRU-replaces. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** Default VAPID key identity when `VAPID_KEY_ID` env is unset (v1 single key). */
export const DEFAULT_VAPID_KEY_ID = "primary";

/**
 * Synthetic valid subscription key material for tests (not a real ECDH key —
 * correct decoded lengths so bind validation accepts the fixture).
 */
export const TEST_PUSH_P256DH =
  "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
export const TEST_PUSH_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";
/** Second synthetic pair for refresh/rebind tests. */
export const TEST_PUSH_P256DH_ALT =
  "BAoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo";
export const TEST_PUSH_AUTH_ALT = "CwsLCwsLCwsLCwsLCwsLCw";

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
  if (!isValidPushEndpoint(input.endpoint)) {
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
