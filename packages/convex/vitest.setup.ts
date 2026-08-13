import { resetCapturedRequests } from "@pocketcircle/mocks";
import { server } from "@pocketcircle/mocks/server";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { resetSentryBoundary } from "./test/sentry-boundary.js";

vi.mock("@sentry/node", async () => {
  const { sentryNodeSdk } = await import("./test/sentry-boundary.js");
  return {
    init: sentryNodeSdk.init,
    initWithoutDefaultIntegrations: sentryNodeSdk.initWithoutDefaultIntegrations,
    getDefaultIntegrationsWithoutPerformance:
      sentryNodeSdk.getDefaultIntegrationsWithoutPerformance,
    captureMessage: sentryNodeSdk.captureMessage,
    captureEvent: sentryNodeSdk.captureEvent,
    flush: sentryNodeSdk.flush,
  };
});

// MSW intercepts outbound vendor fetch calls during convex-test actions (ADR 0006).
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  server.resetHandlers();
  resetCapturedRequests();
  resetSentryBoundary();
});
afterAll(() => server.close());
