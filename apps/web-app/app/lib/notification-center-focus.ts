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

/** Consume the pending focus request (epoch advances so the same id can re-focus). */
export function takeNotificationCenterFocusRequest() {
  const notificationId = focusNotificationId;
  const epoch = focusEpoch;
  focusNotificationId = null;
  return { notificationId, epoch };
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

/** Test isolation. */
export function resetNotificationCenterFocus() {
  focusNotificationId = null;
  focusEpoch = 0;
  emit();
}

/** Subscribe to Push-driven Notification Center focus requests. */
export function useNotificationCenterFocusEpoch() {
  return useSyncExternalStore(subscribeNotificationCenterFocus, getFocusEpoch, () => 0);
}
