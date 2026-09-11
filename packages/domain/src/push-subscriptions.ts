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
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Endpoint + encryption keys present and structurally usable. */
export function isValidPushSubscriptionMaterial(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
}) {
  return (
    isValidPushEndpoint(input.endpoint) &&
    input.p256dh.trim().length > 0 &&
    input.auth.trim().length > 0
  );
}
