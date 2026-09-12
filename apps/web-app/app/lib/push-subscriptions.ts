/**
 * Per-device Push subscription lifecycle (#381). Browser APIs only — Convex
 * mutations live in `~/lib/data/push-subscriptions.ts`. Never log endpoints.
 */
import { isInstalledWebApp, isIosDevice } from "~/components/pwa-install.js";
import { track } from "~/lib/analytics.js";
import { MOCKS } from "~/lib/env.js";

export const PUSH_SERVICE_WORKER_URL = "/push-sw.js";

/** Last-known endpoint for sign-out cleanup when `getSubscription()` fails. */
const LAST_PUSH_ENDPOINT_KEY = "pocketcircle.lastPushEndpoint";

/** Fired when lifecycle drops/changes the local subscription so Settings can refresh. */
export const PUSH_SUBSCRIPTION_CHANGED_EVENT = "pocketcircle:push-subscription-changed";

export function notifyPushSubscriptionChanged() {
  try {
    window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_CHANGED_EVENT));
  } catch {
    // Non-browser / restricted — Settings will refresh on next focus.
  }
}

export function rememberPushEndpoint(endpoint: string | null) {
  try {
    if (endpoint) {
      window.localStorage.setItem(LAST_PUSH_ENDPOINT_KEY, endpoint);
    } else {
      window.localStorage.removeItem(LAST_PUSH_ENDPOINT_KEY);
    }
  } catch {
    // Private mode / blocked storage — cleanup may fall back to live lookup only.
  }
}

export function recalledPushEndpoint() {
  try {
    return window.localStorage.getItem(LAST_PUSH_ENDPOINT_KEY);
  } catch {
    return null;
  }
}

/** True while Settings enable is mid-flight — lifecycle must not orphan the new sub. */
let pushEnableInFlight = 0;

export function beginPushEnable() {
  pushEnableInFlight += 1;
}

export function endPushEnable() {
  pushEnableInFlight = Math.max(0, pushEnableInFlight - 1);
}

export function isPushEnableInFlight() {
  return pushEnableInFlight > 0;
}

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
  // Web Push requires iOS/iPadOS 16.4+; older versions stay unsupported.
  if (isIosDevice() && !isInstalledWebApp()) {
    return iosSupportsWebPush() ? ("needs_install" as const) : ("unsupported" as const);
  }
  if (!hasPushApis()) {
    return "unsupported" as const;
  }
  if (Notification.permission === "denied") {
    return "blocked" as const;
  }
  return "default" as const;
}

/**
 * iOS/iPadOS 16.4+ supports Web Push in Home Screen apps. Desktop-class iPad
 * Safari exposes `Version/X.Y` (maps to OS); without any version signal we do
 * not promise Push.
 */
export function iosSupportsWebPush(userAgent = navigator.userAgent) {
  const version = iosVersionFromUserAgent(userAgent);
  if (!version) {
    return false;
  }
  return version.major > 16 || (version.major === 16 && version.minor >= 4);
}

export function iosVersionFromUserAgent(userAgent: string) {
  const mobile =
    /(?:iPhone|iPad|iPod).*?OS (\d+)_(\d+)/i.exec(userAgent) ??
    /CPU(?: iPhone)? OS (\d+)_(\d+)/i.exec(userAgent);
  if (mobile?.[1] && mobile[2]) {
    return { major: Number(mobile[1]), minor: Number(mobile[2]) };
  }
  // Desktop-class iPadOS: Mac-like UA with Safari Version/X.Y ≈ OS major.minor.
  const safari = /Version\/(\d+)\.(\d+)/i.exec(userAgent);
  if (safari?.[1] && safari[2] && /Macintosh|Mac OS X/i.test(userAgent)) {
    return { major: Number(safari[1]), minor: Number(safari[2]) };
  }
  return null;
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
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
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

/** Test/fixture helper — same decoder production uses for VAPID public keys. */
export function vapidPublicKeyBytes(publicKey: string) {
  return urlBase64ToUint8Array(publicKey);
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
  track("notification_permission_result", { result: permission });
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted");
  }
  const registration = await resolvePushRegistration();
  if (!registration) {
    throw new Error("Push service worker is not available");
  }
  const subscription = await subscribeWithVapid(registration, vapid);
  const keys = readSubscriptionKeys(subscription);
  rememberPushEndpoint(keys.endpoint);
  return { ...keys, vapidKeyId: vapid.keyId };
}

/**
 * Local unsubscribe; caller persists disable via mutation. When
 * `expectedEndpoint` is set, only unsubscribes if it still matches — avoids
 * racing a newer subscription from a stale reconcile.
 */
export async function unsubscribeLocalPushSubscription(expectedEndpoint?: string) {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return recalledPushEndpoint();
  }
  if (expectedEndpoint && subscription.endpoint !== expectedEndpoint) {
    return null;
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

/**
 * Startup/focus material for reconcile. VAPID key mismatch: unsubscribe locally
 * and report `unboundEndpoint` for best-effort server cleanup — does not
 * resubscribe (explicit Settings enable required; avoids cross-User auto-bind).
 * Same-key endpoint change vs last remembered endpoint → `previousEndpoint`
 * for owned migration via replacePushSubscription.
 */
export async function readPushSubscriptionMaterial(vapid: { publicKey: string; keyId: string }) {
  const registration = await resolvePushRegistration();
  if (!registration) {
    return { subscription: null };
  }
  let existing: PushSubscription | null = null;
  try {
    existing = await registration.pushManager.getSubscription();
  } catch {
    return { subscription: null };
  }
  if (!existing) {
    return { subscription: null };
  }
  if (!applicationServerKeyMatches(existing, vapid.publicKey)) {
    const unboundEndpoint = existing.endpoint;
    try {
      await existing.unsubscribe();
    } catch {
      // Still report unboundEndpoint for server cleanup.
    }
    return { subscription: null, unboundEndpoint };
  }

  const material = {
    ...readSubscriptionKeys(existing),
    vapidKeyId: vapid.keyId,
  };
  const previousEndpoint = recalledPushEndpoint();
  if (previousEndpoint && previousEndpoint !== material.endpoint) {
    // Keep previous remembered until replace succeeds — otherwise a failed
    // replace forgets the owned old endpoint and cannot retry migration.
    return { subscription: material, previousEndpoint };
  }
  rememberPushEndpoint(material.endpoint);
  return { subscription: material };
}

/**
 * Sign-out helper: unsubscribe locally then remove User binding. Failures must
 * not block sign-out. If live `getSubscription()` fails, falls back to the last
 * remembered endpoint so server unbind still runs. Never logs endpoint material.
 */
export async function clearLocalPushSubscriptionAndBinding(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  try {
    await disableCurrentPushSubscription(disable);
  } catch {
    // Never block sign-out on Push cleanup.
  }
}

/**
 * Settings disable: same steps as sign-out cleanup, but surfaces server unbind
 * failures so the UI can retry instead of claiming success with a live binding.
 * Unbinds both the live subscription and any distinct remembered endpoint —
 * browser refresh can leave the server on A while the live sub is already B.
 */
export async function disableCurrentPushSubscription(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  let subscription: PushSubscription | null = null;
  try {
    const registration = await resolvePushRegistration();
    if (registration) {
      subscription = await registration.pushManager.getSubscription();
    }
  } catch {
    // Transient lookup failure — fall back to remembered endpoint below.
  }
  const liveEndpoint = subscription?.endpoint ?? null;
  const rememberedEndpoint = recalledPushEndpoint();
  const endpoints = [
    ...new Set([liveEndpoint, rememberedEndpoint].filter((value) => value !== null)),
  ];
  if (endpoints.length === 0) {
    return;
  }
  let unsubscribeFailed = false;
  if (subscription) {
    try {
      await subscription.unsubscribe();
    } catch {
      // Still clear server bindings below; retry local cleanup after success.
      unsubscribeFailed = true;
    }
  }
  const failures: { endpoint: string; error: unknown }[] = [];
  for (const endpoint of endpoints) {
    try {
      await disable({ endpoint });
    } catch (error) {
      failures.push({ endpoint, error });
    }
  }
  if (failures.length === 0) {
    rememberPushEndpoint(null);
    if (unsubscribeFailed) {
      const lingering = await getCurrentPushSubscription();
      if (lingering) {
        // Server unbound but browser sub remains — surface so Settings does
        // not claim disabled while still showing enabled.
        await lingering.unsubscribe();
      }
    }
    return;
  }
  // Keep a failed endpoint remembered so Settings can retry unbind.
  rememberPushEndpoint(failures[0]?.endpoint ?? null);
  throw failures[0]?.error;
}
