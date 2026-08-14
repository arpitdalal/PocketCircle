import * as Sentry from "@sentry/react";
import { replayIntegration } from "@sentry/react";
import { SENTRY_DSN } from "./env.js";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub.js";

export function sentryReplayIntegration() {
  return replayIntegration({ maskAllText: true, blockAllMedia: true });
}

/** Init options for `Sentry.init` — exported for unit tests (ADR 0012, OBS-1). */
export function buildSentryInitOptions(dsn: string) {
  return {
    dsn,
    environment: import.meta.env.MODE,
    release: __APP_RELEASE__,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [sentryReplayIntegration()],
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  };
}

/** Client-only Sentry bootstrap. No-ops when `VITE_SENTRY_DSN` is unset. */
export function initSentry() {
  if (!SENTRY_DSN) {
    return;
  }
  Sentry.init(buildSentryInitOptions(SENTRY_DSN));
}
