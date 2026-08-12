import { parseProfileUpdate } from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { getCurrentUserOrNull, requireCurrentUser } from "./auth.js";
import { reconcilePersonalCircleFromDisplayName, setUserDisplayName } from "./model.js";

/**
 * The current-user view the protected layout and settings read (ADR 0003). Derived
 * from the User row so the client cannot drift from the backend contract.
 */
export function toCurrentUserView(user: Doc<"users">) {
  return {
    id: user._id,
    email: user.email,
    displayName: user.displayName,
    image: user.image,
    onboardingComplete: user.onboardingCompletedAt !== null,
    analyticsEnabled: user.analyticsEnabled,
  };
}

/**
 * The current PocketCircle User, or null when the Google session exists but the
 * User record has not propagated yet. The protected layout uses this to choose
 * between the bootstrap splash and the app shell (ADR 0017). The User and
 * Personal Circle are created by the `onCreateUser` trigger in auth.ts.
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

/** Persists explicit product-analytics consent (ADR 0013). */
export const setAnalyticsEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    await ctx.db.patch(user._id, { analyticsEnabled: args.enabled });
  },
});
