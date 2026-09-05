import { vi } from "vitest";
import { flushReportAppErrorForTests } from "~/lib/report-error.js";
import { resetSentryReadyForTests } from "~/lib/sentry.js";

/** Drain pending capture + reset deferred-init gate (pairs with `~/test/sentry-mock.js`). */
export async function resetSentryBoundary() {
  await flushReportAppErrorForTests();
  resetSentryReadyForTests();
  vi.clearAllMocks();
}

export { flushReportAppErrorForTests } from "~/lib/report-error.js";
export {
  envModuleWithSentryDsn,
  sentryModuleMock,
  sentrySdk,
  TEST_SENTRY_DSN,
} from "./sentry-mock.js";
