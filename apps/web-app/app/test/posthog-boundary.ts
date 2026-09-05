import { vi } from "vitest";
import { initAnalytics, resetAnalyticsStateForTests } from "~/lib/analytics.js";
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

export function resetPostHogBoundary() {
  resetPostHogSdkMocks();
  resetAnalyticsStateForTests();
  vi.unstubAllEnvs();
}

export { posthogSdk } from "./posthog-mock.js";
