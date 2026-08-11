import posthog from "posthog-js";

import {
  type AnalyticsEvent,
  type AnalyticsEventMap,
  isAnalyticsEvent,
  sanitizeAnalyticsProps,
} from "./analytics-events.js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./env.js";
import type { SessionUser } from "./session.js";

const isBrowser = typeof window !== "undefined";

let clientInitialized = false;
let captureEnabled = false;

export function buildPostHogInitOptions() {
  return {
    api_host: POSTHOG_HOST,
    disable_session_recording: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: "localStorage" as const,
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
  };
}

export function initAnalytics(user: SessionUser) {
  if (!POSTHOG_KEY || !isBrowser || !user.analyticsEnabled) {
    return;
  }
  if (clientInitialized) {
    return;
  }

  posthog.init(POSTHOG_KEY, buildPostHogInitOptions());
  posthog.opt_in_capturing({ captureEventName: false });
  posthog.stopSessionRecording();
  clientInitialized = true;
  captureEnabled = true;
}

export function setAnalyticsEnabled(enabled: boolean) {
  if (!POSTHOG_KEY || !isBrowser) {
    return;
  }

  if (!enabled) {
    captureEnabled = false;
    if (clientInitialized) {
      posthog.stopSessionRecording();
      posthog.reset();
      posthog.opt_out_capturing();
    }
    return;
  }

  if (clientInitialized) {
    posthog.opt_in_capturing();
    posthog.stopSessionRecording();
    captureEnabled = true;
  }
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
}
