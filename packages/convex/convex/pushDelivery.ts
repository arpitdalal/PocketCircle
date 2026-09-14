/**
 * Shared Push delivery rollout gates (ADR 0033 / #382).
 * Kept free of Workpool / Node imports so isolate + Node send can both use it.
 */

import { PUSH_DISPLAY_SW_VERSION } from "@pocketcircle/domain";

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

/**
 * Delivery eligibility after the display-SW rollout floor.
 * Recency alone is insufficient: a cached parent-release tab can still bump
 * `lastSeenAt` without a visible push handler. Require a probed SW version too.
 */
export function isSubscriptionEligibleForPushDelivery(args: {
  lastSeenAt: number;
  pushSwVersion?: number;
}) {
  const since = pushDeliverySinceMs();
  if (since === null) {
    return true;
  }
  if ((args.pushSwVersion ?? 0) < PUSH_DISPLAY_SW_VERSION) {
    return false;
  }
  return args.lastSeenAt >= since;
}
