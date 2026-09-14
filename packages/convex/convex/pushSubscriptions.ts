import {
  DEFAULT_VAPID_KEY_ID,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  PUSH_DISPLAY_SW_VERSION,
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

/** Expand-contract: parent tabs omit pushSwVersion; new clients send it. */
const subscriptionFields = {
  endpoint: v.string(),
  p256dh: v.string(),
  auth: v.string(),
  vapidKeyId: v.string(),
  pushSwVersion: v.optional(v.number()),
};

/**
 * VAPID public key for client subscribe(). Set `VAPID_PUBLIC_KEY` (URL-safe
 * base64) and optional `VAPID_KEY_ID` (defaults to `"primary"`) via
 * `convex env set`. Private key + subject stay server-only (`VAPID_PRIVATE_KEY`,
 * `VAPID_SUBJECT`) for Push delivery (#382).
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
    if (!existing) {
      // Already gone — safe to drop local pending retry.
      return { removed: true };
    }
    if (existing.userId !== user._id) {
      // Another User owns this endpoint — keep the caller's pending handle.
      return { removed: false };
    }
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

/**
 * True when the current User owns this Push endpoint. Used on VAPID mismatch
 * during reconcile: drop a foreign old-key local subscription without disabling
 * another User's server row.
 */
export const ownsPushEndpoint = query({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const existing = await findByEndpoint(ctx, args.endpoint);
    return existing?.userId === user._id;
  },
});

/**
 * Bump lastSeenAt for an owned endpoint without changing keys / vapidKeyId.
 * Owned old-key subscriptions skip reconcile (would write the new key id) but
 * still need LRU freshness so active devices are not evicted at the ten-cap.
 */
export const touchPushSubscription = mutation({
  args: {
    endpoint: v.string(),
    /** Expand-contract: omitted by parent tabs — no touch without display proof. */
    pushSwVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const existing = await findByEndpoint(ctx, args.endpoint);
    if (!existing || existing.userId !== user._id) {
      return { touched: false };
    }
    const pushSwVersion = displayCapablePushSwVersion(args.pushSwVersion);
    if (pushSwVersion === undefined) {
      return { touched: false };
    }
    await ctx.db.patch(existing._id, {
      lastSeenAt: Date.now(),
      pushSwVersion,
    });
    return { touched: true };
  },
});

/**
 * Startup/focus reconcile: refresh lastSeenAt / keys only when this User already
 * owns the endpoint. Never steals another User's binding and never auto-creates
 * a first binding — that requires explicit enable (#381 / research §7).
 * Returns `{ bound }` so the client can drop an orphan local subscription.
 */
export const reconcilePushSubscription = mutation({
  args: {
    subscription: v.union(v.object(subscriptionFields), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    if (args.subscription === null) {
      return { bound: false };
    }
    assertValidSubscription(args.subscription);
    const existing = await findByEndpoint(ctx, args.subscription.endpoint);
    if (!existing || existing.userId !== user._id) {
      return { bound: false };
    }
    await ctx.db.patch(existing._id, {
      p256dh: args.subscription.p256dh,
      auth: args.subscription.auth,
      vapidKeyId: args.subscription.vapidKeyId,
      lastSeenAt: Date.now(),
      // Preserve an existing display version when a parent tab omits the field.
      ...pushSwVersionPatch(args.subscription.pushSwVersion),
    });
    return { bound: true };
  },
});

/**
 * Replace a browser-refreshed endpoint. Only when `previousEndpoint` is already
 * owned by the current User — never migrates another User's binding, and never
 * steals a `next` endpoint owned by someone else (explicit enable may rebind).
 */
export const replacePushSubscription = mutation({
  args: {
    previousEndpoint: v.string(),
    ...subscriptionFields,
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const { previousEndpoint, ...next } = args;
    assertValidSubscription(next);
    const previous = await findByEndpoint(ctx, previousEndpoint);
    if (!previous || previous.userId !== user._id) {
      return { bound: false };
    }
    const nextExisting = await findByEndpoint(ctx, next.endpoint);
    if (nextExisting && nextExisting.userId !== user._id) {
      return { bound: false };
    }
    const now = Date.now();
    const versionFields = pushSwVersionPatch(next.pushSwVersion);
    if (nextExisting && nextExisting._id !== previous._id) {
      // Next endpoint already ours on another row — keep previous._id so
      // in-flight Workpool jobs still resolve; drop the duplicate next row.
      await ctx.db.delete(nextExisting._id);
      await ctx.db.patch(previous._id, {
        endpoint: next.endpoint,
        p256dh: next.p256dh,
        auth: next.auth,
        vapidKeyId: next.vapidKeyId,
        lastSeenAt: now,
        ...versionFields,
      });
      return { bound: true };
    }
    // Same-user endpoint refresh / VAPID remigrate: patch in place so in-flight
    // Push jobs keyed by subscriptionId still resolve to this device.
    await ctx.db.patch(previous._id, {
      endpoint: next.endpoint,
      p256dh: next.p256dh,
      auth: next.auth,
      vapidKeyId: next.vapidKeyId,
      lastSeenAt: now,
      ...versionFields,
    });
    return { bound: true };
  },
});

/**
 * Delete after permanent push-service / crypto failure (#382). Only removes the
 * row when id + endpoint + keys still match the failed send snapshot — a
 * concurrent reconcile/rebind that refreshed material is left alone.
 */
export const removeInvalidPushSubscription = internalMutation({
  args: {
    subscriptionId: v.id("pushSubscriptions"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.subscriptionId);
    if (!row) {
      return;
    }
    if (row.endpoint !== args.endpoint || row.p256dh !== args.p256dh || row.auth !== args.auth) {
      return;
    }
    await ctx.db.delete(row._id);
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

function assertValidSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId: string;
  pushSwVersion?: number;
}) {
  // Endpoint/keys only — pushSwVersion is optional (expand-contract). Delivery
  // eligibility still requires a display-capable version on the stored row.
  if (!isValidPushSubscriptionMaterial(input)) {
    throw new Error(INVALID_SUBSCRIPTION);
  }
}

/** Display-capable version only; omit/low → undefined (no eligibility grant). */
function displayCapablePushSwVersion(pushSwVersion: number | undefined) {
  if (pushSwVersion === undefined || pushSwVersion < PUSH_DISPLAY_SW_VERSION) {
    return undefined;
  }
  return pushSwVersion;
}

function pushSwVersionPatch(pushSwVersion: number | undefined) {
  const version = displayCapablePushSwVersion(pushSwVersion);
  return version === undefined ? {} : { pushSwVersion: version };
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
    if (!isValidPushSubscriptionMaterial(row)) {
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
    pushSwVersion?: number;
  },
) {
  // Missing/low version: still bind (parent-tab expand-contract) but do not
  // write a display-capable pushSwVersion — eligibility stays closed.
  const versionFields = pushSwVersionPatch(args.pushSwVersion);
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
        ...versionFields,
      });
      return;
    }
    // Rebind from another User — counts toward this User's cap. Replace the
    // row so we never inherit the prior owner's pushSwVersion (parent-tab
    // omit must not grant delivery eligibility).
    await makeRoomForOneSubscription(ctx, userId);
    await ctx.db.delete(existing._id);
    await ctx.db.insert("pushSubscriptions", {
      userId,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      vapidKeyId: args.vapidKeyId,
      createdAt: now,
      lastSeenAt: now,
      ...versionFields,
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
    ...versionFields,
  });
}
