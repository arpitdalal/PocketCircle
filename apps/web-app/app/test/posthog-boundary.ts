import { initAnalytics, resetAnalyticsStateForTests } from "~/lib/analytics.js";
import type { SessionUser } from "~/lib/session.js";
import { resetPostHogSdkMocks } from "./posthog-mock.js";

const defaultAnalyticsUser: SessionUser = {
  id: "analytics-test-user",
  email: "analytics@test.local",
  displayName: "Analytics Test",
  onboardingComplete: true,
  analyticsEnabled: true,
};

/** Prime the real analytics seam for route/component tests that call track without the shell layout. */
export function primeAnalyticsForTests(user: SessionUser = defaultAnalyticsUser) {
  initAnalytics(user);
}

export function resetPostHogBoundary() {
  resetPostHogSdkMocks();
  resetAnalyticsStateForTests();
}

export { posthogEnv, posthogSdk } from "./posthog-mock.js";
