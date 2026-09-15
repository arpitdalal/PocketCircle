/**
 * Open the Notification Center tray focused on a Push-resolved row (#384).
 * Identity stays in memory — not analytics, not a trusted navigation URL.
 */
import { useSyncExternalStore } from "react";

let focusNotificationId: string | null = null;
let focusEpoch = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Request the tray open on All, scrolled to this Notification Center row. */
export function requestNotificationCenterFocus(notificationId: string | undefined) {
  focusNotificationId = notificationId ?? null;
  focusEpoch += 1;
  emit();
}

/** Clear a consumed / abandoned Push focus request. */
export function clearNotificationCenterFocus() {
  if (focusNotificationId === null) {
    return;
  }
  focusNotificationId = null;
  focusEpoch += 1;
  emit();
}

export function subscribeNotificationCenterFocus(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getFocusEpoch() {
  return focusEpoch;
}

/** Sync peek for tests / apply helpers. */
export function peekNotificationCenterFocusId() {
  return focusNotificationId;
}

/** Test isolation. */
export function resetNotificationCenterFocus() {
  focusNotificationId = null;
  focusEpoch = 0;
  emit();
}

/**
 * Pending Push focus row id (null when none).
 * Subscribes via epoch so re-requesting the same id still re-renders.
 */
export function useNotificationCenterFocusId() {
  useSyncExternalStore(subscribeNotificationCenterFocus, getFocusEpoch, () => 0);
  return focusNotificationId;
}
