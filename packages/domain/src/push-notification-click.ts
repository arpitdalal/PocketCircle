/**
 * Push notification click protocol (#384).
 * Carries Notification identity only — never a trusted destination URL.
 */

import { parseNotificationLinkPath } from "./notification-links.js";
import type { IdValidator } from "./ref.js";

/** Protected deep-link that re-resolves after auth. */
export const PUSH_NOTIFICATION_CLICK_PATH = "/from-notification";

/** Query param holding the Notification Center row id. */
export const PUSH_NOTIFICATION_CLICK_PARAM = "n";

/** Service-worker → page message when `WindowClient.navigate` is unavailable. */
export const PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE = "pocketcircle:push-notification-click";

/** Convex document ids are opaque alphanumeric strings. */
const NOTIFICATION_ID_PATTERN = /^[a-z0-9]+$/i;
const MAX_NOTIFICATION_ID_LENGTH = 128;

/** Accept only same-origin Notification identity strings for deep links / messages. */
export function parsePushNotificationId(raw: string | null | undefined) {
  if (raw == null || raw.length === 0 || raw.length > MAX_NOTIFICATION_ID_LENGTH) {
    return null;
  }
  if (!NOTIFICATION_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}

/** Same-origin path the SW opens or navigates to after a Push click. */
export function buildPushNotificationClickPath(notificationId: string) {
  const id = parsePushNotificationId(notificationId);
  if (!id) {
    return "/";
  }
  const params = new URLSearchParams();
  params.set(PUSH_NOTIFICATION_CLICK_PARAM, id);
  return `${PUSH_NOTIFICATION_CLICK_PATH}?${params.toString()}`;
}

/** Read Notification identity from `/from-notification?n=…`. */
export function parsePushNotificationClickSearch(search: string | URLSearchParams) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return parsePushNotificationId(params.get(PUSH_NOTIFICATION_CLICK_PARAM));
}

export type PushNotificationClickMessage = {
  type: typeof PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE;
  notificationId: string;
};

/** Narrow a service-worker postMessage payload to a Push click identity. */
export function parsePushNotificationClickMessage(
  data: unknown,
): PushNotificationClickMessage | null {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (!("type" in data) || data.type !== PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE) {
    return null;
  }
  if (!("notificationId" in data) || typeof data.notificationId !== "string") {
    return null;
  }
  const notificationId = parsePushNotificationId(data.notificationId);
  if (!notificationId) {
    return null;
  }
  return { type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE, notificationId };
}

/**
 * Client-side gate before `navigate()` of a server-resolved Push destination.
 * Only canonical Notification Center link shapes (ADR 0016 / NTF-1).
 */
export function isSafePushResolvedPath(path: string, isValidId: IdValidator) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return false;
  }
  return parseNotificationLinkPath(path, isValidId) != null;
}

/** Whether a returnTo target is the Push click deep-link (sign-in continuation). */
export function isPushNotificationClickReturnTo(raw: string) {
  if (raw === PUSH_NOTIFICATION_CLICK_PATH) {
    return true;
  }
  if (!raw.startsWith(`${PUSH_NOTIFICATION_CLICK_PATH}?`)) {
    return false;
  }
  const query = raw.slice(PUSH_NOTIFICATION_CLICK_PATH.length + 1);
  const params = new URLSearchParams(query);
  // Only the Notification identity param — reject open-redirect smuggling.
  for (const key of params.keys()) {
    if (key !== PUSH_NOTIFICATION_CLICK_PARAM) {
      return false;
    }
  }
  return parsePushNotificationId(params.get(PUSH_NOTIFICATION_CLICK_PARAM)) != null;
}
