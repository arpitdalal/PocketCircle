/**
 * Per-device Push subscription lifecycle (#381). Browser APIs only — Convex
 * mutations live in `~/lib/data/push-subscriptions.ts`. Never log endpoints.
 */
import { isInstalledWebApp, isIosDevice } from "~/components/pwa-install.js";
import { MOCKS } from "~/lib/env.js";

export const PUSH_SERVICE_WORKER_URL = "/push-sw.js";

export type PushNotificationsUiState =
  | "unsupported"
  | "needs_install"
  | "blocked"
  | "default"
  | "enabled";

export type PushSubscriptionMaterial = {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId: string;
};

function hasSecureContext() {
  return typeof window !== "undefined" && window.isSecureContext;
}

function hasPushApis() {
  return (
    hasSecureContext() &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Sync capability for Settings (subscription presence is async). */
export function resolvePushNotificationsCapability() {
  if (!hasPushApis()) {
    return "unsupported" as const;
  }
  if (isIosDevice() && !isInstalledWebApp()) {
    return "needs_install" as const;
  }
  if (Notification.permission === "denied") {
    return "blocked" as const;
  }
  return "default" as const;
}

export async function resolvePushNotificationsUiState() {
  const capability = resolvePushNotificationsCapability();
  if (capability !== "default") {
    return capability;
  }
  const sub = await getCurrentPushSubscription();
  return sub ? ("enabled" as const) : ("default" as const);
}

/** Register Push SW outside mock env (MSW owns the root scope under MOCKS). */
export function canRegisterPushServiceWorker(mocks = MOCKS) {
  return !mocks && typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export async function registerPushServiceWorker() {
  if (!canRegisterPushServiceWorker()) {
    return null;
  }
  return await navigator.serviceWorker.register(PUSH_SERVICE_WORKER_URL);
}

export async function getCurrentPushSubscription() {
  if (!hasPushApis()) {
    return null;
  }
  const registration = await navigator.serviceWorker.ready;
  return await registration.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function readSubscriptionKeys(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) {
    throw new Error("Push subscription missing encryption keys");
  }
  return { endpoint: subscription.endpoint, p256dh, auth };
}

/**
 * Explicit User action only — requests permission, subscribes, returns material
 * for the enable mutation. Never call on load.
 */
export async function subscribeForPushNotifications(vapid: { publicKey: string; keyId: string }) {
  if (!hasPushApis()) {
    throw new Error("Push notifications are not supported");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted");
  }
  await registerPushServiceWorker();
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
    }));
  const keys = readSubscriptionKeys(subscription);
  return { ...keys, vapidKeyId: vapid.keyId };
}

/** Local unsubscribe; caller persists disable via mutation. */
export async function unsubscribeLocalPushSubscription() {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return null;
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

export async function readPushSubscriptionMaterial(vapidKeyId: string) {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return null;
  }
  return { ...readSubscriptionKeys(subscription), vapidKeyId };
}

/**
 * Sign-out / disable helper: unsubscribe locally then remove User binding.
 * Failures must not block sign-out. Never logs endpoint material.
 */
export async function clearLocalPushSubscriptionAndBinding(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  try {
    const endpoint = await unsubscribeLocalPushSubscription();
    if (!endpoint) {
      return;
    }
    try {
      await disable({ endpoint });
    } catch {
      // Binding clear is best-effort; local unsubscribe already happened.
    }
  } catch {
    // Never block sign-out on Push cleanup.
  }
}
