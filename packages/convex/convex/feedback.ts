import {
  buildRef,
  MUTATION_ERRORS,
  mutationErrorData,
  parseFeedbackSubmission,
} from "@pocketcircle/domain";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import { emailPool } from "./email.js";
import { resolveCircleAccessForUser } from "./guard.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_FEEDBACK_CAP = 20;

const feedbackTypeValidator = v.union(
  v.literal("bug"),
  v.literal("feature"),
  v.literal("currency"),
);

/** Insert-then-count: cap is enforced after the ledger row exists so check/insert/enqueue stay aligned. */
async function assertDailyFeedbackCapAfterInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventId: Id<"feedbackEmailEvents">,
  now: number,
) {
  const windowStart = now - DAY_MS;
  const recent = await ctx.db
    .query("feedbackEmailEvents")
    .withIndex("by_user_and_sentAt", (q) => q.eq("userId", userId).gt("sentAt", windowStart))
    .take(DAILY_FEEDBACK_CAP + 1);
  if (recent.length > DAILY_FEEDBACK_CAP) {
    await ctx.db.delete(eventId);
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.feedbackDailyCapReached));
  }
}

/**
 * In-app feedback (FBK-1). Sends one support email via the Resend seam; stores only
 * rate-limit metadata in `feedbackEmailEvents` — never the free-text message.
 *
 * Deployment env: `SUPPORT_EMAIL` (recipient). Uses existing `RESEND_*` vars for send.
 */
export const submitFeedback = mutation({
  args: {
    type: feedbackTypeValidator,
    message: v.string(),
    appVersion: v.string(),
    circleId: v.optional(v.id("circles")),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const parsed = parseFeedbackSubmission({
      type: args.type,
      message: args.message,
      appVersion: args.appVersion,
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const now = Date.now();

    let circleName: string | undefined;
    let circleRef: string | undefined;
    if (args.circleId) {
      const access = await resolveCircleAccessForUser(ctx, args.circleId, user);
      if (access) {
        circleName = access.circle.name;
        circleRef = buildRef(access.circle.name, access.circle._id);
      }
    }

    const eventId = await ctx.db.insert("feedbackEmailEvents", {
      userId: user._id,
      type: parsed.value.type,
      sentAt: now,
    });
    await assertDailyFeedbackCapAfterInsert(ctx, user._id, eventId, now);

    await emailPool.enqueueAction(
      ctx,
      internal.email.sendFeedbackEmail,
      {
        eventId,
        type: parsed.value.type,
        message: parsed.value.message,
        userEmail: user.email,
        displayName: user.displayName,
        appVersion: parsed.value.appVersion,
        circleName,
        circleRef,
        submittedAtIso: new Date(now).toISOString(),
      },
      {
        onComplete: internal.email.onFeedbackRunComplete,
        context: { eventId },
      },
    );
  },
});
