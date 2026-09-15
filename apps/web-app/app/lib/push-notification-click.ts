/**
 * Push click → authenticated live destination (#384).
 * SW carries Notification identity only; this module resolves after auth.
 */
import {
  buildPushNotificationClickPath,
  isSafePushResolvedPath,
  parsePushNotificationClickMessage,
} from "@pocketcircle/domain";
import { track } from "~/lib/analytics.js";
import { requestNotificationCenterFocus } from "~/lib/notification-center-focus.js";
import { isConvexId } from "~/lib/refs.js";

export type PushClickResolveResult =
  | { outcome: "navigate"; path: string; notificationId: string }
  | { outcome: "notification_center"; notificationId: string }
  | { outcome: "unavailable" };

/**
 * Apply a successful Push click resolution: navigate, or open NC at the row.
 * Marks the NC row read and fires coarse `notification_opened` only after the
 * client successfully applies the destination (failures leave unread).
 */
export async function applyPushNotificationClickResult(
  result: PushClickResolveResult,
  navigate: (to: string, opts?: { replace?: boolean }) => void | Promise<void>,
  markRead: (notificationId: string) => Promise<void>,
) {
  if (result.outcome === "unavailable") {
    await navigate("/", { replace: true });
    return;
  }

  if (result.outcome === "navigate") {
    if (!isSafePushResolvedPath(result.path, isConvexId)) {
      // Treat unsafe path as apply failure — do not mark read.
      await navigate("/", { replace: true });
      return;
    }
    await navigate(result.path, { replace: true });
    await markReadBestEffort(markRead, result.notificationId);
    track("notification_opened", {});
    return;
  }

  requestNotificationCenterFocus(result.notificationId);
  await navigate("/", { replace: true });
  await markReadBestEffort(markRead, result.notificationId);
  track("notification_opened", {});
}

async function markReadBestEffort(
  markRead: (notificationId: string) => Promise<void>,
  notificationId: string,
) {
  try {
    await markRead(notificationId);
  } catch {
    // Destination already applied; unread drain can retry via NC.
  }
}

/** Handle a service-worker postMessage fallback (no WindowClient.navigate). */
export function handlePushNotificationClickMessage(
  data: unknown,
  navigate: (to: string, opts?: { replace?: boolean }) => void | Promise<void>,
) {
  const message = parsePushNotificationClickMessage(data);
  if (!message) {
    return false;
  }
  void navigate(buildPushNotificationClickPath(message.notificationId), { replace: true });
  return true;
}
