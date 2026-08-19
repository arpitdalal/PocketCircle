import { vi } from "vitest";
import { initAnalytics, resetAnalyticsStateForTests } from "~/lib/analytics.js";
import type { SessionUser } from "~/lib/session.js";
import { posthogEnv, resetPostHogSdkMocks } from "./posthog-mock.js";

const defaultAnalyticsUser: SessionUser = {
  id: "analytics-test-user",
  email: "analytics@test.local",
  displayName: "Analytics Test",
  onboardingComplete: true,
  analyticsEnabled: true,
};

/** Prime the real analytics seam for route/component tests that call track without the shell layout. */
export function primeAnalyticsForTests(user: SessionUser = defaultAnalyticsUser) {
  vi.stubEnv("VITE_POSTHOG_KEY", posthogEnv.POSTHOG_KEY ?? "phc_test");
  vi.stubEnv("VITE_POSTHOG_HOST", posthogEnv.POSTHOG_HOST);
  initAnalytics(user);
}

export function resetPostHogBoundary() {
  resetPostHogSdkMocks();
  resetAnalyticsStateForTests();
  vi.unstubAllEnvs();
}

export { posthogEnv, posthogSdk } from "./posthog-mock.js";
