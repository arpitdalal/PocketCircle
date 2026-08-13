"use node";

import * as Sentry from "@sentry/node";
import { internalAction } from "./_generated/server.js";
import { terminalFailureArgsValidator } from "./terminalFailure.js";

/**
 * Convex's default isolate cannot run Sentry SDKs. Node actions are the
 * supported path (`@sentry/node`). Error-only init: no tracesSampleRate, no
 * performance integrations, no ESM loader hooks Convex can't register.
 */
function ensureSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return false;
  }
  Sentry.initWithoutDefaultIntegrations({
    dsn,
    release: process.env.APP_RELEASE ?? "local-dev",
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
      if (!ensureSentry()) {
        return;
      }
      Sentry.captureMessage(args.kind, {
        level: "error",
        tags: { failureKind: args.kind },
        extra: {
          entityId: args.entityId,
          error: args.error,
          release: args.release,
        },
      });
      await Sentry.flush(2000);
    } catch (caught) {
      console.error("terminal failure sentry capture failed", caught);
    }
  },
});
