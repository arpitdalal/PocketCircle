import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, type QueryCtx, query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import { requireCircleAccess } from "./guard.js";
import { hashInvitationToken } from "./invitationToken.js";

/** Returns the stashed token only when it still matches a live pending invitation row. */
async function e2eStashedInvitationToken(ctx: QueryCtx, row: Doc<"e2eInvitationTokens"> | null) {
  if (!row) {
    return null;
  }

  const invite = await ctx.db.get(row.invitationId);
  const now = Date.now();
  if (
    invite?.status !== "pending" ||
    (invite?.expiresAt ?? 0) <= now ||
    invite?.circleId !== row.circleId ||
    invite?.emailLower !== row.emailLower
  ) {
    return null;
  }

  const tokenHash = await hashInvitationToken(row.token);
  if (!invite || tokenHash !== invite.tokenHash) {
    return null;
  }

  return row.token;
}

/**
 * E2E-only helpers (ADR 0019). Gated by `E2E_TEST_AUTH=1` on the backend — absent
 * in production. Playwright uses these until MEM-3's accept-invitation flow ships.
 */
export const seedActiveMember = mutation({
  args: {
    circleId: v.id("circles"),
    email: v.string(),
    displayName: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.E2E_TEST_AUTH !== "1") {
      throw new Error("Not found");
    }

    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner || access.circle.kind === "personal") {
      throw new Error("Circle not found");
    }
    access.assertWritable();

    const email = args.email.trim().toLowerCase();
    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (!user) {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {
        email,
        displayName: args.displayName,
        acceptedTermsVersion: CURRENT_TERMS_VERSION,
        acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
        acceptedAt: now,
        analyticsEnabled: true,
        onboardingCompletedAt: now,
        createdAt: now,
      });
      user = await ctx.db.get(userId);
    }

    if (!user) {
      throw new Error("seed failed");
    }

    const existing = await ctx.db
      .query("members")
      .withIndex("by_circle_and_user", (q) =>
        q.eq("circleId", args.circleId).eq("userId", user._id),
      )
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "active",
        displayName: args.displayName,
        removedAt: undefined,
      });
      return { memberId: existing._id };
    }

    const memberId = await ctx.db.insert("members", {
      circleId: args.circleId,
      userId: user._id,
      role: "member",
      status: "active",
      displayName: args.displayName,
      joinedAt: now,
    });

    return { memberId };
  },
});

/**
 * E2E-only invitation acceptance (ADR 0019). Playwright needs a real non-owner
 * Member to exercise leave-circle flows before MEM-3 ships the public accept path.
 * Gated on `E2E_TEST_AUTH=1` — never enabled in production.
 */
export const acceptInvitationForE2E = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (process.env.E2E_TEST_AUTH !== "1") {
      throw new Error("Forbidden");
    }

    const user = await requireCurrentUser(ctx);
    const tokenHash = await hashInvitationToken(args.token);
    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    const now = Date.now();
    if (invite?.status !== "pending" || (invite?.expiresAt ?? 0) <= now) {
      throw new Error("Invalid invitation");
    }
    if (user.email !== invite.emailLower) {
      throw new Error("Email mismatch");
    }

    const existing = await ctx.db
      .query("members")
      .withIndex("by_circle_and_user", (q) =>
        q.eq("circleId", invite.circleId).eq("userId", user._id),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "active",
        displayName: user.displayName,
        removedAt: undefined,
      });
    } else {
      await ctx.db.insert("members", {
        circleId: invite.circleId,
        userId: user._id,
        role: "member",
        status: "active",
        displayName: user.displayName,
        joinedAt: now,
      });
    }

    await ctx.db.patch(invite._id, { status: "accepted" });
  },
});

/** E2E-only: read the last emailed token for a pending invite (ADR 0019 / EML-2). */
export const getInvitationTokenForE2E = query({
  args: {
    circleId: v.id("circles"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.E2E_TEST_AUTH !== "1") {
      throw new Error("Not found");
    }

    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Not found");
    }

    const emailLower = args.email.trim().toLowerCase();
    const row = await ctx.db
      .query("e2eInvitationTokens")
      .withIndex("by_circle_and_email", (q) =>
        q.eq("circleId", args.circleId).eq("emailLower", emailLower),
      )
      .unique();

    return await e2eStashedInvitationToken(ctx, row ?? null);
  },
});

/** E2E-only: read the stashed Account Deletion verification token (USR-3). */
export const getAccountDeletionTokenForE2E = query({
  args: {},
  handler: async (ctx) => {
    if (process.env.E2E_TEST_AUTH !== "1") {
      throw new Error("Not found");
    }

    const user = await requireCurrentUser(ctx);
    const row = await ctx.db
      .query("e2eAccountDeletionTokens")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    return row?.token ?? null;
  },
});
