import { SENTRY_DSN } from "./env.js";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub.js";

type SentryReact = typeof import("@sentry/react");

/** Init options for `Sentry.init` — exported for unit tests (ADR 0012, OBS-1). */
export function buildSentryInitOptions(dsn: string, Sentry: SentryReact) {
  return {
    dsn,
    environment: import.meta.env.MODE,
    release: __APP_RELEASE__,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  };
}

/**
 * Client-only Sentry bootstrap. Dynamic-imports `@sentry/react` so the SDK stays
 * off the critical entry chunk (RPT-8). No-ops when `VITE_SENTRY_DSN` is unset.
 * Call after hydrate; earliest boot errors before this resolves are not captured.
 */
export async function initSentry() {
  if (!SENTRY_DSN) {
    return;
  }
  const Sentry = await import("@sentry/react");
  Sentry.init(buildSentryInitOptions(SENTRY_DSN, Sentry));
}
