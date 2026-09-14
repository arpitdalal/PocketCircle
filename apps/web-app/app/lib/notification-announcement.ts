/**
 * One-time notification announcement strip (#383). Per-device dismiss only —
 * Settings remains the retry path. Visibility is enableable Push only.
 */
import { isAnalyticsCaptureDeferred, track } from "~/lib/analytics.js";
import type { PushNotificationsUiState } from "~/lib/push-subscriptions.js";

export const NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY =
  "pocketcircle.notificationAnnouncementDismissed";

const IMPRESSION_KEY_PREFIX = "pocketcircle.notificationAnnouncementImpression:";

/** Survives blocked Web Storage for the JS realm (private mode / ITP). */
let dismissedMemory = false;
let impressionMemoryUserId: string | null = null;
let impressionMemory = false;
/** Dismiss analytics queued until capture is ready (cold-load race only). */
let pendingDismissTrackUserId: string | null = null;

const dismissListeners = new Set<() => void>();
let detachStorageListener: (() => void) | null = null;

function impressionStorageKey(userId: string) {
  return `${IMPRESSION_KEY_PREFIX}${userId}`;
}

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
  impressionMemoryUserId = null;
  pendingDismissTrackUserId = null;
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
    // ponytail: blocked/quota storage → realm-only suppress until reload.
    // Upgrade: durable server-side announcement ack if private-mode durability matters.
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

export function hasRecordedNotificationAnnouncementImpression(userId: string) {
  if (impressionMemoryUserId === userId && impressionMemory) {
    return true;
  }
  try {
    return window.sessionStorage.getItem(impressionStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function markNotificationAnnouncementImpressionRecorded(userId: string) {
  impressionMemoryUserId = userId;
  impressionMemory = true;
  try {
    window.sessionStorage.setItem(impressionStorageKey(userId), "1");
  } catch {
    // Memory flag still de-dupes for this realm.
  }
}

/**
 * Capture dismiss analytics, or queue only while capture is deferred (cold load).
 * Opt-out / unavailable → no queue (must not flush after a later opt-in).
 */
export function trackNotificationAnnouncementDismissed(userId: string) {
  if (track("notification_announcement_dismissed", {})) {
    pendingDismissTrackUserId = null;
    return true;
  }
  if (isAnalyticsCaptureDeferred()) {
    pendingDismissTrackUserId = userId;
  } else {
    pendingDismissTrackUserId = null;
  }
  return false;
}

/** Flush a dismiss event queued before analytics initialized for this user. */
export function flushPendingNotificationAnnouncementDismissTrack(userId: string) {
  if (pendingDismissTrackUserId !== userId) {
    return;
  }
  if (track("notification_announcement_dismissed", {})) {
    pendingDismissTrackUserId = null;
    return;
  }
  // Still deferred → keep; opted out / unavailable → drop.
  if (!isAnalyticsCaptureDeferred()) {
    pendingDismissTrackUserId = null;
  }
}

/**
 * Strip owns the notch inset while it still covers the viewport top edge.
 * `top <= 0.5` alone stays true after the strip scrolls fully away (top ≪ 0).
 */
export function stripOwnsTopSafeArea(rect: { top: number; bottom: number }) {
  return rect.top <= 0.5 && rect.bottom > 0;
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
