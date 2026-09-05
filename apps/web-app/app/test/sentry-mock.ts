import { vi } from "vitest";

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

export function resetSentrySdkMocks() {
  vi.clearAllMocks();
}
