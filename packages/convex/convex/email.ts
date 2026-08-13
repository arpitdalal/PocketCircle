import { vOnCompleteValidator, Workpool } from "@convex-dev/workpool";
import { feedbackEmail, invitationEmail, welcomeEmail } from "@pocketcircle/domain";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import { hashInvitationToken } from "./invitationToken.js";
import { reportTerminalFailure, type TERMINAL_FAILURE_KINDS } from "./terminalFailure.js";

/**
 * Transactional email via Resend (ADR 0008). v1 sends only Welcome + Invitation
 * emails — not activity notifications (PRD 86).
 *
 * Required deployment env vars (Convex deployment env, like auth.ts):
 * RESEND_API_KEY, RESEND_FROM_EMAIL
 *
 * Feedback (FBK-1) also uses SUPPORT_EMAIL as the recipient address.
 *
 * Optional: EMAIL_DEV_LOG=1 logs subject + body to the Convex console even when
 * Resend creds are configured (also logs when creds are unset). Feedback sends
 * pass `logBodyInDev: false` so free-text message bodies never hit dev logs.
 */

// Durable, throttled handoff to Resend — the shared seam EML-2 / FBK-1 reuse.
// maxParallelism caps concurrent sends so a vendor outage can't stampede Resend.
// (Free-plan ceiling is 20 across ALL pools/workflows — keep the sum under that.)
// Welcome email isn't urgent: back off generously. maxAttempts is TOTAL attempts
// (5 = 1 initial + 4 retries): 30s, 60s, 120s, 240s of backoff (+jitter) ≈ 7.5 min cover.
export const EMAIL_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 30_000,
  base: 2,
};

export const emailPool = new Workpool(components.emailWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: EMAIL_RETRY_BEHAVIOR,
});

/** Resend vendor wiring — single seam for EML-2 / FBK-1. Uses fetch (not SDK).
 *  Returns true on a confirmed 2xx; false when env is unset (no-op, EML-1: a
 *  missing key must not throw into bootstrap or trigger Workpool retries).
 *  THROWS on fetch rejection or non-2xx so the Workpool retries the handoff.
 *  Pass `idempotencyKey` so a retried send dedupes at Resend instead of re-delivering. */
export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
  /** When false, dev logging omits the HTML body (FBK-1 feedback privacy). Default true. */
  logBodyInDev?: boolean;
}) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const logBodyInDev = args.logBodyInDev ?? true;
  const devLog = process.env.EMAIL_DEV_LOG === "1" || !key || !from;
  if (devLog) {
    console.log(`[email] to=${args.to} subject=${JSON.stringify(args.subject)}`);
    if (logBodyInDev) {
      console.log(`[email] body:\n${args.html}`);
    } else {
      console.log("[email] body: (redacted)");
    }
  }
  if (!key || !from) {
    console.error("Resend env not configured; skipping email send");
    return false;
  }
  // fetch can REJECT (DNS/TLS/timeout) before any response — let it propagate so the pool retries.
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Resend dedupes same-key sends for 24h → safe to retry the whole action.
      ...(args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, to: args.to, subject: args.subject, html: args.html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
  return true;
}

/** Skip-and-return when Resend is unset; report once so production misconfig alerts. */
export async function sendEmailOrReport(
  ctx: ActionCtx,
  report: {
    kind: (typeof TERMINAL_FAILURE_KINDS)[number];
    entityId: string;
  },
  args: Parameters<typeof sendEmail>[0],
) {
  const sent = await sendEmail(args);
  if (!sent) {
    await reportTerminalFailure(ctx, {
      kind: report.kind,
      entityId: report.entityId,
      error: "Resend env not configured",
    });
  }
  return sent;
}

export const welcomePayload = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }
    return {
      alreadySent: user.welcomeSentAt !== undefined,
      email: user.email,
      displayName: user.displayName,
    };
  },
});

export const markWelcomed = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (user && user.welcomeSentAt === undefined) {
      await ctx.db.patch(userId, { welcomeSentAt: Date.now() });
    }
  },
});

export const sendWelcomeEmail = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const p = await ctx.runQuery(internal.email.welcomePayload, { userId });
    if (!p || p.alreadySent) {
      return;
    }
    const { subject, html } = welcomeEmail({ displayName: p.displayName });
    const sent = await sendEmailOrReport(
      ctx,
      { kind: "welcome_email_exhausted", entityId: userId },
      {
        to: p.email,
        subject,
        html,
        idempotencyKey: `welcome:${userId}`,
      },
    );
    if (sent) {
      await ctx.runMutation(internal.email.markWelcomed, { userId });
    }
  },
});

export const onWelcomeRunComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ userId: v.id("users") })),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "failed") {
      await reportTerminalFailure(ctx, {
        kind: "welcome_email_exhausted",
        entityId: context.userId,
        error: result.error,
      });
    }
    // result.kind === "success" | "canceled" → nothing to do.
  },
});

/** Returns send payload only when the queued job still matches the invitation row. */
export const invitationPayload = internalQuery({
  args: {
    invitationId: v.id("invitations"),
    resendCount: v.number(),
    tokenHash: v.string(),
  },
  handler: async (ctx, { invitationId, resendCount, tokenHash }) => {
    const invite = await ctx.db.get(invitationId);
    if (
      invite?.status !== "pending" ||
      invite.resendCount !== resendCount ||
      invite.tokenHash !== tokenHash
    ) {
      return null;
    }
    const circle = await ctx.db.get(invite.circleId);
    const owner = await ctx.db.get(invite.invitedByUserId);
    if (!circle || !owner) {
      return null;
    }
    return {
      circleId: invite.circleId,
      recipientEmail: invite.emailLower,
      circleName: circle.name,
      ownerDisplayName: owner.displayName,
    };
  },
});

export const recordE2EInvitationToken = internalMutation({
  args: {
    invitationId: v.id("invitations"),
    circleId: v.id("circles"),
    emailLower: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.E2E_TEST_AUTH !== "1") {
      return;
    }

    const existing = await ctx.db
      .query("e2eInvitationTokens")
      .withIndex("by_circle_and_email", (q) =>
        q.eq("circleId", args.circleId).eq("emailLower", args.emailLower),
      )
      .unique();

    const row = {
      invitationId: args.invitationId,
      token: args.token,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, row);
      return;
    }

    await ctx.db.insert("e2eInvitationTokens", {
      circleId: args.circleId,
      emailLower: args.emailLower,
      ...row,
    });
  },
});

export const sendInvitationEmail = internalAction({
  args: {
    invitationId: v.id("invitations"),
    token: v.string(),
    resendCount: v.number(),
  },
  handler: async (ctx, { invitationId, token, resendCount }) => {
    const tokenHash = await hashInvitationToken(token);
    const p = await ctx.runQuery(internal.email.invitationPayload, {
      invitationId,
      resendCount,
      tokenHash,
    });
    if (!p) {
      return;
    }
    await ctx.runMutation(internal.email.recordE2EInvitationToken, {
      invitationId,
      circleId: p.circleId,
      emailLower: p.recipientEmail,
      token,
    });
    const siteUrl = process.env.SITE_URL ?? "http://127.0.0.1:5173";
    const inviteLink = `${siteUrl}/invite/${token}`;
    const { subject, html } = invitationEmail({
      inviteLink,
      circleName: p.circleName,
      ownerDisplayName: p.ownerDisplayName,
      recipientEmail: p.recipientEmail,
    });
    await sendEmailOrReport(
      ctx,
      { kind: "invitation_email_exhausted", entityId: invitationId },
      {
        to: p.recipientEmail,
        subject,
        html,
        idempotencyKey: `invite:${invitationId}:${resendCount}`,
      },
    );
  },
});

export const onInvitationRunComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ invitationId: v.id("invitations") })),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "failed") {
      await reportTerminalFailure(ctx, {
        kind: "invitation_email_exhausted",
        entityId: context.invitationId,
        error: result.error,
      });
    }
  },
});

const feedbackTypeValidator = v.union(
  v.literal("bug"),
  v.literal("feature"),
  v.literal("currency"),
);

export const sendFeedbackEmail = internalAction({
  args: {
    eventId: v.id("feedbackEmailEvents"),
    type: feedbackTypeValidator,
    message: v.string(),
    userEmail: v.string(),
    displayName: v.string(),
    appVersion: v.string(),
    circleName: v.optional(v.string()),
    circleRef: v.optional(v.string()),
    submittedAtIso: v.string(),
  },
  handler: async (ctx, args) => {
    const supportEmail = process.env.SUPPORT_EMAIL;
    if (!supportEmail) {
      await reportTerminalFailure(ctx, {
        kind: "feedback_email_exhausted",
        entityId: args.eventId,
        error: "SUPPORT_EMAIL not configured",
      });
      return;
    }
    const { subject, html } = feedbackEmail({
      type: args.type,
      message: args.message,
      userEmail: args.userEmail,
      displayName: args.displayName,
      appVersion: args.appVersion,
      circleName: args.circleName,
      circleRef: args.circleRef,
      submittedAtIso: args.submittedAtIso,
    });
    await sendEmailOrReport(
      ctx,
      { kind: "feedback_email_exhausted", entityId: args.eventId },
      {
        to: supportEmail,
        subject,
        html,
        idempotencyKey: `feedback:${args.eventId}`,
        logBodyInDev: false,
      },
    );
  },
});

export const onFeedbackRunComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ eventId: v.id("feedbackEmailEvents") })),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "failed") {
      await reportTerminalFailure(ctx, {
        kind: "feedback_email_exhausted",
        entityId: context.eventId,
        error: result.error,
      });
    }
  },
});
