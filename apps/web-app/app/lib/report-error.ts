import { scrubAppErrorExtra } from "./sentry-scrub.js";

let pendingCapture: Promise<void> = Promise.resolve();

/**
 * The single seam for reporting an application-level problem — something the app
 * itself got wrong and should fix, as distinct from an expected user or
 * permission outcome. Forwards to Sentry (ADR 0012); dev still warns locally.
 *
 * A missing or inaccessible target is NOT an app error and must never be reported
 * (it would be noise, and the anti-enumeration stance treats it as a normal
 * outcome — ADR 0016). Reserve this for things the app emitted wrong, such as an
 * unparseable in-app link. Never attach financial content (titles, notes, amounts)
 * to `context` — Sentry extras are scrubbed before send, but callers should still
 * avoid attaching financial fields.
 *
 * Dynamic-imports `@sentry/react` so reporting paths do not force the SDK onto
 * the critical entry chunk (RPT-8).
 */
export function reportAppError(message: string, context?: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.warn(`[app] ${message}`, context ?? {});
  }
  pendingCapture = import("@sentry/react")
    .then((Sentry) => {
      Sentry.captureMessage(message, { extra: scrubAppErrorExtra(context) });
    })
    .catch(() => undefined);
  void pendingCapture;
}

/** Drain in-flight Sentry captures so tests don't leak across cases (RPT-8). */
export async function flushReportAppErrorForTests() {
  await pendingCapture;
}
