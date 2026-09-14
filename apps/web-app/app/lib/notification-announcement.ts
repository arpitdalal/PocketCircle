/**
 * One-time notification announcement strip (#383). Per-device dismiss only —
 * Settings remains the retry path. Visibility is enableable Push only.
 */
import type { PushNotificationsUiState } from "~/lib/push-subscriptions.js";

export const NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY =
  "pocketcircle.notificationAnnouncementDismissed";

const IMPRESSION_KEY = "pocketcircle.notificationAnnouncementImpression";

/** Survives blocked Web Storage for the JS realm (private mode / ITP). */
let dismissedMemory = false;
let impressionMemory = false;

const dismissListeners = new Set<() => void>();
let detachStorageListener: (() => void) | null = null;

function emitDismissChange() {
  for (const listener of dismissListeners) {
    listener();
  }
}

function ensureDismissStorageListener() {
  if (detachStorageListener != null || typeof window === "undefined") {
    return;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY || event.newValue !== "1") {
      return;
    }
    dismissedMemory = true;
    emitDismissChange();
  };
  window.addEventListener("storage", onStorage);
  detachStorageListener = () => {
    window.removeEventListener("storage", onStorage);
  };
}

/** Test isolation for module-local dismiss / impression fallbacks. */
export function resetNotificationAnnouncementMemory() {
  dismissedMemory = false;
  impressionMemory = false;
  emitDismissChange();
}

export function readNotificationAnnouncementDismissed() {
  if (dismissedMemory) {
    return true;
  }
  try {
    return window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNotificationAnnouncementDismissed() {
  dismissedMemory = true;
  try {
    window.localStorage.setItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY, "1");
  } catch {
    // Memory flag still suppresses for this realm.
  }
  emitDismissChange();
}

/** Cross-tab + same-tab dismiss via `useSyncExternalStore`. */
export function subscribeNotificationAnnouncementDismissed(onStoreChange: () => void) {
  ensureDismissStorageListener();
  dismissListeners.add(onStoreChange);
  return () => {
    dismissListeners.delete(onStoreChange);
    if (dismissListeners.size === 0 && detachStorageListener != null) {
      detachStorageListener();
      detachStorageListener = null;
    }
  };
}

export function hasRecordedNotificationAnnouncementImpression() {
  if (impressionMemory) {
    return true;
  }
  try {
    return window.sessionStorage.getItem(IMPRESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function markNotificationAnnouncementImpressionRecorded() {
  impressionMemory = true;
  try {
    window.sessionStorage.setItem(IMPRESSION_KEY, "1");
  } catch {
    // Memory flag still de-dupes for this realm.
  }
}

/**
 * Uninstalled iPhone/iPad after soft install dismiss — strip is unusable in
 * the browser tab; standalone apps are a separate surface.
 */
export function isIosInstallPrerequisiteDismissed(args: {
  isIos: boolean;
  installed: boolean;
  installAvailable: boolean;
  showInstallPrompt: boolean;
}) {
  return args.isIos && !args.installed && args.installAvailable && !args.showInstallPrompt;
}

/** Device already opted into Push — never re-announce after they later disable. */
export function shouldSuppressNotificationAnnouncementForUiState(
  uiState: PushNotificationsUiState | null,
) {
  return (
    uiState === "enabled" || uiState === "needs_migration" || uiState === "needs_remigrate_finish"
  );
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
  if (shouldSuppressNotificationAnnouncementForUiState(args.uiState)) {
    return false;
  }
  return args.uiState === "default";
}
