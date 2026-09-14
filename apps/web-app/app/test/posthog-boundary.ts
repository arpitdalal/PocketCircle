import { vi } from "vitest";
import {
  holdPostHogLoadForTests,
  initAnalytics,
  resetAnalyticsStateForTests,
} from "~/lib/analytics.js";
import type { SessionUser } from "~/lib/session.js";
import { resetPostHogSdkMocks } from "./posthog-mock.js";

const TEST_POSTHOG_KEY = "phc_test";
const TEST_POSTHOG_HOST = "https://us.i.posthog.com";

const defaultAnalyticsUser: SessionUser = {
  id: "analytics-test-user",
  email: "analytics@test.local",
  displayName: "Analytics Test",
  onboardingComplete: true,
  analyticsEnabled: true,
  createdAt: 1,
  acknowledgedFeatureAnnouncementIds: [],
};

/** Stub Vite PostHog env so real `posthogKey()` / `posthogHost()` run (ADR 0006). */
export function stubPosthogEnvForTests(key = TEST_POSTHOG_KEY) {
  vi.stubEnv("VITE_POSTHOG_KEY", key);
  vi.stubEnv("VITE_POSTHOG_HOST", TEST_POSTHOG_HOST);
}

/** Prime the real analytics seam for route/component tests that call track without the shell layout. */
export async function primeAnalyticsForTests(user: SessionUser = defaultAnalyticsUser) {
  stubPosthogEnvForTests();
  await initAnalytics(user);
}

/** Pause `loadPostHog` until the returned release runs (consent / cold-load races). */
export function holdPostHogLoad() {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdPostHogLoadForTests(hold);
  return () => {
    release();
    holdPostHogLoadForTests(null);
  };
}

export function resetPostHogBoundary() {
  resetPostHogSdkMocks();
  resetAnalyticsStateForTests();
  holdPostHogLoadForTests(null);
  vi.unstubAllEnvs();
}

export { posthogSdk } from "./posthog-mock.js";
