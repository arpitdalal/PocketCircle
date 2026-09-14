/**
 * Shared Push delivery rollout gates (ADR 0033 / #382).
 * Kept free of Workpool / Node imports so isolate + Node send can both use it.
 */

/** True only when ops explicitly enabled delivery after the display SW is live. */
export function isPushDeliveryEnabled() {
  return process.env.PUSH_DELIVERY_ENABLED === "1";
}

/**
 * Optional floor: only deliver to subscriptions whose `lastSeenAt` is at/after
 * this ms timestamp. Set once when first enabling delivery so devices still on
 * a pre-display service worker are not sent silent Push (Safari revoke).
 */
export function pushDeliverySinceMs() {
  const raw = process.env.PUSH_DELIVERY_SINCE_MS?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isSubscriptionEligibleForPushDelivery(lastSeenAt: number) {
  const since = pushDeliverySinceMs();
  return since === null || lastSeenAt >= since;
}
