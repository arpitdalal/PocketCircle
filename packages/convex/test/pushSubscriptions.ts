import { TEST_PUSH_AUTH, TEST_PUSH_P256DH } from "@pocketcircle/domain";
import type { Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";

export { listPushSubscriptionsForUser } from "../convex/pushSubscriptions.js";

type PushSubscriptionSeed = {
  userId: Id<"users">;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  vapidKeyId?: string;
  createdAt?: number;
  lastSeenAt?: number;
};

/** Insert a pushSubscriptions row for tests (incl. intentionally invalid material). */
export async function seedPushSubscription(ctx: MutationCtx, seed: PushSubscriptionSeed) {
  const now = Date.now();
  return await ctx.db.insert("pushSubscriptions", {
    userId: seed.userId,
    endpoint: seed.endpoint,
    p256dh: seed.p256dh ?? TEST_PUSH_P256DH,
    auth: seed.auth ?? TEST_PUSH_AUTH,
    vapidKeyId: seed.vapidKeyId ?? "primary",
    createdAt: seed.createdAt ?? now,
    lastSeenAt: seed.lastSeenAt ?? now,
  });
}
