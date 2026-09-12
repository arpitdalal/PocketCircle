/**
 * Per-device Push subscription lifecycle (#381). Browser APIs only — Convex
 * mutations live in `~/lib/data/push-subscriptions.ts`. Never log endpoints.
 */
import { isInstalledWebApp, isIosDevice } from "~/components/pwa-install.js";
import { track } from "~/lib/analytics.js";
import { MOCKS } from "~/lib/env.js";

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

function writeEndpointList(key: string, endpoints: readonly string[]) {
  try {
    const unique = [...new Set(endpoints.filter((endpoint) => endpoint.length > 0))];
    if (unique.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const [only, ...rest] = unique;
    if (only && rest.length === 0) {
      window.localStorage.setItem(key, only);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(unique));
  } catch {
    // Private mode / blocked storage — cleanup may fall back to live lookup only.
  }
}

/** Failed server-unbind retries only — never replaces the active endpoint. */
export function rememberPushEndpoints(endpoints: readonly string[]) {
  writeEndpointList(PENDING_PUSH_CLEANUP_KEY, endpoints);
}

/**
 * After a pending-cleanup flush: drop only endpoints from `attempted` that are
 * absent from `failures` (confirmed removed). Keep failures plus any endpoints
 * another tab added after the snapshot — never replace the whole list.
 */
export function applyPendingCleanupFlushResult(
  attempted: readonly string[],
  failures: readonly string[],
) {
  const attemptedSet = new Set(attempted.filter((endpoint) => endpoint.length > 0));
  const next = [
    ...recalledPendingPushCleanup().filter((endpoint) => !attemptedSet.has(endpoint)),
    ...failures.filter((endpoint) => endpoint.length > 0),
  ];
  rememberPushEndpoints([...new Set(next)]);
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
    let pending = readEndpointList(PENDING_PUSH_CLEANUP_KEY);
    if (legacy?.startsWith("[")) {
      const migrated = readEndpointList(LAST_PUSH_ENDPOINT_KEY).filter(
        (value) => value !== endpoint,
      );
      pending = [...pending, ...migrated];
    }
    // Active again — drop this endpoint from pending so cleanup cannot unbind it.
    writeEndpointList(
      PENDING_PUSH_CLEANUP_KEY,
      pending.filter((value) => value !== endpoint),
    );
    window.localStorage.setItem(LAST_PUSH_ENDPOINT_KEY, endpoint);
  } catch {
    // Private mode / blocked storage.
  }
}

/** Failed server-unbind retries only (excludes the active endpoint key). */
export function recalledPendingPushCleanup() {
  return readEndpointList(PENDING_PUSH_CLEANUP_KEY);
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
  rememberPushEndpoints([]);
}

export function recalledPushEndpoints() {
  try {
    const rawActive = window.localStorage.getItem(LAST_PUSH_ENDPOINT_KEY);
    let active: string[] = [];
    let pending = readEndpointList(PENDING_PUSH_CLEANUP_KEY);
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

/** True while Settings enable is mid-flight — lifecycle must not orphan the new sub. */
const PUSH_ENABLE_LEASE_PREFIX = "pocketcircle.pushEnableLease.";
/** Crash recovery only — active enables refresh lease timestamps via heartbeat. */
const PUSH_ENABLE_IN_FLIGHT_TTL_MS = 60_000;
const PUSH_ENABLE_IN_FLIGHT_HEARTBEAT_MS = 15_000;
/**
 * After enable commits, keep the lease briefly so a concurrent orphan drop cannot
 * unsubscribe the just-bound endpoint between reconcile `{ bound: false }` and drop.
 * Must cover `waitForActiveServiceWorker` (up to 10s) inside orphan unsubscribe.
 */
const PUSH_ENABLE_LEASE_GRACE_MS = 12_000;
let pushEnableInFlight = 0;
const localPushEnableLeaseIds: string[] = [];
let pushEnableHeartbeatTimer: number | null = null;
let pushEnableGraceUntil = 0;
const pushEnableGraceTimers = new Set<number>();

function newPushEnableLeaseId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sweepExpiredPushEnableLeases() {
  try {
    const now = Date.now();
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(PUSH_ENABLE_LEASE_PREFIX)) {
        continue;
      }
      const startedAt = Number(window.localStorage.getItem(key));
      if (!Number.isFinite(startedAt) || now - startedAt > PUSH_ENABLE_IN_FLIGHT_TTL_MS) {
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

function anyFreshCrossTabPushEnableLease() {
  sweepExpiredPushEnableLeases();
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PUSH_ENABLE_LEASE_PREFIX)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function touchLocalPushEnableLeases() {
  try {
    const now = String(Date.now());
    for (const id of localPushEnableLeaseIds) {
      window.localStorage.setItem(`${PUSH_ENABLE_LEASE_PREFIX}${id}`, now);
    }
  } catch {
    // ignore
  }
}

function syncPushEnableHeartbeat() {
  if (pushEnableInFlight > 0) {
    if (pushEnableHeartbeatTimer !== null) {
      return;
    }
    pushEnableHeartbeatTimer = window.setInterval(() => {
      if (pushEnableInFlight <= 0) {
        if (pushEnableHeartbeatTimer !== null) {
          window.clearInterval(pushEnableHeartbeatTimer);
          pushEnableHeartbeatTimer = null;
        }
        return;
      }
      touchLocalPushEnableLeases();
    }, PUSH_ENABLE_IN_FLIGHT_HEARTBEAT_MS);
    return;
  }
  if (pushEnableHeartbeatTimer !== null) {
    window.clearInterval(pushEnableHeartbeatTimer);
    pushEnableHeartbeatTimer = null;
  }
}

export function beginPushEnable() {
  // Fresh enable may clear a stale cancel, but never during sign-out cleanup.
  if (!pushSignOutCleanupInProgress) {
    pushEnableCancelRequested = false;
  }
  pushEnableInFlight += 1;
  const id = newPushEnableLeaseId();
  localPushEnableLeaseIds.push(id);
  try {
    window.localStorage.setItem(`${PUSH_ENABLE_LEASE_PREFIX}${id}`, String(Date.now()));
  } catch {
    // Private mode — same-tab counter still applies.
  }
  syncPushEnableHeartbeat();
}

export function endPushEnable() {
  pushEnableInFlight = Math.max(0, pushEnableInFlight - 1);
  pushEnableGraceUntil = Math.max(pushEnableGraceUntil, Date.now() + PUSH_ENABLE_LEASE_GRACE_MS);
  const id = localPushEnableLeaseIds.pop();
  if (id) {
    // Keep the cross-tab lease visible through the grace window.
    try {
      window.localStorage.setItem(`${PUSH_ENABLE_LEASE_PREFIX}${id}`, String(Date.now()));
    } catch {
      // ignore
    }
    const timer = window.setTimeout(() => {
      pushEnableGraceTimers.delete(timer);
      try {
        window.localStorage.removeItem(`${PUSH_ENABLE_LEASE_PREFIX}${id}`);
      } catch {
        // ignore
      }
    }, PUSH_ENABLE_LEASE_GRACE_MS);
    pushEnableGraceTimers.add(timer);
  }
  syncPushEnableHeartbeat();
}

export function isPushEnableInFlight() {
  return (
    pushEnableInFlight > 0 || Date.now() < pushEnableGraceUntil || anyFreshCrossTabPushEnableLease()
  );
}

/** Sign-out sets this so an in-flight enable aborts before/after bind. */
let pushEnableCancelRequested = false;
/** True while sign-out Push cleanup runs — beginPushEnable must not clear cancel. */
let pushSignOutCleanupInProgress = false;

export function requestPushEnableCancel() {
  pushEnableCancelRequested = true;
}

export function clearPushEnableCancel() {
  pushEnableCancelRequested = false;
}

export function isPushEnableCancelRequested() {
  return pushEnableCancelRequested;
}

/** Wait until same-tab enable counter is 0 (ignores post-commit grace). */
export async function waitForActivePushEnableIdle(timeoutMs = 15_000) {
  if (pushEnableInFlight <= 0) {
    return;
  }
  const started = Date.now();
  while (pushEnableInFlight > 0) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("push enable still in flight");
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 25);
    });
  }
}

/** Same-tab: orphan unsubscribe in flight — enable waits so bind is not killed mid-flight. */
let orphanDropInFlight = 0;

export function beginOrphanDrop() {
  orphanDropInFlight += 1;
}

export function endOrphanDrop() {
  orphanDropInFlight = Math.max(0, orphanDropInFlight - 1);
}

export function isOrphanDropInFlight() {
  return orphanDropInFlight > 0;
}

/** Bounded wait so Settings enable does not race a same-tab orphan unsubscribe. */
export async function waitForOrphanDropIdle(timeoutMs = 15_000) {
  if (orphanDropInFlight <= 0) {
    return;
  }
  const started = Date.now();
  while (orphanDropInFlight > 0) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("push orphan drop still in flight");
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 25);
    });
  }
}

/** Test helper — drop leases/grace so cases do not leak across tests. */
export function resetPushEnableLeases() {
  pushEnableInFlight = 0;
  localPushEnableLeaseIds.length = 0;
  pushEnableGraceUntil = 0;
  orphanDropInFlight = 0;
  pushEnableCancelRequested = false;
  pushSignOutCleanupInProgress = false;
  for (const timer of pushEnableGraceTimers) {
    window.clearTimeout(timer);
  }
  pushEnableGraceTimers.clear();
  if (pushEnableHeartbeatTimer !== null) {
    window.clearInterval(pushEnableHeartbeatTimer);
    pushEnableHeartbeatTimer = null;
  }
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PUSH_ENABLE_LEASE_PREFIX)) {
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
 * registration never succeeds). Wait until the worker is active before
 * returning — `pushManager.subscribe` requires an active worker.
 */
async function waitForActiveServiceWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs = 10_000,
) {
  if (registration.active) {
    return registration;
  }
  const candidate = registration.installing ?? registration.waiting;
  if (!candidate) {
    return null;
  }
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const onStateChange = () => {
          if (registration.active || candidate.state === "activated") {
            candidate.removeEventListener("statechange", onStateChange);
            resolve();
            return;
          }
          if (candidate.state === "redundant") {
            candidate.removeEventListener("statechange", onStateChange);
            reject(new Error("service worker redundant"));
          }
        };
        candidate.addEventListener("statechange", onStateChange);
        onStateChange();
      }),
      new Promise<void>((_, reject) => {
        window.setTimeout(() => reject(new Error("service worker activate timeout")), timeoutMs);
      }),
    ]);
  } catch {
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
 *
 * Throws on registration/subscription lookup failure (do not treat as absence).
 */
export async function unsubscribeLocalPushSubscription(
  expectedEndpoint?: string,
  options?: { abortIfEnableInFlight?: boolean },
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
  // Enable may have started after the caller's pre-check — abort before the
  // destructive unsubscribe so Settings enable is not left with a dead local sub.
  if (options?.abortIfEnableInFlight && isPushEnableInFlight()) {
    throw new Error("push enable in flight");
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return { status: "unsubscribed" as const, endpoint };
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
    // Lookup failure — do not treat as confirmed absence.
    return { subscription: null };
  }
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
    const unboundEndpoint = existing.endpoint;
    // Snapshot before await — another tab may enable and remember a new endpoint.
    const rememberedBeforeUnsubscribe = recalledPushEndpoints();
    try {
      await existing.unsubscribe();
    } catch {
      // Local sub still present — do not unbind server or Settings shows
      // enabled with nothing deliverable after a successful disable.
      return { subscription: null };
    }
    return {
      subscription: null,
      unboundEndpoint,
      unboundEndpoints: [...new Set([unboundEndpoint, ...rememberedBeforeUnsubscribe])],
    };
  }

  const material = {
    ...readSubscriptionKeys(existing),
    vapidKeyId: vapid.keyId,
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
 * stalled mutations must not block sign-out. If live `getSubscription()` fails,
 * falls back to the last remembered endpoint so server unbind still runs.
 * After the deadline, local side effects stop so a later session is untouched.
 * Never logs endpoint material.
 */
export async function clearLocalPushSubscriptionAndBinding(
  disable: (args: { endpoint: string }) => Promise<unknown>,
) {
  const SIGN_OUT_CLEANUP_TIMEOUT_MS = 5_000;
  // Abort any in-flight Settings enable before snapshotting endpoints to unbind.
  requestPushEnableCancel();
  pushSignOutCleanupInProgress = true;
  try {
    try {
      await waitForActivePushEnableIdle(SIGN_OUT_CLEANUP_TIMEOUT_MS);
    } catch {
      // Proceed with best-effort cleanup even if enable is stuck.
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cancelled = true;
    }, SIGN_OUT_CLEANUP_TIMEOUT_MS);
    try {
      await Promise.race([
        disableCurrentPushSubscription(disable, {
          isCancelled: () => cancelled,
          // Sign-out must still best-effort unbind remembered endpoints when the
          // live lookup fails — Settings stays strict (no fallback).
          rememberedFallbackOnLookupFailure: true,
        }),
        new Promise((_, reject) => {
          window.setTimeout(
            () => reject(new Error("push cleanup timeout")),
            SIGN_OUT_CLEANUP_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      // Never block sign-out on Push cleanup.
    } finally {
      window.clearTimeout(timer);
    }
  } finally {
    pushSignOutCleanupInProgress = false;
    // Keep cancel if enable is still stuck so a late bind still aborts.
    if (pushEnableInFlight <= 0) {
      clearPushEnableCancel();
    }
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
  },
) {
  const cancelled = () => options?.isCancelled?.() === true;
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
  // Snapshot once — do not re-read storage during awaits (cross-tab enable).
  const endpoints = [
    ...new Set(
      [liveEndpoint, ...recalledPushEndpoints()].filter((value): value is string => value !== null),
    ),
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
  if (cancelled()) {
    return;
  }
  const failures: { endpoint: string; error: unknown }[] = [];
  for (const endpoint of endpoints) {
    if (cancelled()) {
      return;
    }
    try {
      const outcome = await disable({ endpoint });
      if (!disableRemovedOwnedBinding(outcome)) {
        // Foreign or unconfirmed — keep pending for the owning account.
        failures.push({ endpoint, error: new Error("push binding not removed") });
      }
    } catch (error) {
      failures.push({ endpoint, error });
    }
  }
  if (cancelled()) {
    return;
  }
  if (failures.length === 0) {
    rememberPushEndpoint(null);
    applyPendingCleanupFlushResult(endpoints, []);
    if (unsubscribeFailed) {
      const lingering = await getCurrentPushSubscription();
      if (cancelled()) {
        return;
      }
      // Only touch the endpoint we started with — never a later session's sub.
      if (lingering && liveEndpoint && lingering.endpoint === liveEndpoint) {
        // Server unbound but browser sub remains — surface so Settings does
        // not claim disabled while still showing enabled.
        await lingering.unsubscribe();
      }
    }
    return;
  }
  // Active sub is gone (or never cleared) — keep failures as pending cleanup
  // so a later enable cannot wipe them via rememberPushEndpoint.
  rememberPushEndpoint(null);
  applyPendingCleanupFlushResult(
    endpoints,
    failures.map((failure) => failure.endpoint),
  );
  throw failures[0]?.error;
}

function disableRemovedOwnedBinding(outcome: unknown) {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "removed" in outcome &&
    outcome.removed === true
  );
}
