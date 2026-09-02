import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";

export const TERMINAL_FAILURE_KINDS = [
  "welcome_email_exhausted",
  "invitation_email_exhausted",
  "feedback_email_exhausted",
  "account_deletion_email_exhausted",
  "account_deletion_cleanup_failed",
  "mcp_worker_cleanup_exhausted",
] as const;

export const terminalFailureKindValidator = v.union(
  v.literal("welcome_email_exhausted"),
  v.literal("invitation_email_exhausted"),
  v.literal("feedback_email_exhausted"),
  v.literal("account_deletion_email_exhausted"),
  v.literal("account_deletion_cleanup_failed"),
  v.literal("mcp_worker_cleanup_exhausted"),
);

export const terminalFailureArgsValidator = v.object({
  kind: terminalFailureKindValidator,
  entityId: v.string(),
  error: v.string(),
  release: v.string(),
});

const LOG_MESSAGE = {
  welcome_email_exhausted: "Welcome email exhausted all retries",
  invitation_email_exhausted: "Invitation email exhausted all retries",
  feedback_email_exhausted: "Feedback email exhausted all retries",
  account_deletion_email_exhausted: "Account deletion email exhausted all retries",
  account_deletion_cleanup_failed: "Account deletion cleanup failed",
  mcp_worker_cleanup_exhausted: "MCP Worker grant cleanup exhausted all retries",
} as const;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const MAX_ERROR_CHARS = 300;

/** Strip emails/URLs from vendor error text before log or Sentry. */
export function sanitizeOperationalError(error: string) {
  return error
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(URL_RE, "[redacted-url]")
    .slice(0, MAX_ERROR_CHARS);
}

/** Log locally and best-effort schedule Sentry capture. Never throws. */
export async function reportTerminalFailure(
  ctx: MutationCtx | ActionCtx,
  args: {
    kind: (typeof TERMINAL_FAILURE_KINDS)[number];
    entityId: string;
    error: string;
  },
) {
  const error = sanitizeOperationalError(args.error);
  console.error(LOG_MESSAGE[args.kind], args.entityId, error);
  try {
    await ctx.scheduler.runAfter(0, internal.terminalFailureSentry.captureTerminalFailure, {
      kind: args.kind,
      entityId: args.entityId,
      error,
      // Snapshot now: the Node action may run after a later deploy changed APP_RELEASE.
      release: process.env.APP_RELEASE ?? "local-dev",
    });
  } catch (caught) {
    console.error("terminal failure report schedule failed", caught);
  }
}
