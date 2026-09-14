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
 * Delivery eligibility for Safari-safe Push.
 * Always require a probed display-capable push-sw version — parent-release tabs
 * can bump `lastSeenAt` without a visible push handler. Optional SINCE is an
 * additional recency floor after the display-SW rollout.
 */
export function isSubscriptionEligibleForPushDelivery(args: {
  lastSeenAt: number;
  pushSwVersion?: number;
}) {
  if ((args.pushSwVersion ?? 0) < PUSH_DISPLAY_SW_VERSION) {
    return false;
  }
  const since = pushDeliverySinceMs();
  return since === null || args.lastSeenAt >= since;
}
