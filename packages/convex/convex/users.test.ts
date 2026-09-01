import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION, LIMITS } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedPersonalCircleOwner } from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { circleSetupFields } from "./circleSetup.js";
import { createUserWithPersonalCircle, setUserDisplayName, syncUserEmail } from "./model.js";
import schema from "./schema.js";

const { mockCurrentUser } = vi.hoisted(() => ({ mockCurrentUser: vi.fn() }));
vi.mock("./auth.js", () => ({
  getCurrentUserOrNull: mockCurrentUser,
  requireCurrentUser: async (ctx: unknown) => {
    const user = await mockCurrentUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return user;
  },
}));

// Tests the bootstrap invariant directly through the db helper, independent of
// the Better Auth component wiring (which `onCreateUser` calls in production).
const modules = import.meta.glob("./**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

/** Seeds an owner + Personal Circle and signs them in for authed mutations. */
async function seedOwner(t: TestCtx, opts: Parameters<typeof seedPersonalCircleOwner>[1]) {
  const seed = await t.run((ctx) => seedPersonalCircleOwner(ctx, opts));
  mockCurrentUser.mockResolvedValue(seed.owner);
  return seed;
}

/** Re-mocks auth after a mutation that may have changed the User row. */
async function signInOwner(t: TestCtx, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("missing user");
    }
    mockCurrentUser.mockResolvedValue(user);
  });
}

beforeEach(() => {
  mockCurrentUser.mockReset();
});

describe("createUserWithPersonalCircle", () => {
  it("creates the User and an always-solo Personal Circle owned by them", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    );

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.email).toBe("ada@example.com");
      expect(user?.onboardingCompletedAt).toBeNull();
      expect(user?.acceptedTermsVersion).toBe(CURRENT_TERMS_VERSION);
      expect(user?.acceptedPrivacyVersion).toBe(CURRENT_PRIVACY_VERSION);

      const circles = await ctx.db.query("circles").collect();
      expect(circles).toHaveLength(1);
      expect(circles[0]?.kind).toBe("personal");
      expect(circles[0]?.name).toBe("Ada's Circle");
      expect(circles[0]?.mark).toBe("AC");
      expect(circles[0]?.color).toBe("iris");
      expect(circles[0]?.ownerUserId).toBe(userId);
      expect(circles[0]?.setupCompletedAt).toBeTypeOf("number");
      expect(circles[0]?.personalNameCustomizedAt).toBeUndefined();

      const members = await ctx.db.query("members").collect();
      expect(members).toHaveLength(1);
      expect(members[0]?.role).toBe("owner");
      expect(members[0]?.userId).toBe(userId);

      const activation = await ctx.db
        .query("userActivation")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      expect(activation?.initializedAt).toBeTypeOf("number");
      expect(activation?.evidenceBackfilledAt).toBeTypeOf("number");
      expect(activation?.personalTransactionCreatedAt).toBeUndefined();
      expect(activation?.personalCategoryCreatedAt).toBeUndefined();
      expect(activation?.regularCircleCreatedAt).toBeUndefined();
      expect(activation?.sharedMemberJoinedAt).toBeUndefined();
      expect(activation?.dismissedAt).toBeUndefined();
    });
  });

  it("defaults to USD for an unsupported currency", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "grace@example.com",
        displayName: "Grace Hopper",
        currency: "XYZ",
      }),
    );
    await t.run(async (ctx) => {
      const circle = await ctx.db.query("circles").first();
      expect(circle?.currency).toBe("USD");
    });
  });

  it('names the Personal Circle "Personal Circle" with mark "PC" when the display name has no token', async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "emoji@example.com",
        displayName: "🦊",
      }),
    );
    await t.run(async (ctx) => {
      const circle = await ctx.db.query("circles").first();
      expect(circle?.name).toBe("Personal Circle");
      expect(circle?.mark).toBe("PC");
    });
  });

  it("bounds a provider-seeded display name to the profile invariant", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "long@example.com",
        displayName: "x".repeat(LIMITS.displayNameMax + 1),
      }),
    );

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.displayName).toHaveLength(LIMITS.displayNameMax);
      const circle = await ctx.db.query("circles").first();
      expect(circle?.name).toBe(`${"x".repeat(LIMITS.displayNameMax)}'s Circle`);
    });
  });

  it("stores email in canonical form", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "  Ada@Example.COM ",
        displayName: "Ada Lovelace",
      }),
    );

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.email).toBe("ada@example.com");
    });
  });
});

describe("setUserDisplayName", () => {
  it("mirrors a new display name onto the User and active members, leaving removed members frozen", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        image: "https://img/old.png",
      }),
    );

    const removedMemberId = await t.run(async (ctx) => {
      const now = Date.now();
      const activeCircle = await ctx.db.insert("circles", {
        name: "Team",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "T",
        ownerUserId: userId,
        creatorUserId: userId,
        status: "active",
        ...circleSetupFields(now),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: now,
      });
      await ctx.db.insert("members", {
        circleId: activeCircle,
        userId,
        role: "member",
        status: "active",
        displayName: "Ada Lovelace",
        image: "https://img/old.png",
        joinedAt: now,
      });
      const removedCircle = await ctx.db.insert("circles", {
        name: "Old Club",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "O",
        ownerUserId: userId,
        creatorUserId: userId,
        status: "active",
        ...circleSetupFields(now),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: now,
      });
      return await ctx.db.insert("members", {
        circleId: removedCircle,
        userId,
        role: "member",
        status: "removed",
        displayName: "Ada Lovelace",
        image: "https://img/old.png",
        joinedAt: now,
        removedAt: now,
      });
    });

    await t.run((ctx) => setUserDisplayName(ctx, userId, "Ada King"));

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.displayName).toBe("Ada King");
      expect(user?.image).toBe("https://img/old.png");

      const members = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const active = members.filter((m) => m.status === "active");
      expect(active).toHaveLength(2);
      for (const member of active) {
        expect(member.displayName).toBe("Ada King");
        expect(member.image).toBe("https://img/old.png");
      }

      const removed = await ctx.db.get(removedMemberId);
      expect(removed?.displayName).toBe("Ada Lovelace");
    });
  });

  it("no-ops for a User that has not been bootstrapped", async () => {
    const t = convexTest(schema, modules);
    const missing =
      "k0000000000000000000000000000000" as import("./_generated/dataModel.js").Id<"users">;
    const completed = await t.run(async (ctx) => {
      await setUserDisplayName(ctx, missing, "Nobody");
      return "ok";
    });
    expect(completed).toBe("ok");
  });
});

describe("syncUserEmail", () => {
  it("patches only the User email", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        image: "https://img/old.png",
      }),
    );

    await t.run((ctx) => syncUserEmail(ctx, userId, "Ada.King@Example.com"));

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.email).toBe("ada.king@example.com");
      expect(user?.displayName).toBe("Ada Lovelace");
      expect(user?.image).toBe("https://img/old.png");
    });
  });
});

describe("completeOnboarding", () => {
  it("marks onboarding complete, reconciles the Personal Circle, and records no history", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
    });

    await t.mutation(api.users.completeOnboarding, { displayName: "Ada King" });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.displayName).toBe("Ada King");
      expect(user?.onboardingCompletedAt).toBeTypeOf("number");
      expect(user?.analyticsEnabled).toBe(true);

      const circle = await ctx.db.query("circles").first();
      expect(circle?.name).toBe("Ada's Circle");
      expect(circle?.mark).toBe("AC");

      const ownerMembership = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      expect(ownerMembership?.displayName).toBe("Ada King");

      const history = await ctx.db.query("histories").collect();
      expect(history).toHaveLength(0);
    });
  });

  it("reconciles the Personal Circle even when the user owns other Circles", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("circles", {
        name: "Trip",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "T",
        ownerUserId: userId,
        creatorUserId: userId,
        status: "active",
        ...circleSetupFields(now),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: now,
      });
    });

    await t.mutation(api.users.completeOnboarding, { displayName: "Ada King" });

    await t.run(async (ctx) => {
      const personal = await ctx.db
        .query("circles")
        .withIndex("by_owner_and_kind", (q) => q.eq("ownerUserId", userId).eq("kind", "personal"))
        .first();
      expect(personal?.name).toBe("Ada's Circle");
    });
  });

  it("skips the Personal Circle rename when the confirmed name matches", async () => {
    const t = convexTest(schema, modules);
    await seedOwner(t, {
      email: "madonna@example.com",
      displayName: "Madonna",
    });

    await t.mutation(api.users.completeOnboarding, { displayName: "Madonna" });

    await t.run(async (ctx) => {
      const circle = await ctx.db.query("circles").first();
      expect(circle?.name).toBe("Madonna's Circle");
    });
  });

  it("rejects a second completion", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
    });

    await t.mutation(api.users.completeOnboarding, { displayName: "Ada Lovelace" });

    await signInOwner(t, userId);

    await expect(
      t.mutation(api.users.completeOnboarding, { displayName: "Ada Lovelace" }),
    ).rejects.toThrow(/already completed/i);
  });
});

describe("updateProfile", () => {
  it("updates the display name on active memberships and reconciles the Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    const removedMemberId = await t.run(async (ctx) => {
      const now = Date.now();
      const removedCircle = await ctx.db.insert("circles", {
        name: "Old Club",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "O",
        ownerUserId: userId,
        creatorUserId: userId,
        status: "active",
        ...circleSetupFields(now),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: now,
      });
      return await ctx.db.insert("members", {
        circleId: removedCircle,
        userId,
        role: "member",
        status: "removed",
        displayName: "Ada Lovelace",
        joinedAt: now,
        removedAt: now,
      });
    });

    await t.mutation(api.users.updateProfile, { displayName: "Bob Builder" });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.displayName).toBe("Bob Builder");

      const circle = await ctx.db.query("circles").first();
      expect(circle?.name).toBe("Bob's Circle");
      expect(circle?.mark).toBe("BC");

      const ownerMembership = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();
      expect(ownerMembership?.displayName).toBe("Bob Builder");

      const removed = await ctx.db.get(removedMemberId);
      expect(removed?.displayName).toBe("Ada Lovelace");

      const history = await ctx.db.query("histories").collect();
      expect(history).toHaveLength(0);
    });
  });

  it("leaves a customized Personal Circle name and mark unchanged", async () => {
    const t = convexTest(schema, modules);
    const { userId, personalCircleId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    await t.mutation(api.circles.renameCircle, {
      circleId: personalCircleId,
      name: "Vacation Fund",
    });

    await t.mutation(api.users.updateProfile, { displayName: "Bob Builder" });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.displayName).toBe("Bob Builder");

      const circle = await ctx.db.get(personalCircleId);
      expect(circle?.name).toBe("Vacation Fund");
      expect(circle?.mark).toBe("VF");
      expect(circle?.personalNameCustomizedAt).toBeTypeOf("number");

      const ownerMembership = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();
      expect(ownerMembership?.displayName).toBe("Bob Builder");
    });
  });

  it("does not stomp a customized name when the derived name matches", async () => {
    const t = convexTest(schema, modules);
    const { personalCircleId } = await seedOwner(t, {
      email: "bob@example.com",
      displayName: "Robert Builder",
      onboarded: true,
    });

    await t.mutation(api.circles.renameCircle, {
      circleId: personalCircleId,
      name: "Bob's Circle",
    });

    await t.mutation(api.users.updateProfile, { displayName: "Bob Builder" });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(personalCircleId);
      expect(circle?.name).toBe("Bob's Circle");
      expect(circle?.mark).toBe("BC");
    });
  });

  it("self-heals a stale mark when the derived name matches the current name", async () => {
    const t = convexTest(schema, modules);
    const { personalCircleId } = await seedOwner(t, {
      email: "bob@example.com",
      displayName: "Bob Builder",
      onboarded: true,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(personalCircleId, { mark: "XX" });
    });

    await t.mutation(api.users.updateProfile, { displayName: "Bob Builder" });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(personalCircleId);
      expect(circle?.name).toBe("Bob's Circle");
      expect(circle?.mark).toBe("BC");
    });
  });
});

describe("setAnalyticsEnabled", () => {
  it("defaults analyticsEnabled to true for a freshly bootstrapped User", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    );

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.analyticsEnabled).toBe(true);
    });
  });

  it("does not change an existing disabled preference through onboarding", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { analyticsEnabled: false });
    });
    await signInOwner(t, userId);

    await t.mutation(api.users.completeOnboarding, { displayName: "Ada Lovelace" });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.analyticsEnabled).toBe(false);
      expect(user?.onboardingCompletedAt).toBeTypeOf("number");
    });
  });

  it("persists opt-out and later opt-in", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    await t.mutation(api.users.setAnalyticsEnabled, { enabled: false });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.analyticsEnabled).toBe(false);
    });

    await signInOwner(t, userId);
    await t.mutation(api.users.setAnalyticsEnabled, { enabled: true });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.analyticsEnabled).toBe(true);
    });
  });

  it("exposes analyticsEnabled via getCurrentUser", async () => {
    const t = convexTest(schema, modules);
    await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    const view = await t.query(api.users.getCurrentUser, {});
    expect(view?.analyticsEnabled).toBe(true);
  });

  it("only patches analyticsEnabled", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    const before = await t.run(async (ctx) => ctx.db.get(userId));

    await t.mutation(api.users.setAnalyticsEnabled, { enabled: false });

    await t.run(async (ctx) => {
      const after = await ctx.db.get(userId);
      expect(after?.analyticsEnabled).toBe(false);
      expect(after?.email).toBe(before?.email);
      expect(after?.displayName).toBe(before?.displayName);
      expect(after?.onboardingCompletedAt).toBe(before?.onboardingCompletedAt);
    });
  });

  it("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.mutation(api.users.setAnalyticsEnabled, { enabled: true })).rejects.toThrow(
      /Not authenticated/i,
    );
  });
});

describe("acknowledgeFeatureAnnouncement", () => {
  it("treats a missing acknowledgment field as an empty list in the current-user view", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.acknowledgedFeatureAnnouncementIds).toBeUndefined();
    });

    const view = await t.query(api.users.getCurrentUser, {});
    expect(view?.acknowledgedFeatureAnnouncementIds).toEqual([]);
    expect(view?.createdAt).toBeTypeOf("number");
  });

  it("merges an allowed ID idempotently and preserves other IDs", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(userId, {
        acknowledgedFeatureAnnouncementIds: ["prior-campaign"],
      });
    });
    await signInOwner(t, userId);

    await t.mutation(api.users.acknowledgeFeatureAnnouncement, {
      announcementId: "duplicate-transaction",
    });
    await signInOwner(t, userId);
    await t.mutation(api.users.acknowledgeFeatureAnnouncement, {
      announcementId: "duplicate-transaction",
    });

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.acknowledgedFeatureAnnouncementIds).toEqual([
        "prior-campaign",
        "duplicate-transaction",
      ]);
    });

    const view = await t.query(api.users.getCurrentUser, {});
    expect(view?.acknowledgedFeatureAnnouncementIds).toEqual([
      "prior-campaign",
      "duplicate-transaction",
    ]);
  });

  it("rejects unknown IDs without mutating the User", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedOwner(t, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    });

    await expect(
      t.mutation(api.users.acknowledgeFeatureAnnouncement, {
        announcementId: "not-a-real-campaign",
      }),
    ).rejects.toThrow(/Unknown feature announcement/i);

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user?.acknowledgedFeatureAnnouncementIds).toBeUndefined();
    });
  });

  it("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.mutation(api.users.acknowledgeFeatureAnnouncement, {
        announcementId: "duplicate-transaction",
      }),
    ).rejects.toThrow(/Not authenticated/i);
  });
});
