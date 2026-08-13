import posthog, { type CaptureResult } from "posthog-js";

import {
  type AnalyticsEvent,
  type AnalyticsEventMap,
  isAnalyticsEvent,
  isSensitiveOutgoingPropertyKey,
  sanitizeAnalyticsProps,
} from "./analytics-events.js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./env.js";
import type { SessionUser } from "./session.js";

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

let clientInitialized = false;
let captureEnabled = false;
let initializedForUserId: string | null = null;
let pendingEnabled: boolean | null = null;

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
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      if (!storage) {
        continue;
      }
      for (const key of retiredPostHogStorageKeys(storageKeys(storage), POSTHOG_KEY)) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage may be blocked or unavailable.
  }
  try {
    for (const name of retiredPostHogStorageKeys(cookieNames(), POSTHOG_KEY)) {
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

function stopCaptureAndResetIdentity() {
  captureEnabled = false;
  if (clientInitialized) {
    posthog.stopSessionRecording();
    posthog.reset(true);
  }
}

function applyCaptureEnabled(enabled: boolean) {
  if (!enabled) {
    stopCaptureAndResetIdentity();
    return;
  }
  if (clientInitialized) {
    posthog.stopSessionRecording();
    captureEnabled = true;
  }
}

export function buildPostHogInitOptions() {
  return {
    api_host: POSTHOG_HOST,
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

export function initAnalytics(user: Pick<SessionUser, "id" | "analyticsEnabled">) {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }

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
    stopCaptureAndResetIdentity();
    initializedForUserId = user.id;
    return;
  }

  if (!clientInitialized) {
    clearRetiredPostHogBrowserStorage();
    posthog.init(POSTHOG_KEY, buildPostHogInitOptions());
    posthog.stopSessionRecording();
    clientInitialized = true;
  }

  initializedForUserId = user.id;
  captureEnabled = true;
}

export function setAnalyticsEnabled(enabled: boolean) {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }
  pendingEnabled = enabled;
  applyCaptureEnabled(enabled);
}

export function teardownAnalytics() {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }
  stopCaptureAndResetIdentity();
  clientInitialized = false;
  initializedForUserId = null;
  pendingEnabled = null;
  clearRetiredPostHogBrowserStorage();
}

export function track<E extends AnalyticsEvent>(event: E, props?: AnalyticsEventMap[E]) {
  if (!POSTHOG_KEY || !isBrowser || !clientInitialized || !captureEnabled) {
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
  pendingEnabled = null;
}
