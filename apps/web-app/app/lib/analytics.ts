import {
  type AnalyticsEvent,
  type AnalyticsEventMap,
  isAnalyticsEvent,
  isSensitiveOutgoingPropertyKey,
  sanitizeAnalyticsProps,
} from "./analytics-events.js";
import { posthogHost, posthogKey } from "./env.js";
import type { SessionUser } from "./session.js";

type PostHogClient = typeof import("posthog-js")["default"];
type CaptureResult = import("posthog-js").CaptureResult;

const isBrowser = typeof window !== "undefined";

const POSTHOG_URL_PROPERTY_KEYS = [
  "$current_url",
  "$pathname",
  "$host",
  "$referrer",
  "$referring_domain",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
  "$initial_referring_domain",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_host",
  "$session_entry_referrer",
  "$session_entry_referring_domain",
  "$prev_pageview_pathname",
  "$title",
] as const;

let posthog: PostHogClient | null = null;
let clientInitialized = false;
let captureEnabled = false;
let initializedForUserId: string | null = null;
/** Last User id passed to initAnalytics — used to restart after a failed opt-out race. */
let lastAnalyticsUserId: string | null = null;
let pendingEnabled: boolean | null = null;
let loadPromise: Promise<PostHogClient | null> | null = null;
/** Bumped to invalidate in-flight initAnalytics work after await loadPostHog. */
let initEpoch = 0;
/** Test-only gate so races during PostHog chunk load can be asserted. */
let postHogLoadHold: Promise<void> | null = null;

function invalidatePendingInits() {
  initEpoch += 1;
}

/** If capture should be on but isn't (stale init aborted mid-load), start a fresh init. */
function restartInitIfCaptureStillOff() {
  if (captureEnabled || !lastAnalyticsUserId) {
    return;
  }
  void initAnalytics({ id: lastAnalyticsUserId, analyticsEnabled: true });
}

/** Keys the previous localStorage persistence and consent APIs left behind. */
export function retiredPostHogStorageKeys(keys: readonly string[], token: string) {
  return keys.filter(
    (key) =>
      key === "ph_debug" || key === `__ph_opt_in_out_${token}` || key.startsWith(`ph_${token}_`),
  );
}

function storageKeys(storage: Storage) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

function cookieNames() {
  if (!isBrowser || !document.cookie) {
    return [];
  }
  return document.cookie.split(";").flatMap((part) => {
    const name = part.split("=")[0]?.trim();
    return name ? [name] : [];
  });
}

function clearRetiredPostHogBrowserStorage() {
  const key = posthogKey();
  if (!key || !isBrowser) {
    return;
  }
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      if (!storage) {
        continue;
      }
      for (const keyName of retiredPostHogStorageKeys(storageKeys(storage), key)) {
        storage.removeItem(keyName);
      }
    }
  } catch {
    // Storage may be blocked or unavailable.
  }
  try {
    for (const name of retiredPostHogStorageKeys(cookieNames(), key)) {
      // biome-ignore lint/suspicious/noDocumentCookie: expire leftover PostHog cookies the old persistence wrote
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  } catch {
    // document.cookie may be unavailable.
  }
}

function scrubOutgoingCapture(event: CaptureResult | null) {
  if (!event || !captureEnabled) {
    return null;
  }
  if (!isAnalyticsEvent(event.event)) {
    return null;
  }

  const properties: CaptureResult["properties"] = {};
  for (const [key, value] of Object.entries(event.properties)) {
    if (isSensitiveOutgoingPropertyKey(key)) {
      continue;
    }
    properties[key] = value;
  }

  return {
    uuid: event.uuid,
    event: event.event,
    properties,
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
  };
}

async function loadPostHog() {
  if (postHogLoadHold) {
    await postHogLoadHold;
  }
  if (posthog) {
    return posthog;
  }
  if (!loadPromise) {
    loadPromise = import("posthog-js")
      .then((mod) => {
        posthog = mod.default;
        return posthog;
      })
      .catch(() => {
        loadPromise = null;
        return null;
      });
  }
  return loadPromise;
}

function stopCaptureAndResetIdentity() {
  captureEnabled = false;
  if (clientInitialized && posthog) {
    posthog.stopSessionRecording();
    posthog.reset(true);
  }
}

function applyCaptureEnabled(enabled: boolean) {
  if (!enabled) {
    stopCaptureAndResetIdentity();
    return;
  }
  if (clientInitialized && posthog) {
    posthog.stopSessionRecording();
    captureEnabled = true;
  }
}

export function buildPostHogInitOptions() {
  return {
    api_host: posthogHost(),
    disable_session_recording: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: "memory" as const,
    person_profiles: "never" as const,
    save_referrer: false,
    save_campaign_params: false,
    opt_out_persistence_by_default: true,
    property_denylist: [...POSTHOG_URL_PROPERTY_KEYS],
    before_send: scrubOutgoingCapture,
  };
}

/**
 * Init PostHog only when analytics are enabled. Dynamic-imports `posthog-js` so
 * the SDK stays off the protected-shell chunk until a ready, opted-in User (RPT-8 /
 * ADR 0013).
 */
export async function initAnalytics(user: Pick<SessionUser, "id" | "analyticsEnabled">) {
  const key = posthogKey();
  if (!key || !isBrowser) {
    return;
  }

  lastAnalyticsUserId = user.id;
  clearRetiredPostHogBrowserStorage();

  if (initializedForUserId !== null && initializedForUserId !== user.id) {
    stopCaptureAndResetIdentity();
    initializedForUserId = null;
    pendingEnabled = null;
  }

  if (pendingEnabled !== null && pendingEnabled === user.analyticsEnabled) {
    pendingEnabled = null;
  }
  const enabled = pendingEnabled ?? user.analyticsEnabled;

  if (!enabled) {
    invalidatePendingInits();
    stopCaptureAndResetIdentity();
    initializedForUserId = user.id;
    return;
  }

  const epoch = ++initEpoch;
  const client = await loadPostHog();
  if (epoch !== initEpoch || !client) {
    return;
  }

  // Preference may have flipped while the chunk loaded (setAnalyticsEnabled /
  // teardown bump initEpoch; pendingEnabled false also blocks).
  if (pendingEnabled === false) {
    stopCaptureAndResetIdentity();
    initializedForUserId = user.id;
    return;
  }

  if (!clientInitialized) {
    client.init(key, buildPostHogInitOptions());
    client.stopSessionRecording();
    clientInitialized = true;
  }

  initializedForUserId = user.id;
  captureEnabled = true;
}

export function setAnalyticsEnabled(enabled: boolean) {
  if (!posthogKey() || !isBrowser) {
    return;
  }
  pendingEnabled = enabled;
  if (!enabled) {
    invalidatePendingInits();
  }
  applyCaptureEnabled(enabled);
  if (enabled) {
    restartInitIfCaptureStillOff();
  }
}

/** Restore capture from the persisted preference without keeping the optimistic override. */
export function revertPendingAnalyticsEnabled(enabled: boolean) {
  if (!posthogKey() || !isBrowser) {
    return;
  }
  pendingEnabled = null;
  applyCaptureEnabled(enabled);
  if (enabled) {
    restartInitIfCaptureStillOff();
  }
}

export function teardownAnalytics() {
  if (!posthogKey() || !isBrowser) {
    return;
  }
  invalidatePendingInits();
  stopCaptureAndResetIdentity();
  clientInitialized = false;
  initializedForUserId = null;
  lastAnalyticsUserId = null;
  pendingEnabled = null;
  clearRetiredPostHogBrowserStorage();
}

export function track<E extends AnalyticsEvent>(event: E, props?: AnalyticsEventMap[E]) {
  if (!posthogKey() || !isBrowser || !clientInitialized || !captureEnabled || !posthog) {
    return;
  }
  if (!isAnalyticsEvent(event)) {
    return;
  }

  const sanitized = sanitizeAnalyticsProps(event, props);
  if (!sanitized) {
    return;
  }

  try {
    posthog.capture(event, sanitized);
  } catch {
    // Product analytics are best-effort and must not affect user flows.
  }
}

/** Test-only reset so unit tests can re-run init lifecycle. */
export function resetAnalyticsStateForTests() {
  clientInitialized = false;
  captureEnabled = false;
  initializedForUserId = null;
  lastAnalyticsUserId = null;
  pendingEnabled = null;
  posthog = null;
  loadPromise = null;
  initEpoch = 0;
  postHogLoadHold = null;
}

/** Test-only: pause loadPostHog until `hold` settles (consent/teardown race coverage). */
export function holdPostHogLoadForTests(hold: Promise<void> | null) {
  postHogLoadHold = hold;
}
