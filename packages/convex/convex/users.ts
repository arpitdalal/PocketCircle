import { isFeatureAnnouncementId, parseProfileUpdate } from "@pocketcircle/domain";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { getCurrentUserOrNull, requireCurrentUser } from "./auth.js";
import { reconcilePersonalCircleFromDisplayName, setUserDisplayName } from "./model.js";
import { toCurrentUserView } from "./operations.js";

/**
 * The current PocketCircle User, or null when the Google session exists but the
 * User record has not propagated yet. The protected layout uses this to choose
 * between the bootstrap splash and the app shell (ADR 0017). The User and
 * Personal Circle are created by the `onCreateUser` trigger in auth.ts.
 *
 * Resolves the User from the Better Auth session, then runs the shared
 * current-User operation (#316) so trusted server callers can use the same view.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    return user ? toCurrentUserView(user) : null;
  },
});

/** One-time Onboarding confirmation: owned Display Name + Personal Circle reconcile (USR-1). */
export const completeOnboarding = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    if (user.onboardingCompletedAt !== null) {
      throw new Error("Onboarding already completed");
    }

    const parsed = parseProfileUpdate({ displayName: args.displayName });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const confirmedName = parsed.value.displayName;

    if (confirmedName !== user.displayName) {
      await setUserDisplayName(ctx, user._id, confirmedName);
    }

    await reconcilePersonalCircleFromDisplayName(ctx, user._id, confirmedName);

    const now = Date.now();
    await ctx.db.patch(user._id, { onboardingCompletedAt: now });
  },
});

/**
 * Post-onboarding Display Name edit (Settings). Updates member materialized identity
 * and keeps the Personal Circle name/mark aligned with the new Display Name (USR-1).
 */
export const updateProfile = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const parsed = parseProfileUpdate({ displayName: args.displayName });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const displayName = parsed.value.displayName;
    await setUserDisplayName(ctx, user._id, displayName);
    await reconcilePersonalCircleFromDisplayName(ctx, user._id, displayName);
  },
});

/** Persists the product-analytics preference (ADR 0013). */
export const setAnalyticsEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    await ctx.db.patch(user._id, { analyticsEnabled: args.enabled });
  },
});

/**
 * Permanently acknowledges a Feature Announcement (CTA or close). Idempotent;
 * rejects unknown IDs. Preference lives on the User so Account Deletion clears it.
 */
export const acknowledgeFeatureAnnouncement = mutation({
  args: { announcementId: v.string() },
  handler: async (ctx, args) => {
    if (!isFeatureAnnouncementId(args.announcementId)) {
      throw new Error("Unknown feature announcement");
    }
    const user = await requireCurrentUser(ctx);
    const existing = user.acknowledgedFeatureAnnouncementIds ?? [];
    if (existing.includes(args.announcementId)) {
      return;
    }
    await ctx.db.patch(user._id, {
      acknowledgedFeatureAnnouncementIds: [...existing, args.announcementId],
    });
  },
});
