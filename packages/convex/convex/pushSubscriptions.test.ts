import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listPushSubscriptionsForUser, seedPushSubscription } from "../test/pushSubscriptions.js";
import { makeUser, seedPersonalCircleOwner } from "../test/seed.js";
import { api } from "./_generated/api.js";
import { finalizeOnUserDelete } from "./accountDeletionFinalize.js";
import schema from "./schema.js";

vi.mock("./auth.js", async () => (await import("../test/mockAuth.js")).authMockModule());

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  resetMockCurrentUser();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const VALID = {
  endpoint: "https://push.example/endpoint-a",
  p256dh: "p256dh-a",
  auth: "auth-a",
  vapidKeyId: "primary",
} as const;

describe("pushSubscriptions", () => {
  it("returns null vapid public key when env is unset", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toBeNull();
  });

  it("returns public key and keyId from env", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPtestPublicKey");
    vi.stubEnv("VAPID_KEY_ID", "rotated");
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toEqual({
      publicKey: "BPtestPublicKey",
      keyId: "rotated",
    });
  });

  it("defaults keyId to primary when only public key is set", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPtestPublicKey");
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toEqual({
      publicKey: "BPtestPublicKey",
      keyId: "primary",
    });
  });

  it("enable binds a subscription to the current User", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);

    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);

    const rows = await t.run((ctx) => listPushSubscriptionsForUser(ctx, owner._id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(VALID.endpoint);
    expect(rows[0]?.userId).toBe(owner._id);
  });

  it("rejects structurally invalid subscription material", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);

    await expect(
      t.mutation(api.pushSubscriptions.enablePushSubscription, {
        ...VALID,
        endpoint: "http://insecure.example/x",
      }),
    ).rejects.toThrow("Invalid push subscription");
  });

  it("rebinds an endpoint from another User on account switch", async () => {
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: VALID.endpoint,
        lastSeenAt: 1000,
      }),
    );

    signInAs(bob);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, {
      ...VALID,
      p256dh: "p256dh-bob",
      auth: "auth-bob",
    });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(0);
      const bobRows = await listPushSubscriptionsForUser(ctx, bob._id);
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0]?.p256dh).toBe("p256dh-bob");
      expect(bobRows[0]?.auth).toBe("auth-bob");
    });
  });

  it("refreshes keys and lastSeenAt for the same User endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);

    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    const firstSeen = await t.run(async (ctx) => {
      const row = (await listPushSubscriptionsForUser(ctx, owner._id))[0];
      return row?.lastSeenAt;
    });

    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    await t.mutation(api.pushSubscriptions.enablePushSubscription, {
      ...VALID,
      p256dh: "p256dh-refreshed",
      auth: "auth-refreshed",
    });

    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.p256dh).toBe("p256dh-refreshed");
      expect(rows[0]?.lastSeenAt).toBeGreaterThan(firstSeen ?? 0);
    });
  });

  it("reconcile refreshes lastSeenAt and rebinds to the authenticated User", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: VALID.endpoint,
        lastSeenAt: 1,
      }),
    );

    signInAs(bob);
    vi.setSystemTime(new Date("2026-03-02T00:00:00Z"));
    await t.mutation(api.pushSubscriptions.reconcilePushSubscription, {
      subscription: VALID,
    });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(0);
      const bobRows = await listPushSubscriptionsForUser(ctx, bob._id);
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0]?.lastSeenAt).toBe(Date.parse("2026-03-02T00:00:00Z"));
    });
  });

  it("reconcile with null does not wipe other device subscriptions", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "https://push.example/other-device",
      }),
    );

    await t.mutation(api.pushSubscriptions.reconcilePushSubscription, {
      subscription: null,
    });

    const rows = await t.run((ctx) => listPushSubscriptionsForUser(ctx, owner._id));
    expect(rows).toHaveLength(1);
  });

  it("prunes invalid subscriptions before enforcing the ten-subscription cap", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);

    await t.run(async (ctx) => {
      await seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "not-https",
        p256dh: "x",
        auth: "y",
        lastSeenAt: 1,
      });
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i += 1) {
        await seedPushSubscription(ctx, {
          userId: owner._id,
          endpoint: `https://push.example/old-${i}`,
          lastSeenAt: 100 + i,
        });
      }
    });

    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);

    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
      expect(rows.every((r) => r.endpoint.startsWith("https://"))).toBe(true);
      expect(rows.some((r) => r.endpoint === VALID.endpoint)).toBe(true);
      // Invalid pruned first; least recently seen among remaining valid was replaced.
      expect(rows.some((r) => r.endpoint === "https://push.example/old-0")).toBe(false);
    });
  });

  it("replaces least recently seen when at cap after prune", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);

    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i += 1) {
        await seedPushSubscription(ctx, {
          userId: owner._id,
          endpoint: `https://push.example/cap-${i}`,
          lastSeenAt: 1000 + i,
        });
      }
    });

    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);

    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
      expect(rows.some((r) => r.endpoint === "https://push.example/cap-0")).toBe(false);
      expect(rows.some((r) => r.endpoint === VALID.endpoint)).toBe(true);
    });
  });

  it("disable removes only the current User's binding for that endpoint", async () => {
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run(async (ctx) => {
      await seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: VALID.endpoint,
      });
      await seedPushSubscription(ctx, {
        userId: bob._id,
        endpoint: "https://push.example/bob-only",
      });
    });

    signInAs(alice);
    await t.mutation(api.pushSubscriptions.disablePushSubscription, {
      endpoint: VALID.endpoint,
    });
    // No-op for Bob's endpoint.
    await t.mutation(api.pushSubscriptions.disablePushSubscription, {
      endpoint: "https://push.example/bob-only",
    });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(0);
      expect(await listPushSubscriptionsForUser(ctx, bob._id)).toHaveLength(1);
    });
  });

  it("Account Deletion removes every subscription owned by the User", async () => {
    const t = convexTest(schema, modules);
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "gone@example.com",
        displayName: "Gone",
        onboarded: true,
      }),
    );
    const other = await t.run((ctx) => makeUser(ctx, "keep@example.com", "Keep"));
    await t.run(async (ctx) => {
      await seedPushSubscription(ctx, {
        userId: deleting.userId,
        endpoint: "https://push.example/mine-1",
      });
      await seedPushSubscription(ctx, {
        userId: deleting.userId,
        endpoint: "https://push.example/mine-2",
      });
      await seedPushSubscription(ctx, {
        userId: other._id,
        endpoint: "https://push.example/theirs",
      });
    });

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: deleting.owner.email,
          userId: deleting.userId,
          name: deleting.owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, deleting.userId)).toHaveLength(0);
      expect(await listPushSubscriptionsForUser(ctx, other._id)).toHaveLength(1);
    });
  });
});
