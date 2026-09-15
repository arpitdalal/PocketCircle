import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import {
  generateTestVapidKeyPair,
  TEST_PUSH_AUTH,
  TEST_PUSH_AUTH_ALT,
  TEST_PUSH_P256DH,
  TEST_PUSH_P256DH_ALT,
} from "../test/pushFixtures.js";
import { listPushSubscriptionsForUser, seedPushSubscription } from "../test/pushSubscriptions.js";
import { makeUser, seedPersonalCircleOwner } from "../test/seed.js";
import { api } from "./_generated/api.js";
import { finalizeOnUserDelete } from "./accountDeletionFinalize.js";
import { isSubscriptionEligibleForPushDelivery } from "./pushDelivery.js";
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
  endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-a",
  p256dh: TEST_PUSH_P256DH,
  auth: TEST_PUSH_AUTH,
  vapidKeyId: "primary",
  pushSwVersion: 2,
} as const;

describe("pushSubscriptions", () => {
  it("returns null vapid public key when env is unset", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toBeNull();
  });

  it("returns public key and keyId from env", async () => {
    const { publicKey } = generateTestVapidKeyPair();
    vi.stubEnv("VAPID_PUBLIC_KEY", publicKey);
    vi.stubEnv("VAPID_KEY_ID", "rotated");
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toEqual({
      publicKey,
      keyId: "rotated",
    });
  });

  it("defaults keyId to primary when only public key is set", async () => {
    const { publicKey } = generateTestVapidKeyPair();
    vi.stubEnv("VAPID_PUBLIC_KEY", publicKey);
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toEqual({
      publicKey,
      keyId: "primary",
    });
  });

  it("returns null vapid public key when env is malformed", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "!!!not-base64!!!");
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toBeNull();
  });

  it("returns null vapid public key when env is not an uncompressed P-256 key", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPtestPublicKey");
    const t = convexTest(schema, modules);
    expect(await t.query(api.pushSubscriptions.getPushVapidPublicKey, {})).toBeNull();
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

  it("ownsPushEndpoint is true only for the current User's binding", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    const other = await t.run((ctx) => makeUser(ctx, "b@example.com", "B"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);

    expect(
      await t.query(api.pushSubscriptions.ownsPushEndpoint, { endpoint: VALID.endpoint }),
    ).toBe(true);
    expect(
      await t.query(api.pushSubscriptions.ownsPushEndpoint, {
        endpoint: "https://fcm.googleapis.com/fcm/send/missing",
      }),
    ).toBe(false);

    signInAs(other);
    expect(
      await t.query(api.pushSubscriptions.ownsPushEndpoint, { endpoint: VALID.endpoint }),
    ).toBe(false);
  });

  it("touchPushSubscription refreshes lastSeenAt without changing keys", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      const row = rows[0];
      if (!row) throw new Error("missing row");
      await ctx.db.patch(row._id, { lastSeenAt: 1_000 });
    });

    const touched = await t.mutation(api.pushSubscriptions.touchPushSubscription, {
      endpoint: VALID.endpoint,
      pushSwVersion: 2,
    });
    expect(touched).toEqual({ touched: true });

    const after = await t.run((ctx) => listPushSubscriptionsForUser(ctx, owner._id));
    expect(after).toHaveLength(1);
    expect(after[0]?.lastSeenAt).toBeGreaterThan(1_000);
    expect(after[0]?.vapidKeyId).toBe("primary");
    expect(after[0]?.p256dh).toBe(VALID.p256dh);
  });

  it("touchPushSubscription does not touch another User's endpoint", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    const other = await t.run((ctx) => makeUser(ctx, "b@example.com", "B"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    signInAs(other);
    expect(
      await t.mutation(api.pushSubscriptions.touchPushSubscription, {
        endpoint: VALID.endpoint,
        pushSwVersion: 2,
      }),
    ).toEqual({ touched: false });
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

  it("accepts parent-tab enable without pushSwVersion but does not grant delivery eligibility", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    const { pushSwVersion: _omit, ...legacy } = VALID;
    await t.mutation(api.pushSubscriptions.enablePushSubscription, legacy);
    const row = await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      return rows[0];
    });
    expect(row?.endpoint).toBe(VALID.endpoint);
    expect(row?.pushSwVersion).toBeUndefined();
    expect(
      isSubscriptionEligibleForPushDelivery({
        lastSeenAt: row?.lastSeenAt ?? 0,
        pushSwVersion: row?.pushSwVersion,
      }),
    ).toBe(false);
  });

  it("preserves display pushSwVersion when parent-tab reconcile omits it", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    const { pushSwVersion: _omit, ...legacy } = VALID;
    await t.mutation(api.pushSubscriptions.reconcilePushSubscription, {
      subscription: { ...legacy, p256dh: TEST_PUSH_P256DH_ALT },
    });
    const row = await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      return rows[0];
    });
    expect(row?.pushSwVersion).toBe(2);
    expect(row?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
  });

  it("clears stored pushSwVersion when reconcile reports an explicit low version", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    await t.mutation(api.pushSubscriptions.reconcilePushSubscription, {
      subscription: { ...VALID, pushSwVersion: 0 },
    });
    const row = await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      return rows[0];
    });
    expect(row?.pushSwVersion).toBeUndefined();
    expect(
      isSubscriptionEligibleForPushDelivery({
        lastSeenAt: row?.lastSeenAt ?? 0,
        pushSwVersion: row?.pushSwVersion,
      }),
    ).toBe(false);
  });

  it("touchPushSubscription no-ops when pushSwVersion is omitted", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);
    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      const row = rows[0];
      if (!row) throw new Error("missing row");
      await ctx.db.patch(row._id, { lastSeenAt: 1_000 });
    });
    expect(
      await t.mutation(api.pushSubscriptions.touchPushSubscription, {
        endpoint: VALID.endpoint,
      }),
    ).toEqual({ touched: false });
    const after = await t.run((ctx) => listPushSubscriptionsForUser(ctx, owner._id));
    expect(after[0]?.lastSeenAt).toBe(1_000);
  });

  it.each([
    { endpoint: `https://fcm.googleapis.com/fcm/send/${"x".repeat(4096)}` },
    { p256dh: "x".repeat(129) },
    { auth: "x".repeat(129) },
    { vapidKeyId: "x".repeat(129) },
    { vapidKeyId: " " },
    { endpoint: "https://user:password@fcm.googleapis.com/a" },
    { endpoint: "https://127.0.0.1/push" },
    { endpoint: "https://localhost/push" },
  ])(
    "rejects oversized or unusable material on every public binding path: case %#",
    async (invalid) => {
      const t = convexTest(schema, modules);
      const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
      signInAs(owner);
      const material = { ...VALID, ...invalid };
      await expect(
        t.mutation(api.pushSubscriptions.enablePushSubscription, material),
      ).rejects.toThrow("Invalid push subscription");
      await expect(
        t.mutation(api.pushSubscriptions.reconcilePushSubscription, { subscription: material }),
      ).rejects.toThrow("Invalid push subscription");
      await expect(
        t.mutation(api.pushSubscriptions.replacePushSubscription, {
          ...material,
          previousEndpoint: VALID.endpoint,
        }),
      ).rejects.toThrow("Invalid push subscription");
      expect(await t.run((ctx) => listPushSubscriptionsForUser(ctx, owner._id))).toEqual([]);
    },
  );

  it("rebinds an endpoint from another User without inheriting their pushSwVersion", async () => {
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: VALID.endpoint,
        lastSeenAt: 1000,
        pushSwVersion: 2,
      }),
    );

    signInAs(bob);
    const { pushSwVersion: _omit, ...legacy } = VALID;
    await t.mutation(api.pushSubscriptions.enablePushSubscription, {
      ...legacy,
      p256dh: TEST_PUSH_P256DH_ALT,
      auth: TEST_PUSH_AUTH_ALT,
    });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(0);
      const bobRows = await listPushSubscriptionsForUser(ctx, bob._id);
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0]?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
      expect(bobRows[0]?.pushSwVersion).toBeUndefined();
      expect(
        isSubscriptionEligibleForPushDelivery({
          lastSeenAt: bobRows[0]?.lastSeenAt ?? 0,
          pushSwVersion: bobRows[0]?.pushSwVersion,
        }),
      ).toBe(false);
    });
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
      p256dh: TEST_PUSH_P256DH_ALT,
      auth: TEST_PUSH_AUTH_ALT,
    });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(0);
      const bobRows = await listPushSubscriptionsForUser(ctx, bob._id);
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0]?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
      expect(bobRows[0]?.auth).toBe(TEST_PUSH_AUTH_ALT);
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
      p256dh: TEST_PUSH_P256DH_ALT,
      auth: TEST_PUSH_AUTH_ALT,
    });

    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
      expect(rows[0]?.lastSeenAt).toBeGreaterThan(firstSeen ?? 0);
    });
  });

  it("reconcile refreshes lastSeenAt only when the current User already owns the endpoint", async () => {
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
      // Cross-User reconcile must not steal Alice's binding — explicit enable only.
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(1);
      expect(await listPushSubscriptionsForUser(ctx, bob._id)).toHaveLength(0);
    });

    signInAs(alice);
    const refreshed = await t.mutation(api.pushSubscriptions.reconcilePushSubscription, {
      subscription: {
        ...VALID,
        p256dh: TEST_PUSH_P256DH_ALT,
        auth: TEST_PUSH_AUTH_ALT,
      },
    });
    expect(refreshed).toEqual({ bound: true });

    await t.run(async (ctx) => {
      const aliceRows = await listPushSubscriptionsForUser(ctx, alice._id);
      expect(aliceRows).toHaveLength(1);
      expect(aliceRows[0]?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
      expect(aliceRows[0]?.lastSeenAt).toBe(Date.parse("2026-03-02T00:00:00Z"));
    });
  });

  it("replace migrates a refreshed endpoint only when previous is owned", async () => {
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/old",
      }),
    );

    signInAs(bob);
    expect(
      await t.mutation(api.pushSubscriptions.replacePushSubscription, {
        previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
        ...VALID,
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
      }),
    ).toEqual({ bound: false });

    signInAs(alice);
    expect(
      await t.mutation(api.pushSubscriptions.replacePushSubscription, {
        previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
        ...VALID,
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
      }),
    ).toEqual({ bound: true });

    await t.run(async (ctx) => {
      expect(await listPushSubscriptionsForUser(ctx, alice._id)).toHaveLength(1);
      expect((await listPushSubscriptionsForUser(ctx, alice._id))[0]?.endpoint).toBe(
        "https://fcm.googleapis.com/fcm/send/new",
      );
    });
  });

  it("replace preserves subscription row id so in-flight sends keep resolving", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    const oldId = await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/old",
      }),
    );
    await t.mutation(api.pushSubscriptions.replacePushSubscription, {
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
      ...VALID,
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(oldId);
      expect(row?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/new");
      expect(row?.p256dh).toBe(VALID.p256dh);
    });
  });

  it("replace consolidate onto an existing next row keeps the previous id", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    const previousId = await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/old",
      }),
    );
    const nextId = await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        p256dh: TEST_PUSH_P256DH_ALT,
        auth: TEST_PUSH_AUTH_ALT,
      }),
    );
    await t.mutation(api.pushSubscriptions.replacePushSubscription, {
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
      ...VALID,
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(nextId)).toBeNull();
      const row = await ctx.db.get(previousId);
      expect(row?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/new");
      expect(row?.p256dh).toBe(VALID.p256dh);
      expect(await listPushSubscriptionsForUser(ctx, owner._id)).toHaveLength(1);
    });
  });

  it("replace refuses a next endpoint owned by another User", async () => {
    const t = convexTest(schema, modules);
    const alice = await t.run((ctx) => makeUser(ctx, "alice@example.com", "Alice"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    await t.run(async (ctx) => {
      await seedPushSubscription(ctx, {
        userId: alice._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/alice-old",
      });
      await seedPushSubscription(ctx, {
        userId: bob._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/bob",
      });
    });

    signInAs(alice);
    expect(
      await t.mutation(api.pushSubscriptions.replacePushSubscription, {
        previousEndpoint: "https://fcm.googleapis.com/fcm/send/alice-old",
        ...VALID,
        endpoint: "https://fcm.googleapis.com/fcm/send/bob",
      }),
    ).toEqual({ bound: false });

    await t.run(async (ctx) => {
      expect((await listPushSubscriptionsForUser(ctx, alice._id))[0]?.endpoint).toBe(
        "https://fcm.googleapis.com/fcm/send/alice-old",
      );
      expect((await listPushSubscriptionsForUser(ctx, bob._id))[0]?.endpoint).toBe(
        "https://fcm.googleapis.com/fcm/send/bob",
      );
    });
  });

  it("reconcile with null does not wipe other device subscriptions", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => makeUser(ctx, "a@example.com", "A"));
    signInAs(owner);
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: owner._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/other-device",
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
          endpoint: `https://fcm.googleapis.com/fcm/send/old-${i}`,
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
      expect(rows.some((r) => r.endpoint === "https://fcm.googleapis.com/fcm/send/old-0")).toBe(
        false,
      );
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
          endpoint: `https://fcm.googleapis.com/fcm/send/cap-${i}`,
          lastSeenAt: 1000 + i,
        });
      }
    });

    await t.mutation(api.pushSubscriptions.enablePushSubscription, VALID);

    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, owner._id);
      expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
      expect(rows.some((r) => r.endpoint === "https://fcm.googleapis.com/fcm/send/cap-0")).toBe(
        false,
      );
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
        endpoint: "https://fcm.googleapis.com/fcm/send/bob-only",
      });
    });

    signInAs(alice);
    expect(
      await t.mutation(api.pushSubscriptions.disablePushSubscription, {
        endpoint: VALID.endpoint,
      }),
    ).toEqual({ removed: true });
    // Foreign endpoint — do not clear caller's pending retry handle.
    expect(
      await t.mutation(api.pushSubscriptions.disablePushSubscription, {
        endpoint: "https://fcm.googleapis.com/fcm/send/bob-only",
      }),
    ).toEqual({ removed: false });

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
        endpoint: "https://fcm.googleapis.com/fcm/send/mine-1",
      });
      await seedPushSubscription(ctx, {
        userId: deleting.userId,
        endpoint: "https://fcm.googleapis.com/fcm/send/mine-2",
      });
      await seedPushSubscription(ctx, {
        userId: other._id,
        endpoint: "https://fcm.googleapis.com/fcm/send/theirs",
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
