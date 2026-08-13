import { vi } from "vitest";

const errorOnlyIntegrations = [{ name: "error-only" }];

/** Mocked `@sentry/node` boundary for convex-test (ADR 0006). */
export const sentryNodeSdk = {
  init: vi.fn(),
  initWithoutDefaultIntegrations: vi.fn(),
  getDefaultIntegrationsWithoutPerformance: vi.fn(() => errorOnlyIntegrations),
  captureMessage: vi.fn(),
  captureEvent: vi.fn(),
  flush: vi.fn(async () => true),
};

export function resetSentryBoundary() {
  sentryNodeSdk.init.mockReset();
  sentryNodeSdk.initWithoutDefaultIntegrations.mockReset();
  sentryNodeSdk.getDefaultIntegrationsWithoutPerformance.mockReset();
  sentryNodeSdk.getDefaultIntegrationsWithoutPerformance.mockReturnValue(errorOnlyIntegrations);
  sentryNodeSdk.captureMessage.mockReset();
  sentryNodeSdk.captureEvent.mockReset();
  sentryNodeSdk.flush.mockReset();
  sentryNodeSdk.flush.mockResolvedValue(true);
}

export function enableSentryReporting() {
  vi.stubEnv("SENTRY_DSN", "https://example@sentry.io/1");
  vi.stubEnv("APP_RELEASE", "abc1234");
  vi.stubEnv("SENTRY_ENVIRONMENT", "test");
}
