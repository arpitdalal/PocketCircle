import {
  DEFAULT_VAPID_KEY_ID,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";

const INVALID_SUBSCRIPTION = "Invalid push subscription";

const subscriptionFields = {
  endpoint: v.string(),
  p256dh: v.string(),
  auth: v.string(),
  vapidKeyId: v.string(),
};

/**
 * VAPID public key for client subscribe(). Set `VAPID_PUBLIC_KEY` (URL-safe
 * base64) and optional `VAPID_KEY_ID` (defaults to `"primary"`) via
 * `convex env set`. Private key stays server-only for #382 delivery.
 */
export const getPushVapidPublicKey = query({
  args: {},
  handler: async () => {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    if (!publicKey) {
      return null;
    }
    const keyId = process.env.VAPID_KEY_ID?.trim() || DEFAULT_VAPID_KEY_ID;
    return { publicKey, keyId };
  },
});

/** Bind or refresh a Push subscription for the current User (explicit enable). */
export const enablePushSubscription = mutation({
  args: subscriptionFields,
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    assertValidSubscription(args);
    await bindPushSubscription(ctx, user._id, args);
  },
});

/** Remove this User's binding for an endpoint (browser unsubscribe is client-side). */
export const disablePushSubscription = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const existing = await findByEndpoint(ctx, args.endpoint);
    if (!existing || existing.userId !== user._id) {
      return;
    }
    await ctx.db.delete(existing._id);
  },
});

/**
 * Startup/focus reconcile: refresh lastSeenAt / rebind when the browser still
 * has a subscription. `null` leaves other devices alone (sign-out clears local).
 */
export const reconcilePushSubscription = mutation({
  args: {
    subscription: v.union(v.object(subscriptionFields), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    if (args.subscription === null) {
      return;
    }
    assertValidSubscription(args.subscription);
    await bindPushSubscription(ctx, user._id, args.subscription);
  },
});

/** Delete by endpoint after permanent push-service failure (#382). */
export const removeInvalidPushSubscription = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    await deletePushSubscriptionByEndpoint(ctx, args.endpoint);
  },
});

export async function deletePushSubscriptionByEndpoint(ctx: MutationCtx, endpoint: string) {
  const existing = await findByEndpoint(ctx, endpoint);
  if (existing) {
    await ctx.db.delete(existing._id);
  }
}

/** All subscriptions for a User — delivery (#382) and tests. */
export async function listPushSubscriptionsForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

function assertValidSubscription(input: { endpoint: string; p256dh: string; auth: string }) {
  if (!isValidPushSubscriptionMaterial(input)) {
    throw new Error(INVALID_SUBSCRIPTION);
  }
}

async function findByEndpoint(ctx: QueryCtx | MutationCtx, endpoint: string) {
  return await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
    .unique();
}

async function pruneInvalidSubscriptionsForUser(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await listPushSubscriptionsForUser(ctx, userId);
  for (const row of rows) {
    if (
      !isValidPushSubscriptionMaterial({
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
      })
    ) {
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * Drop least-recently-seen rows until `userId` has room for one more.
 * Stable tie-break: lower lastSeenAt first, then `_id` for equal timestamps.
 */
async function makeRoomForOneSubscription(ctx: MutationCtx, userId: Id<"users">) {
  while (true) {
    const rows = await listPushSubscriptionsForUser(ctx, userId);
    if (rows.length < MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
      return;
    }
    const oldest = pickLeastRecentlySeen(rows);
    await ctx.db.delete(oldest._id);
  }
}

function pickLeastRecentlySeen(rows: Doc<"pushSubscriptions">[]) {
  let oldest = rows[0];
  if (!oldest) {
    throw new Error("Expected at least one push subscription");
  }
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    if (
      row.lastSeenAt < oldest.lastSeenAt ||
      (row.lastSeenAt === oldest.lastSeenAt && row._id < oldest._id)
    ) {
      oldest = row;
    }
  }
  return oldest;
}

async function bindPushSubscription(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: {
    endpoint: string;
    p256dh: string;
    auth: string;
    vapidKeyId: string;
  },
) {
  await pruneInvalidSubscriptionsForUser(ctx, userId);
  const now = Date.now();
  const existing = await findByEndpoint(ctx, args.endpoint);

  if (existing) {
    if (existing.userId === userId) {
      await ctx.db.patch(existing._id, {
        p256dh: args.p256dh,
        auth: args.auth,
        vapidKeyId: args.vapidKeyId,
        lastSeenAt: now,
      });
      return;
    }
    // Rebind from another User — counts toward this User's cap.
    await makeRoomForOneSubscription(ctx, userId);
    await ctx.db.patch(existing._id, {
      userId,
      p256dh: args.p256dh,
      auth: args.auth,
      vapidKeyId: args.vapidKeyId,
      lastSeenAt: now,
    });
    return;
  }

  await makeRoomForOneSubscription(ctx, userId);
  await ctx.db.insert("pushSubscriptions", {
    userId,
    endpoint: args.endpoint,
    p256dh: args.p256dh,
    auth: args.auth,
    vapidKeyId: args.vapidKeyId,
    createdAt: now,
    lastSeenAt: now,
  });
}
