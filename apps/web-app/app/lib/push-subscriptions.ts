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
  // iOS Safari tabs lack Push APIs until installed — check before capability probe.
  if (isIosDevice() && !isInstalledWebApp()) {
    return "needs_install" as const;
  }
  if (!hasPushApis()) {
    return "unsupported" as const;
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
  try {
    return await navigator.serviceWorker.register(PUSH_SERVICE_WORKER_URL);
  } catch {
    return null;
  }
}

/**
 * Prefer an existing registration over `ready` (which can hang forever when
 * registration never succeeds). Never log endpoints.
 */
async function resolvePushRegistration() {
  if (!hasPushApis()) {
    return null;
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration(PUSH_SERVICE_WORKER_URL);
    if (existing) {
      return existing;
    }
  } catch {
    // getRegistration can throw in locked-down contexts.
  }
  return await registerPushServiceWorker();
}

export async function getCurrentPushSubscription() {
  const registration = await resolvePushRegistration();
  if (!registration) {
    return null;
  }
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

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function applicationServerKeyMatches(subscription: PushSubscription, publicKey: string) {
  const existing = subscription.options.applicationServerKey;
  if (existing == null) {
    return false;
  }
  const actual =
    existing instanceof ArrayBuffer ? new Uint8Array(existing) : new Uint8Array(existing);
  return uint8ArraysEqual(actual, urlBase64ToUint8Array(publicKey));
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

async function subscribeWithVapid(
  registration: ServiceWorkerRegistration,
  vapid: { publicKey: string; keyId: string },
) {
  const existing = await registration.pushManager.getSubscription();
  if (existing && applicationServerKeyMatches(existing, vapid.publicKey)) {
    return existing;
  }
  if (existing) {
    await existing.unsubscribe();
  }
  return await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
  });
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
  const registration = await resolvePushRegistration();
  if (!registration) {
    throw new Error("Push service worker is not available");
  }
  const subscription = await subscribeWithVapid(registration, vapid);
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

/**
 * Startup/focus material. If the browser sub is bound to a different VAPID
 * public key (rotation), unsubscribe and return null so the User must re-enable.
 */
export async function readPushSubscriptionMaterial(vapid: { publicKey: string; keyId: string }) {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return null;
  }
  if (!applicationServerKeyMatches(subscription, vapid.publicKey)) {
    try {
      await subscription.unsubscribe();
    } catch {
      // Fall through to null — reconcile must not relabel with the new keyId.
    }
    return null;
  }
  return { ...readSubscriptionKeys(subscription), vapidKeyId: vapid.keyId };
}

/**
 * Sign-out / disable helper: unsubscribe locally then remove User binding.
 * Failures must not block sign-out. Server unbind runs even when local
 * unsubscribe rejects (endpoint already known). Never logs endpoint material.
 */
export async function clearLocalPushSubscriptionAndBinding(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  try {
    const subscription = await getCurrentPushSubscription();
    if (!subscription) {
      return;
    }
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch {
      // Still clear the server binding below.
    }
    try {
      await disable({ endpoint });
    } catch {
      // Binding clear is best-effort; local path already attempted.
    }
  } catch {
    // Never block sign-out on Push cleanup.
  }
}
