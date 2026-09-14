/**
 * One-time notification announcement strip (#383). Per-device dismiss only —
 * Settings remains the retry path. Visibility is enableable Push only.
 */
import type { PushNotificationsUiState } from "~/lib/push-subscriptions.js";

export const NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY =
  "pocketcircle.notificationAnnouncementDismissed";

const IMPRESSION_KEY = "pocketcircle.notificationAnnouncementImpression";

export function readNotificationAnnouncementDismissed() {
  try {
    return window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNotificationAnnouncementDismissed() {
  try {
    window.localStorage.setItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY, "1");
  } catch {
    // Private mode / blocked storage — strip may reappear until storage works.
  }
}

export function hasRecordedNotificationAnnouncementImpression() {
  try {
    return window.sessionStorage.getItem(IMPRESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function markNotificationAnnouncementImpressionRecorded() {
  try {
    window.sessionStorage.setItem(IMPRESSION_KEY, "1");
  } catch {
    // Best-effort; analytics remain optional.
  }
}

/**
 * Show only when Enable can succeed on this surface. iOS browser-tab after
 * install-prompt dismiss stays hidden even if Push APIs later appear.
 */
export function isNotificationAnnouncementVisible(args: {
  dismissed: boolean;
  /** Resolved Push UI state; null while still probing. */
  uiState: PushNotificationsUiState | null;
  /** Decodable VAPID public key present (Settings enableable). */
  vapidUsable: boolean;
  /**
   * Uninstalled iPhone/iPad where the soft install dialog was dismissed —
   * strip is unusable there; installed app uses its own storage / state.
   */
  iosInstallPrerequisiteDismissed: boolean;
}) {
  if (args.dismissed || args.iosInstallPrerequisiteDismissed) {
    return false;
  }
  if (!args.vapidUsable || args.uiState === null) {
    return false;
  }
  return args.uiState === "default";
}
