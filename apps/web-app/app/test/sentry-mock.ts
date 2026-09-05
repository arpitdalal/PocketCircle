import { vi } from "vitest";

export const TEST_SENTRY_DSN = "https://example@sentry.io/1";

/** Shared `@sentry/react` double — vendor boundary only (ADR 0006). */
export const sentrySdk = {
  init: vi.fn(),
  captureMessage: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
};

export const sentryModuleMock = {
  init: sentrySdk.init,
  captureMessage: sentrySdk.captureMessage,
  replayIntegration: sentrySdk.replayIntegration,
};

/** Fixed-DSN `./env.js` mock factory (kept free of app imports to avoid vi.mock cycles). */
export async function envModuleWithSentryDsn(
  importOriginal: () => Promise<typeof import("~/lib/env.js")>,
) {
  const actual = await importOriginal();
  return { ...actual, SENTRY_DSN: TEST_SENTRY_DSN };
}
