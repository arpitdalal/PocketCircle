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

const POSTHOG_CONSENT_STORAGE_PREFIX = "__ph_opt_in_out_";

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

function clearLeftoverPostHogConsent() {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }
  try {
    window.localStorage?.removeItem(`${POSTHOG_CONSENT_STORAGE_PREFIX}${POSTHOG_KEY}`);
  } catch {
    // Storage may be blocked or unavailable.
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
  }

  if (!user.analyticsEnabled) {
    stopCaptureAndResetIdentity();
    initializedForUserId = user.id;
    return;
  }

  if (!clientInitialized) {
    clearLeftoverPostHogConsent();
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

  if (!enabled) {
    stopCaptureAndResetIdentity();
    return;
  }

  if (clientInitialized) {
    posthog.stopSessionRecording();
    captureEnabled = true;
  }
}

export function teardownAnalytics() {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }
  stopCaptureAndResetIdentity();
  clientInitialized = false;
  initializedForUserId = null;
  clearLeftoverPostHogConsent();
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
}
