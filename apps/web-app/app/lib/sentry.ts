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

let readyPromise: Promise<SentryReact | null> | null = null;

/**
 * Single Sentry load+init seam for boot and `reportAppError` (RPT-8 / ADR 0012).
 * Returns the SDK after init when DSN is set; null when unset or load/init fails.
 * Earliest errors before the first caller starts this promise are not captured.
 */
export function ensureSentryReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!SENTRY_DSN) {
        return null;
      }
      const Sentry = await import("@sentry/react");
      Sentry.init(buildSentryInitOptions(SENTRY_DSN, Sentry));
      return Sentry;
    })().catch(() => null);
  }
  return readyPromise;
}

/** Client-only Sentry bootstrap — alias of `ensureSentryReady` for the entry boot path. */
export async function initSentry() {
  await ensureSentryReady();
}

/** Test-only: clear the shared ready promise so DSN stubs can re-run init. */
export function resetSentryReadyForTests() {
  readyPromise = null;
}
