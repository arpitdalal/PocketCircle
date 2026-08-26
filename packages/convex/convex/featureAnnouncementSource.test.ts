import { buildRef } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedOwnedFixture, seedPersonalFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
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

const modules = import.meta.glob("./**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

async function signIn(t: TestCtx, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("missing user");
    mockCurrentUser.mockResolvedValue(user);
  });
}

beforeEach(() => {
  mockCurrentUser.mockReset();
});

describe("getFeatureAnnouncementSource", () => {
  it("returns null when the Circle has no active Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    await signIn(t, f.owner._id);

    const source = await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
      circleId: f.circleId,
    });
    expect(source).toBeNull();
  });

  it("selects the newest active Transaction by createdAt in a Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const olderId = await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Older", createdAt: 1_000, date: "2026-06-01" }),
    );
    const newerId = await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Newer", createdAt: 2_000, date: "2026-01-01" }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(olderId, { status: "archived", archivedAt: 3_000 });
    });
    await signIn(t, f.owner._id);

    const source = await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
      circleId: f.circleId,
    });
    expect(source).toEqual({
      circleRef: buildRef("Ada's Circle", f.circleId),
      transactionRef: buildRef("Newer", newerId),
    });
  });

  it("returns null for archived or setup-incomplete Circles", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const incomplete = await t.run((ctx) =>
      seedOwnedFixture(ctx, personal.owner, {
        name: "Incomplete",
        setupCompletedAt: null,
      }),
    );
    const archived = await t.run((ctx) =>
      seedOwnedFixture(ctx, personal.owner, {
        name: "Archived",
        archived: true,
      }),
    );
    await t.run((ctx) => seedTransaction(ctx, incomplete, { title: "Hidden incomplete" }));
    await t.run((ctx) => seedTransaction(ctx, archived, { title: "Hidden archived" }));
    await signIn(t, personal.owner._id);

    expect(
      await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
        circleId: incomplete.circleId,
      }),
    ).toBeNull();
    expect(
      await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
        circleId: archived.circleId,
      }),
    ).toBeNull();
  });

  it("returns null when the caller cannot access the Circle", async () => {
    const t = convexTest(schema, modules);
    const ownerFixture = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "owner@example.com",
        displayName: "Owner",
        onboarded: true,
      }),
    );
    const stranger = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "stranger@example.com",
        displayName: "Stranger",
        onboarded: true,
      }),
    );
    await t.run((ctx) => seedTransaction(ctx, ownerFixture, { title: "Secret" }));
    await signIn(t, stranger.owner._id);

    expect(
      await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
        circleId: ownerFixture.circleId,
      }),
    ).toBeNull();
  });

  it("picks the newest Transaction across eligible Home Circles", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const trip = await t.run((ctx) => seedOwnedFixture(ctx, personal.owner, { name: "Trip" }));
    await t.run((ctx) =>
      seedTransaction(ctx, personal, { title: "Personal old", createdAt: 1_000 }),
    );
    const tripTxn = await t.run((ctx) =>
      seedTransaction(ctx, trip, { title: "Trip newest", createdAt: 5_000 }),
    );
    await signIn(t, personal.owner._id);

    const source = await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {});
    expect(source).toEqual({
      circleRef: buildRef("Trip", trip.circleId),
      transactionRef: buildRef("Trip newest", tripTxn),
    });
  });

  it("excludes Circles the User left from Home selection", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const trip = await t.run((ctx) => seedOwnedFixture(ctx, personal.owner, { name: "Trip" }));
    const personalTxn = await t.run((ctx) =>
      seedTransaction(ctx, personal, { title: "Still mine", createdAt: 1_000 }),
    );
    await t.run((ctx) => seedTransaction(ctx, trip, { title: "Left behind", createdAt: 9_000 }));
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", trip.circleId).eq("userId", personal.owner._id),
        )
        .unique();
      if (!membership) throw new Error("missing membership");
      await ctx.db.patch(membership._id, { status: "removed", removedAt: Date.now() });
    });
    await signIn(t, personal.owner._id);

    const source = await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {});
    expect(source).toEqual({
      circleRef: buildRef("Ada's Circle", personal.circleId),
      transactionRef: buildRef("Still mine", personalTxn),
    });
  });

  it("becomes available after an eligible User records a usable Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    await signIn(t, f.owner._id);

    expect(
      await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
        circleId: f.circleId,
      }),
    ).toBeNull();

    const txnId = await t.run((ctx) => seedTransaction(ctx, f, { title: "First spend" }));
    await signIn(t, f.owner._id);

    expect(
      await t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {
        circleId: f.circleId,
      }),
    ).toEqual({
      circleRef: buildRef("Ada's Circle", f.circleId),
      transactionRef: buildRef("First spend", txnId),
    });
  });

  it("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.query(api.featureAnnouncementSource.getFeatureAnnouncementSource, {}),
    ).rejects.toThrow(/Not authenticated/i);
  });
});
