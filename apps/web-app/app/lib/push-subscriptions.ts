/**
 * Per-device Push subscription lifecycle (#381). Browser APIs only — Convex
 * mutations live in `~/lib/data/push-subscriptions.ts`. Never log endpoints.
 */
import { PUSH_DISPLAY_SW_VERSION, tryDecodeVapidKeyBytes } from "@pocketcircle/domain";
import { isInstalledWebApp, isIosDevice } from "~/components/pwa-install.js";
import { track } from "~/lib/analytics.js";
import { deferredValue } from "~/lib/deferred.js";
import { MOCKS } from "~/lib/env.js";

/** Hold through every browser/server side effect, including failed-operation cleanup. */
export async function withPushSubscriptionLock<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; wait?: boolean } = {},
) {
  if (!("locks" in navigator)) {
    throw new Error("Push coordination is unavailable in this browser");
  }
  const lockOptions = options.wait ? { signal: options.signal } : { ifAvailable: true };
  return navigator.locks.request("pocketcircle.push-subscription", lockOptions, async (lock) => {
    if (!lock) {
      throw new Error("Notifications are being updated in another tab. Please try again.");
    }
    return operation();
  });
}

export const PUSH_SERVICE_WORKER_URL = "/push-sw.js";

/**
 * Active device endpoint (single). Separate from pending cleanup so a re-enable
 * cannot wipe failed server-unbind retries that still consume the 10-device cap.
 */
const LAST_PUSH_ENDPOINT_KEY = "pocketcircle.lastPushEndpoint";
/** Endpoints whose server disable failed — retried on focus / next disable. */
const PENDING_PUSH_CLEANUP_KEY = "pocketcircle.pendingPushCleanup";

/** Fired when lifecycle drops/changes the local subscription so Settings can refresh. */
export const PUSH_SUBSCRIPTION_CHANGED_EVENT = "pocketcircle:push-subscription-changed";

export function notifyPushSubscriptionChanged() {
  try {
    window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_CHANGED_EVENT));
  } catch {
    // Non-browser / restricted — Settings will refresh on next focus.
  }
}

function readEndpointList(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    if (raw.startsWith("[")) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        window.localStorage.removeItem(key);
        return [];
      }
      return [
        ...new Set(
          parsed.filter((value): value is string => typeof value === "string" && value.length > 0),
        ),
      ];
    }
    return raw.length > 0 ? [raw] : [];
  } catch {
    return [];
  }
}

const PENDING_PUSH_CLEANUP_PREFIX = `${PENDING_PUSH_CLEANUP_KEY}.`;

/** Add independently keyed retry records; adding one never overwrites another. */
export function rememberPushEndpoints(endpoints: readonly string[]) {
  let persisted = true;
  for (const endpoint of endpoints) {
    if (!endpoint) continue;
    try {
      window.localStorage.setItem(`${PENDING_PUSH_CLEANUP_PREFIX}${endpoint}`, endpoint);
    } catch {
      // Storage can be unavailable; live subscription cleanup still works.
      persisted = false;
    }
  }
  return persisted;
}

export function applyPendingCleanupFlushResult(
  attempted: readonly string[],
  failures: readonly string[],
) {
  // Migrate before removing confirmed successes. Production callers hold the browser lock.
  recalledPendingPushCleanup();
  const failed = new Set(failures);
  for (const endpoint of attempted) {
    if (failed.has(endpoint)) continue;
    try {
      window.localStorage.removeItem(`${PENDING_PUSH_CLEANUP_PREFIX}${endpoint}`);
    } catch {
      // Keep retry state if storage is inaccessible.
    }
  }
  rememberPushEndpoints(failures);
}

/** Active endpoint only — leaves other pending cleanup intact across re-enable. */
export function rememberPushEndpoint(endpoint: string | null) {
  try {
    if (!endpoint) {
      window.localStorage.removeItem(LAST_PUSH_ENDPOINT_KEY);
      return;
    }
    // Legacy: array in the active key was multi-endpoint storage — migrate out.
    const legacy = window.localStorage.getItem(LAST_PUSH_ENDPOINT_KEY);
    let pending = recalledPendingPushCleanup();
    if (legacy && legacy !== endpoint) {
      const migrated = readEndpointList(LAST_PUSH_ENDPOINT_KEY).filter(
        (value) => value !== endpoint,
      );
      pending = [...pending, ...migrated];
    }
    // Active again — drop this endpoint from pending so cleanup cannot unbind it.
    rememberPushEndpoints(pending.filter((value) => value !== endpoint));
    applyPendingCleanupFlushResult([endpoint], []);
    window.localStorage.setItem(LAST_PUSH_ENDPOINT_KEY, endpoint);
  } catch {
    // Private mode / blocked storage.
  }
}

/** Failed server-unbind retries only (excludes the active endpoint key). */
export function recalledPendingPushCleanup() {
  const endpoints = readEndpointList(PENDING_PUSH_CLEANUP_KEY);
  const migrated = rememberPushEndpoints(endpoints);
  try {
    if (migrated) window.localStorage.removeItem(PENDING_PUSH_CLEANUP_KEY);
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PENDING_PUSH_CLEANUP_PREFIX)) {
        const endpoint = window.localStorage.getItem(key);
        if (endpoint) endpoints.push(endpoint);
      }
    }
  } catch {
    // Restricted storage.
  }
  return [...new Set(endpoints)];
}

/**
 * Local orphan drop after reconcile `{ bound: false }`: clear active remember but
 * keep the endpoint as pending cleanup so a foreign owner's server row still has
 * a retry handle on this device (account switch / timed-out sign-out).
 */
export function recordOrphanLocalDrop(endpoint: string) {
  rememberPushEndpoint(null);
  rememberPushEndpoints([
    ...recalledPendingPushCleanup().filter((value) => value !== endpoint),
    endpoint,
  ]);
}

export function clearRememberedPushEndpoints() {
  rememberPushEndpoint(null);
  applyPendingCleanupFlushResult(recalledPendingPushCleanup(), []);
}

export function recalledPushEndpoints() {
  try {
    const rawActive = window.localStorage.getItem(LAST_PUSH_ENDPOINT_KEY);
    let active: string[] = [];
    let pending = recalledPendingPushCleanup();
    if (rawActive?.startsWith("[")) {
      // Legacy multi-list lived in the active key — treat as pending.
      pending = [...new Set([...pending, ...readEndpointList(LAST_PUSH_ENDPOINT_KEY)])];
    } else if (rawActive) {
      active = [rawActive];
    }
    return [...new Set([...active, ...pending])];
  } catch {
    return [];
  }
}

/** Active endpoint only (not pending cleanup). */
export function recalledPushEndpoint() {
  try {
    const raw = window.localStorage.getItem(LAST_PUSH_ENDPOINT_KEY);
    if (!raw || raw.startsWith("[")) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

let pushEnableInFlight = 0;
let pushCancellationGeneration = 0;
const pushSignOutGuardHeartbeats = new Set<number>();

/** Sign-out sets this so an in-flight enable aborts before/after bind. */
let pushEnableCancelRequested = false;
/** True while sign-out Push cleanup runs — beginPushEnable must not clear cancel. */
let pushSignOutCleanupInProgress = 0;
/** Cross-tab: cancel + per-tab sign-out cleanup marks (other tabs must not clear cancel). */
const PUSH_CANCEL_GENERATION_KEY = "pocketcircle.pushCancelGeneration";
const PUSH_ENABLE_CANCEL_KEY = "pocketcircle.pushEnableCancel";
const PUSH_SIGNOUT_CLEANUP_PREFIX = "pocketcircle.pushSignOutCleanup.";
/** Crash recovery — stuck marks/cancel must not block enable forever. */
const PUSH_SIGNOUT_CLEANUP_TTL_MS = 60_000;

function sweepExpiredSignOutCleanupMarks() {
  try {
    const now = Date.now();
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(PUSH_SIGNOUT_CLEANUP_PREFIX)) {
        continue;
      }
      const at = Number(window.localStorage.getItem(key));
      if (!Number.isFinite(at) || now - at > PUSH_SIGNOUT_CLEANUP_TTL_MS) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

function isPushSignOutCleanupMarked() {
  sweepExpiredSignOutCleanupMarks();
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PUSH_SIGNOUT_CLEANUP_PREFIX)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** Cross-tab / in-tab coordination tokens — must not throw (sign-out path). */
function pushCoordinationToken() {
  try {
    return crypto.randomUUID();
  } catch {
    return `pc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function markPushSignOutCleanup() {
  const id = pushCoordinationToken();
  try {
    window.localStorage.setItem(`${PUSH_SIGNOUT_CLEANUP_PREFIX}${id}`, String(Date.now()));
  } catch {
    // ignore
  }
  return id;
}

function touchPushSignOutCleanup(id: string) {
  try {
    const key = `${PUSH_SIGNOUT_CLEANUP_PREFIX}${id}`;
    if (window.localStorage.getItem(key) == null) {
      return;
    }
    window.localStorage.setItem(key, String(Date.now()));
  } catch {
    // ignore
  }
}

function unmarkPushSignOutCleanup(id: string) {
  try {
    window.localStorage.removeItem(`${PUSH_SIGNOUT_CLEANUP_PREFIX}${id}`);
  } catch {
    // ignore
  }
}

/** Captures cancellation even if a later explicit enable clears the sign-out flag. */
export function capturePushCancellation() {
  const generation = pushCancellationGeneration;
  const read = () => {
    try {
      return window.localStorage.getItem(PUSH_CANCEL_GENERATION_KEY);
    } catch {
      return null;
    }
  };
  const sharedGeneration = read();
  return () => generation !== pushCancellationGeneration || sharedGeneration !== read();
}

export function requestPushEnableCancel() {
  pushCancellationGeneration += 1;
  try {
    window.localStorage.setItem(PUSH_CANCEL_GENERATION_KEY, pushCoordinationToken());
  } catch {
    /* Same-tab generation still cancels pending work. */
  }
  pushEnableCancelRequested = true;
  try {
    window.localStorage.setItem(PUSH_ENABLE_CANCEL_KEY, String(Date.now()));
  } catch {
    // Private mode — same-tab flag still applies.
  }
}

export function clearPushEnableCancel() {
  // Check → clear → re-check. localStorage is not atomic across tabs; if another
  // tab marks+cancels in the window, restore cancel so enable still aborts.
  if (pushSignOutCleanupInProgress || isPushSignOutCleanupMarked()) {
    return;
  }
  try {
    window.localStorage.removeItem(PUSH_ENABLE_CANCEL_KEY);
  } catch {
    // ignore
  }
  if (pushSignOutCleanupInProgress || isPushSignOutCleanupMarked()) {
    requestPushEnableCancel();
    return;
  }
  pushEnableCancelRequested = false;
}

export function isPushEnableCancelRequested() {
  if (pushEnableCancelRequested) {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(PUSH_ENABLE_CANCEL_KEY);
    if (!raw) {
      return false;
    }
    const at = Number(raw);
    // Stale cancel with no live cleanup mark — treat as expired crash residue.
    if (
      Number.isFinite(at) &&
      Date.now() - at > PUSH_SIGNOUT_CLEANUP_TTL_MS &&
      !isPushSignOutCleanupMarked()
    ) {
      window.localStorage.removeItem(PUSH_ENABLE_CANCEL_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function beginPushEnable() {
  if (!pushSignOutCleanupInProgress && !isPushSignOutCleanupMarked()) clearPushEnableCancel();
  pushEnableInFlight += 1;
}

export function endPushEnable() {
  pushEnableInFlight = Math.max(0, pushEnableInFlight - 1);
}

/** Test isolation for the module-local sign-out cancellation state. */
export function resetPushOperationState() {
  pushEnableInFlight = 0;
  pushEnableCancelRequested = false;
  pushSignOutCleanupInProgress = 0;
  for (const timer of pushSignOutGuardHeartbeats) window.clearInterval(timer);
  pushSignOutGuardHeartbeats.clear();
  try {
    window.localStorage.removeItem(PUSH_ENABLE_CANCEL_KEY);
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      if (key.startsWith(PUSH_SIGNOUT_CLEANUP_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Restricted storage.
  }
  try {
    window.sessionStorage.removeItem(PUSH_REMIGRATE_ARM_KEY);
  } catch {
    // Restricted storage.
  }
}

export type PushNotificationsUiState =
  | "unsupported"
  | "needs_install"
  | "blocked"
  | "default"
  | "enabled"
  | "needs_migration"
  /** Remigrate unsub done; second Settings tap must finish subscribe. */
  | "needs_remigrate_finish";

export type PushSubscriptionMaterial = {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId: string;
  pushSwVersion: number;
};

function hasSecureContext() {
  return typeof window !== "undefined" && window.isSecureContext;
}

function hasPushApis() {
  return (
    hasSecureContext() &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    "locks" in navigator
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

export async function resolvePushNotificationsUiState(
  vapid?: {
    publicKey: string;
    keyId?: string;
  } | null,
) {
  const capability = resolvePushNotificationsCapability();
  if (capability !== "default") {
    return capability;
  }
  const sub = await getCurrentPushSubscription();
  // Malformed keys (atob fails): treat like unavailable VAPID so an existing
  // local sub still surfaces as enabled (disable stays available).
  const usableVapid =
    vapid && tryDecodeVapidKeyBytes(vapid.publicKey)
      ? vapid
      : vapid === undefined
        ? undefined
        : null;
  // Matching current-key sub means remigrate finished (possibly on another tab)
  // — consume a stale arm so Settings does not stick on needs_remigrate_finish.
  if (sub && usableVapid && applicationServerKeyMatches(sub, usableVapid.publicKey)) {
    if (usableVapid.keyId) {
      clearPushRemigrateArm();
    }
    return "enabled" as const;
  }
  if (usableVapid?.keyId && peekPushRemigrateArm(usableVapid.keyId)) {
    return "needs_remigrate_finish" as const;
  }
  if (!sub) {
    return "default" as const;
  }
  // Local sub still on a previous VAPID key — still delivering via dual-key
  // env, but Settings must offer a gesture-driven remigrate (auto remigrate
  // is not gesture-safe on Firefox/iOS).
  if (usableVapid && !applicationServerKeyMatches(sub, usableVapid.publicKey)) {
    return "needs_migration" as const;
  }
  return "enabled" as const;
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
 * Register (if needed), check for a newer push-sw.js, and wait until an active
 * worker controls Push. Call before reconcile / enable so `lastSeenAt` refresh
 * implies the device had a chance to activate the display-capable worker.
 *
 * Fail-closed: a failed/timed-out `update()` or a successor still
 * installing/waiting after the wait window must not bump `lastSeenAt`
 * (Safari silent-push revoke).
 */
export async function ensureActivePushServiceWorker() {
  const registration = await resolvePushRegistration();
  if (!registration) {
    return { kind: "unavailable" as const };
  }
  try {
    // Byte-diff update check — required so an already-active pre-display worker
    // is replaced before we bump lastSeenAt (Safari silent-push revoke).
    await Promise.race([
      registration.update(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Push service worker update timed out")), 10_000);
      }),
    ]);
  } catch {
    return { kind: "update_failed" as const };
  }
  const ready = await waitForActiveServiceWorker(registration);
  if (!ready?.active) {
    return { kind: "activation_pending" as const };
  }
  if (ready.installing || ready.waiting) {
    return { kind: "activation_pending" as const };
  }
  const pushSwVersion = await probePushSwVersion(ready);
  if (pushSwVersion === null || pushSwVersion < PUSH_DISPLAY_SW_VERSION) {
    return { kind: "pre_display" as const };
  }
  return { kind: "ready" as const, registration: ready, pushSwVersion };
}

/** Ask the active worker for its display-capable version (MessageChannel). */
function probePushSwVersion(registration: ServiceWorkerRegistration) {
  const worker = registration.active;
  if (!worker) {
    return Promise.resolve(null);
  }
  return new Promise<number | null>((resolve) => {
    const channel = new MessageChannel();
    const finish = (version: number | null) => {
      window.clearTimeout(timer);
      channel.port1.onmessage = null;
      resolve(version);
    };
    const timer = window.setTimeout(() => finish(null), 2_000);
    channel.port1.onmessage = (event) => {
      const version = event.data?.version;
      finish(typeof version === "number" && Number.isFinite(version) ? version : null);
    };
    try {
      worker.postMessage("pocketcircle:push-sw-version", [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * Prefer an existing registration over `ready` (which can hang forever when
 * registration never succeeds). Wait until the worker is active before
 * returning — `pushManager.subscribe` requires an active worker.
 * Also waits out an installing/waiting successor after `registration.update()`.
 * Returns null when a successor is still pending after the timeout (fail closed).
 */
async function waitForActiveServiceWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs = 10_000,
) {
  const candidate = registration.installing ?? registration.waiting;
  if (!candidate) {
    return registration.active ? registration : null;
  }
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      candidate.removeEventListener("statechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (candidate.state === "activated" || candidate.state === "redundant") finish();
    };
    const timer = window.setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);
    candidate.addEventListener("statechange", onStateChange);
    onStateChange();
  });
  if (timedOut && (registration.installing || registration.waiting)) {
    return null;
  }
  return registration.active ? registration : null;
}

async function resolvePushRegistration() {
  if (!hasPushApis()) {
    return null;
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration(PUSH_SERVICE_WORKER_URL);
    if (existing) {
      return await waitForActiveServiceWorker(existing);
    }
  } catch {
    // getRegistration can throw in locked-down contexts.
  }
  const registered = await registerPushServiceWorker();
  if (!registered) {
    return null;
  }
  return await waitForActiveServiceWorker(registered);
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
  const bytes = tryDecodeVapidKeyBytes(base64String);
  if (!bytes) {
    throw new Error("Invalid VAPID public key");
  }
  return bytes;
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
  const expected = tryDecodeVapidKeyBytes(publicKey);
  if (!expected) {
    return false;
  }
  const existing = subscription.options.applicationServerKey;
  if (existing == null) {
    return false;
  }
  const actual =
    existing instanceof ArrayBuffer ? new Uint8Array(existing) : new Uint8Array(existing);
  return uint8ArraysEqual(actual, expected);
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

function isPushSubscribeActivationLost(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

/** Second-gesture arm after remigrate unsub when subscribe lost user activation. */
const PUSH_REMIGRATE_ARM_KEY = "pocketcircle.pushRemigrateArm";

export const PUSH_REMIGRATE_NEEDS_SECOND_GESTURE =
  "Tap Update again to finish notification migration";

export class PushRemigrateNeedsGestureError extends Error {
  constructor() {
    super(PUSH_REMIGRATE_NEEDS_SECOND_GESTURE);
    this.name = "PushRemigrateNeedsGestureError";
  }
}

function armPushRemigrateSubscribe(arm: { previousEndpoint: string; vapidKeyId: string }) {
  try {
    window.sessionStorage.setItem(PUSH_REMIGRATE_ARM_KEY, JSON.stringify(arm));
  } catch {
    // Storage restricted — caller still threw; user can enable fresh.
  }
}

function clearPushRemigrateArm() {
  try {
    window.sessionStorage.removeItem(PUSH_REMIGRATE_ARM_KEY);
  } catch {
    // Restricted storage.
  }
}

function parsePushRemigrateArm(vapidKeyId: string) {
  try {
    const raw = window.sessionStorage.getItem(PUSH_REMIGRATE_ARM_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("previousEndpoint" in parsed) ||
      !("vapidKeyId" in parsed) ||
      typeof parsed.previousEndpoint !== "string" ||
      typeof parsed.vapidKeyId !== "string"
    ) {
      return undefined;
    }
    if (parsed.vapidKeyId !== vapidKeyId) {
      return undefined;
    }
    return { previousEndpoint: parsed.previousEndpoint, vapidKeyId: parsed.vapidKeyId };
  } catch {
    return undefined;
  }
}

/** Peek only — clear after subscribe succeeds so a failed second tap stays armed. */
function peekPushRemigrateArm(vapidKeyId: string) {
  return parsePushRemigrateArm(vapidKeyId);
}

async function remigrateUnsubThenSubscribe(
  existing: PushSubscription,
  options: PushSubscriptionOptionsInit,
  vapid: { publicKey: string; keyId: string },
  registration: ServiceWorkerRegistration,
) {
  const previousEndpoint = existing.endpoint;
  if (!(await existing.unsubscribe())) {
    throw new Error("Push unsubscribe failed");
  }
  // Replacement subscribe may fail — keep the old endpoint as pending cleanup
  // so lifecycle/disable can remove the server row (avoid dual rows / enable-only bind).
  rememberPushEndpoints([
    ...recalledPendingPushCleanup().filter((endpoint) => endpoint !== previousEndpoint),
    previousEndpoint,
  ]);
  try {
    const active = recalledPushEndpoint();
    if (active === previousEndpoint) {
      rememberPushEndpoint(null);
    }
  } catch {
    // Storage restricted.
  }
  try {
    return {
      subscription: await registration.pushManager.subscribe(options),
      previousEndpoint,
    };
  } catch (error) {
    // Firefox / iOS: unsubscribe awaits drop user activation — arm a second
    // Settings tap so subscribe runs under a fresh gesture (research §Hard
    // platform constraints). Chromium usually succeeds in one gesture.
    if (isPushSubscribeActivationLost(error)) {
      armPushRemigrateSubscribe({ previousEndpoint, vapidKeyId: vapid.keyId });
      throw new PushRemigrateNeedsGestureError();
    }
    throw error;
  }
}

/**
 * Subscribe with the current VAPID public key.
 * Prefer matching existing sub. On key conflict, unsubscribe then subscribe —
 * when the second subscribe loses user activation, arm for a fresh gesture
 * instead of leaving the device without a recoverable remigrate path.
 * When a different-key sub is replaced, returns `previousEndpoint` so the
 * caller can `replacePushSubscription` (avoid LRU eviction at the 10-cap).
 */
async function subscribeWithVapid(
  registration: ServiceWorkerRegistration,
  vapid: { publicKey: string; keyId: string },
) {
  const existing = await registration.pushManager.getSubscription();
  if (existing && applicationServerKeyMatches(existing, vapid.publicKey)) {
    // Peer/other tab already remigrated — consume arm and surface previous
    // endpoint so bind can replace the server row when needed.
    const arm = peekPushRemigrateArm(vapid.keyId);
    if (arm) {
      clearPushRemigrateArm();
      return {
        subscription: existing,
        previousEndpoint:
          arm.previousEndpoint !== existing.endpoint ? arm.previousEndpoint : undefined,
      };
    }
    return { subscription: existing, previousEndpoint: undefined };
  }
  const options = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
  };

  // Second Settings tap after arm: old sub already gone.
  if (!existing) {
    const arm = peekPushRemigrateArm(vapid.keyId);
    if (arm) {
      try {
        const subscription = await registration.pushManager.subscribe(options);
        clearPushRemigrateArm();
        return {
          subscription,
          previousEndpoint: arm.previousEndpoint,
        };
      } catch (error) {
        if (isPushSubscribeActivationLost(error)) {
          throw new PushRemigrateNeedsGestureError();
        }
        throw error;
      }
    }
    return {
      subscription: await registration.pushManager.subscribe(options),
      previousEndpoint: undefined,
    };
  }

  // Key mismatch (or missing applicationServerKey) — remigrate.
  return remigrateUnsubThenSubscribe(existing, options, vapid, registration);
}

/**
 * Explicit User action only — requests permission, subscribes, returns material
 * for the enable mutation. Never call on load.
 */
export function requestPushNotificationPermission() {
  if (!hasPushApis()) {
    return Promise.reject(new Error("Push notifications are not supported"));
  }
  return Notification.requestPermission().then((permission) => {
    track("notification_permission_result", { result: permission });
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted");
    }
  });
}

function ensuredFailureMessage(
  kind: "unavailable" | "update_failed" | "activation_pending" | "pre_display",
) {
  return kind === "update_failed"
    ? "Push service worker update failed"
    : kind === "activation_pending"
      ? "Push service worker is still activating"
      : kind === "pre_display"
        ? "Push service worker is not display-capable"
        : "Push service worker is not available";
}

/**
 * Probe whether the active worker is already display-capable without waiting
 * on `registration.update()` (which burns user activation on Firefox/iOS).
 */
async function probeDisplayCapablePushSw(registration: ServiceWorkerRegistration) {
  if (!registration.active || registration.installing || registration.waiting) {
    return null;
  }
  const version = await probePushSwVersion(registration);
  if (version === null || version < PUSH_DISPLAY_SW_VERSION) {
    return null;
  }
  return version;
}

export async function subscribeForPushNotifications(
  vapid: { publicKey: string; keyId: string },
  permission = requestPushNotificationPermission(),
  assertCurrentOperation = () => {},
  ensuredPending = ensureActivePushServiceWorker(),
) {
  // Kick `ensuredPending` in the click stack (caller may share it with
  // permission). Prefer subscribe under gesture when already display-capable
  // or finishing a remigrate arm — do not await `update()` first.
  await permission;
  assertCurrentOperation();

  const registration = await resolvePushRegistration();
  if (!registration) {
    throw new Error("Push service worker is not available");
  }

  const armed = peekPushRemigrateArm(vapid.keyId) !== undefined;

  // Armed remigrate: subscribe immediately under this gesture — do not await
  // version probe first (MessageChannel can burn Firefox/iOS activation).
  if (armed) {
    assertCurrentOperation();
    const { subscription, previousEndpoint } = await subscribeWithVapid(registration, vapid);
    const keys = readSubscriptionKeys(subscription);
    rememberPushEndpoint(keys.endpoint);
    const [ensured, displayVersion] = await Promise.all([
      ensuredPending,
      probeDisplayCapablePushSw(registration),
    ]);
    if (ensured.kind === "ready") {
      return {
        material: {
          ...keys,
          vapidKeyId: vapid.keyId,
          pushSwVersion: ensured.pushSwVersion,
        },
        previousEndpoint,
      };
    }
    if (displayVersion !== null) {
      return {
        material: {
          ...keys,
          vapidKeyId: vapid.keyId,
          pushSwVersion: displayVersion,
        },
        previousEndpoint,
      };
    }
    await subscription.unsubscribe().catch(() => undefined);
    try {
      if (recalledPushEndpoint() === keys.endpoint) {
        rememberPushEndpoint(null);
      }
    } catch {
      // Storage restricted.
    }
    if (previousEndpoint) {
      armPushRemigrateSubscribe({ previousEndpoint, vapidKeyId: vapid.keyId });
    }
    throw new Error(ensuredFailureMessage(ensured.kind));
  }

  const displayVersion = await probeDisplayCapablePushSw(registration);

  if (displayVersion !== null) {
    assertCurrentOperation();
    const { subscription, previousEndpoint } = await subscribeWithVapid(registration, vapid);
    const keys = readSubscriptionKeys(subscription);
    rememberPushEndpoint(keys.endpoint);
    const ensured = await ensuredPending;
    if (ensured.kind === "ready") {
      return {
        material: {
          ...keys,
          vapidKeyId: vapid.keyId,
          pushSwVersion: ensured.pushSwVersion,
        },
        previousEndpoint,
      };
    }
    // Already proved display-capable at click time — update flake must not
    // strand a successful remigrate/enable subscribe.
    return {
      material: {
        ...keys,
        vapidKeyId: vapid.keyId,
        pushSwVersion: displayVersion,
      },
      previousEndpoint,
    };
  }

  const ensured = await ensuredPending;
  if (ensured.kind !== "ready") {
    throw new Error(ensuredFailureMessage(ensured.kind));
  }
  assertCurrentOperation();
  const { subscription, previousEndpoint } = await subscribeWithVapid(ensured.registration, vapid);
  const keys = readSubscriptionKeys(subscription);
  rememberPushEndpoint(keys.endpoint);
  return {
    material: {
      ...keys,
      vapidKeyId: vapid.keyId,
      pushSwVersion: ensured.pushSwVersion,
    },
    previousEndpoint,
  };
}

/**
 * Local unsubscribe; caller persists disable via mutation. When
 * `expectedEndpoint` is set, only unsubscribes if it still matches — avoids
 * racing a newer subscription from a stale reconcile.
 *
 * Throws on registration/subscription lookup failure (do not treat as absence).
 */
export async function unsubscribeLocalPushSubscription(
  expectedEndpoint?: string,
  isCancelled = () => false,
) {
  const registration = await resolvePushRegistration();
  if (!registration) {
    throw new Error("push subscription lookup failed");
  }
  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch {
    throw new Error("push subscription lookup failed");
  }
  if (!subscription) {
    return { status: "absent" as const };
  }
  if (expectedEndpoint && subscription.endpoint !== expectedEndpoint) {
    return { status: "mismatch" as const };
  }
  if (isCancelled()) throw new Error("Push operation cancelled");
  const endpoint = subscription.endpoint;
  if (!(await subscription.unsubscribe())) throw new Error("Push unsubscribe failed");
  return { status: "unsubscribed" as const, endpoint };
}

/**
 * Startup/focus material for reconcile. VAPID key mismatch: leave the local
 * subscription alone (no unsubscribe/resubscribe) — automatic remigrate is not
 * gesture-safe on Firefox/iOS, and the previous VAPID pair still delivers.
 * Explicit Settings enable migrates via subscribeForPushNotifications.
 * Same-key endpoint change vs last remembered endpoint → `previousEndpoint`
 * for owned migration via replacePushSubscription.
 */
export async function readPushSubscriptionMaterial(
  vapid: { publicKey: string; keyId: string },
  isCancelled = () => false,
  pushSwVersion: number,
) {
  const registration = await resolvePushRegistration();
  if (!registration) {
    return { subscription: null };
  }
  let existing: PushSubscription | null = null;
  try {
    existing = await registration.pushManager.getSubscription();
  } catch {
    // Lookup failure — do not treat as confirmed absence.
    return { subscription: null };
  }
  if (isCancelled()) return { subscription: null };
  if (!existing) {
    // Confirmed absence: drop any remembered server binding so dead rows
    // do not consume the ten-device cap.
    const remembered = recalledPushEndpoints();
    const [primary, ...rest] = remembered;
    if (primary) {
      return {
        subscription: null,
        unboundEndpoint: primary,
        unboundEndpoints: [primary, ...rest],
      };
    }
    return { subscription: null };
  }
  if (!applicationServerKeyMatches(existing, vapid.publicKey)) {
    // Keep the old-key subscription intact during automatic reconcile when the
    // current User owns the endpoint (dual-VAPID still delivers). Lifecycle
    // drops a foreign old-key local sub after ownsPushEndpoint — otherwise a
    // later account on the same browser would keep receiving Push for the
    // previous User. Explicit Settings enable remigrates via subscribeWithVapid.
    return { subscription: null, staleKeyEndpoint: existing.endpoint };
  }

  const material = {
    ...readSubscriptionKeys(existing),
    vapidKeyId: vapid.keyId,
    pushSwVersion,
  };
  const active = recalledPushEndpoint();
  const previousEndpoint = active && active !== material.endpoint ? active : undefined;
  if (previousEndpoint) {
    // Keep previous remembered until replace succeeds — otherwise a failed
    // replace forgets the owned old endpoint and cannot retry migration.
    return { subscription: material, previousEndpoint };
  }
  rememberPushEndpoint(material.endpoint);
  return { subscription: material };
}

/**
 * Sign-out helper: unsubscribe locally then remove User binding. Failures and
 * stalled mutations must not block sign-out — this function never rejects.
 * If live `getSubscription()` fails, falls back to the last remembered endpoint
 * so server unbind still runs. The 5s deadline only unblocks the caller —
 * cleanup still runs when the Push lock is free, scoped to endpoints known at
 * sign-out so a later session is safe. Returns a release() the caller must run
 * after `signOut()` settles so cancel spans session invalidation (cross-tab
 * enable during the network round-trip). Never logs endpoint material.
 */
export async function clearLocalPushSubscriptionAndBinding(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  let cleanupId: string | null = null;
  let heartbeat: number | undefined;
  let timer: number | undefined;
  let freezeTimer: number | undefined;
  let signedOut: ReturnType<typeof deferredValue<void>> | null = null;
  let countedCleanup = false;
  try {
    const deadline = Date.now() + 5_000;
    const activeCleanupId = markPushSignOutCleanup();
    cleanupId = activeCleanupId;
    requestPushEnableCancel();
    pushSignOutCleanupInProgress += 1;
    countedCleanup = true;
    // Freeze cleanup targets before lock work. Aborting the lock wait was the root
    // bug (queued cleanup discarded); scoping to this freeze keeps a later session
    // safe when cleanup runs after the caller deadline. The freeze must complete
    // before lock work — racing live capture against lock acquisition left
    // onlyEndpoints empty and skipped live-only cleanup.
    const rememberedAtSignOut = recalledPushEndpoints();
    const liveCapture = deferredValue<string | null>();
    void getCurrentPushSubscription()
      .then((subscription) => {
        liveCapture.resolve(Date.now() < deadline && subscription ? subscription.endpoint : null);
      })
      .catch(() => liveCapture.resolve(null));
    freezeTimer = window.setTimeout(() => liveCapture.resolve(null), 5_000);
    const liveCapturedBeforeDeadline = await liveCapture.promise;
    window.clearTimeout(freezeTimer);
    freezeTimer = undefined;
    const onlyEndpoints = [
      ...new Set(
        [...rememberedAtSignOut, liveCapturedBeforeDeadline].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
      ),
    ];
    const cleanupDone = deferredValue<void>();
    signedOut = deferredValue<void>();
    heartbeat = window.setInterval(() => touchPushSignOutCleanup(activeCleanupId), 15_000);
    pushSignOutGuardHeartbeats.add(heartbeat);
    const remainingMs = Math.max(0, deadline - Date.now());
    timer = window.setTimeout(() => {
      cleanupDone.resolve();
    }, remainingMs);
    // Never release a lock around a still-running unsubscribe or mutation on timeout.
    // The caller may finish sign-out, but later enables stay excluded until it settles.
    const signedOutWait = signedOut;
    void withPushSubscriptionLock(
      async () => {
        try {
          await disableCurrentPushSubscription(disable, {
            // Freeze (`onlyEndpoints`) is what protects a later session — do not
            // cancel the whole unbind just because a newer active endpoint exists.
            rememberedFallbackOnLookupFailure: true,
            onlyEndpoints,
          });
        } finally {
          cleanupDone.resolve();
          await signedOutWait.promise;
        }
      },
      { wait: true },
    ).catch(() => cleanupDone.resolve());
    await cleanupDone.promise;
    window.clearTimeout(timer);
    timer = undefined;
    let released = false;
    const releaseHeartbeat = heartbeat;
    return () => {
      if (released) return;
      released = true;
      window.clearInterval(releaseHeartbeat);
      pushSignOutGuardHeartbeats.delete(releaseHeartbeat);
      unmarkPushSignOutCleanup(activeCleanupId);
      pushSignOutCleanupInProgress = Math.max(0, pushSignOutCleanupInProgress - 1);
      signedOutWait.resolve();
      if (pushEnableInFlight <= 0 && !isPushSignOutCleanupMarked()) clearPushEnableCancel();
    };
  } catch {
    if (freezeTimer !== undefined) window.clearTimeout(freezeTimer);
    if (timer !== undefined) window.clearTimeout(timer);
    if (heartbeat !== undefined) {
      window.clearInterval(heartbeat);
      pushSignOutGuardHeartbeats.delete(heartbeat);
    }
    if (cleanupId !== null) unmarkPushSignOutCleanup(cleanupId);
    if (countedCleanup) {
      pushSignOutCleanupInProgress = Math.max(0, pushSignOutCleanupInProgress - 1);
    }
    signedOut?.resolve();
    if (pushEnableInFlight <= 0 && !isPushSignOutCleanupMarked()) clearPushEnableCancel();
    return () => {};
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
  options?: {
    isCancelled?: () => boolean;
    /** Sign-out only — unbind recalled endpoints when live lookup fails. */
    rememberedFallbackOnLookupFailure?: boolean;
    /**
     * When set (including `[]`), only these endpoints are unbound. Used by
     * sign-out so a deferred lock acquisition cannot adopt a later session's
     * live subscription.
     */
    onlyEndpoints?: readonly string[];
  },
) {
  const cancelled = () => options?.isCancelled?.() === true;
  const frozen = options?.onlyEndpoints;
  let subscription: PushSubscription | null = null;
  let lookupFailed = false;
  try {
    const registration = await resolvePushRegistration();
    if (!registration) {
      // Could not confirm absence vs presence — do not server-unbind a maybe-live sub.
      lookupFailed = true;
    } else {
      try {
        subscription = await registration.pushManager.getSubscription();
      } catch {
        lookupFailed = true;
      }
    }
  } catch {
    lookupFailed = true;
  }
  if (cancelled()) {
    return;
  }
  if (lookupFailed) {
    if (!options?.rememberedFallbackOnLookupFailure) {
      throw new Error("push subscription lookup failed");
    }
    // Best-effort sign-out: no live sub handle — still try remembered endpoints.
    subscription = null;
  }
  const liveEndpoint = subscription?.endpoint ?? null;
  const activeEndpoint = recalledPushEndpoint();
  // Snapshot once — do not re-read storage during awaits (cross-tab enable).
  const endpoints = frozen
    ? [...new Set(frozen.filter((endpoint) => endpoint.length > 0))]
    : [
        ...new Set(
          [liveEndpoint, ...recalledPushEndpoints()].filter(
            (value): value is string => value !== null,
          ),
        ),
      ];
  if (frozen && liveEndpoint && !endpoints.includes(liveEndpoint)) {
    // Later session (or unrelated live sub) — never unsubscribe it.
    subscription = null;
  }
  if (endpoints.length === 0) {
    return;
  }
  // Persist before any await: timeout, tab closure, or response loss must retain all endpoints.
  rememberPushEndpoints(endpoints);
  let unsubscribeFailed = false;
  if (subscription) {
    try {
      if (!(await subscription.unsubscribe())) throw new Error("Push unsubscribe failed");
    } catch {
      // Still clear server bindings below; retry local cleanup after success.
      unsubscribeFailed = true;
    }
  }
  if (cancelled()) {
    return;
  }
  const failures: { endpoint: string; error?: unknown }[] = [];
  for (const endpoint of endpoints) {
    if (cancelled()) {
      return;
    }
    try {
      const outcome = await disable({ endpoint });
      if (!disableRemovedOwnedBinding(outcome)) {
        // Foreign or unconfirmed — keep pending for the owning account.
        failures.push({ endpoint });
      }
    } catch (error) {
      failures.push({ endpoint, error });
    }
  }
  if (cancelled()) {
    return;
  }
  // Re-read active: a later session may have remembered a new endpoint while we ran.
  const activeNow = recalledPushEndpoint();
  const clearActive = activeNow === null || endpoints.includes(activeNow);
  if (failures.length === 0) {
    if (clearActive) {
      rememberPushEndpoint(null);
    }
    applyPendingCleanupFlushResult(endpoints, []);
    if (unsubscribeFailed) {
      if (liveEndpoint && !cancelled() && endpoints.includes(liveEndpoint)) {
        await unsubscribeLocalPushSubscription(liveEndpoint);
      }
    }
    return;
  }
  // Active sub is gone (or never cleared) — keep failures as pending cleanup
  // so a later enable cannot wipe them via rememberPushEndpoint.
  if (clearActive) {
    rememberPushEndpoint(null);
  }
  applyPendingCleanupFlushResult(
    endpoints,
    failures.map((failure) => failure.endpoint),
  );
  if (unsubscribeFailed) throw new Error("Push unsubscribe failed");
  const failure = failures.find(
    (item) =>
      item.error !== undefined &&
      (item.endpoint === liveEndpoint || item.endpoint === activeEndpoint),
  );
  if (failure) throw failure.error;
}

export function disableRemovedOwnedBinding(outcome: unknown) {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "removed" in outcome &&
    outcome.removed === true
  );
}
