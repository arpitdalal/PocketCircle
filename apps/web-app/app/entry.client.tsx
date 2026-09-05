import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { E2E } from "./lib/env.js";
import { startMocks } from "./lib/mocks.js";

// Start the MSW worker (mock mode only) and, in true-E2E mode, install the gated
// test-auth helper — both before hydrating. Each is behind a build-time flag and a
// dynamic import, so production drops them entirely (ADR 0006, ADR 0019).
// Sentry loads after hydrate so `@sentry/react` (+ Replay) stay off the critical
// entry path (RPT-8 / ADR 0012). Earliest boot errors before init are not captured.
async function boot() {
  await startMocks();
  if (E2E) {
    const { installE2EAuthHelper } = await import("./lib/e2e-auth.js");
    installE2EAuthHelper();
  }
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
  void import("./lib/sentry.js")
    .then(({ initSentry }) => initSentry())
    .catch((error) => {
      console.error("Sentry initialization failed", error);
    });
}

void boot();
