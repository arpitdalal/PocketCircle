"use node";

import * as Sentry from "@sentry/node";
import { internalAction } from "./_generated/server.js";
import { terminalFailureArgsValidator } from "./terminalFailure.js";

/**
 * Convex's default isolate cannot run Sentry SDKs. Node actions are the
 * supported path (`@sentry/node`). Error-only init: no tracesSampleRate, no
 * performance integrations, no ESM loader hooks Convex can't register.
 *
 * Release is the snapshot from the reporting mutation, not `APP_RELEASE` at
 * action time — a delayed run after deploy must still attribute the event to
 * the failing revision. `event.release` wins over client options in Sentry
 * `prepareEvent`, so isolate reuse cannot pin later events to an older init.
 */
function ensureSentry(release: string) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return false;
  }
  Sentry.initWithoutDefaultIntegrations({
    dsn,
    release,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    registerEsmLoaderHooks: false,
    integrations: [...Sentry.getDefaultIntegrationsWithoutPerformance()],
  });
  return true;
}

export const captureTerminalFailure = internalAction({
  args: terminalFailureArgsValidator,
  handler: async (_ctx, args) => {
    try {
      if (!ensureSentry(args.release)) {
        return;
      }
      Sentry.captureEvent({
        message: args.kind,
        level: "error",
        release: args.release,
        tags: { failureKind: args.kind },
        extra: {
          entityId: args.entityId,
          error: args.error,
        },
      });
      await Sentry.flush(2000);
    } catch (caught) {
      console.error("terminal failure sentry capture failed", caught);
    }
  },
});
