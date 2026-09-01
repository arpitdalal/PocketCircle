import { LIMITS, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import {
  addMember,
  makeCategory,
  makeUser,
  markCircleSetupComplete,
  seedCircle,
  seedFixture,
  seedInvitation,
  seedInvitationEmailEvent,
  seedPersonalCircleOwner,
  seedTransaction,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import { circleSetupFields } from "./circleSetup.js";
import { categoryEntity, circleEntity, recordEvent } from "./history.js";
import { generateInvitationToken, hashInvitationToken } from "./invitationToken.js";
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

beforeEach(() => {
  mockCurrentUser.mockReset();
});

describe("completeCircleSetup", () => {
  it("lets the owner persist setup answers and create starter categories", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const result = await t.mutation(api.circles.completeCircleSetup, {
      circleId,
      answers: { purpose: "residence", residenceType: "leased" },
    });

    expect(result.createdCategoryIds).toHaveLength(10);
    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.currency).toBe("USD");
      expect(circle?.setupAnswers).toEqual({ purpose: "residence", residenceType: "leased" });
      expect(circle?.setupCompletedAt).toBeTypeOf("number");

      const categories = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_createdAt", (q) =>
          q.eq("circleId", circleId).eq("type", "expense"),
        )
        .collect();
      expect(categories.map((category) => category.name).sort()).toEqual([
        "Dining",
        "Education",
        "Entertainment",
        "Groceries",
        "Health",
        "Rent",
        "Shopping",
        "Transport",
        "Travel",
        "Utilities",
      ]);

      const circleEvents = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(circleEvents).toHaveLength(1);
      expect(circleEvents[0]?.action).toBe("setup_completed");
      expect(circleEvents[0]?.changes).toEqual([
        { field: "setup.purpose", to: "residence" },
        { field: "setup.residenceType", to: "leased" },
      ]);

      const rent = categories.find((category) => category.name === "Rent");
      expect(rent).toBeTruthy();
      const rentEvents = rent
        ? await ctx.db
            .query("histories")
            .withIndex("by_entity", (q) => q.eq("entityId", rent._id))
            .collect()
        : [];
      expect(rentEvents[0]?.changes).toContainEqual({ field: "name", to: "Rent" });
    });
  });

  it("seeds the nine shared starters when the owner finishes with default answers", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const result = await t.mutation(api.circles.completeCircleSetup, {
      circleId,
      answers: {},
    });

    expect(result.createdCategoryIds).toHaveLength(9);
    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.setupAnswers).toEqual({});
      expect(circle?.setupCompletedAt).toBeTypeOf("number");

      const categories = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_createdAt", (q) =>
          q.eq("circleId", circleId).eq("type", "expense"),
        )
        .collect();
      expect(categories.map((category) => category.name).sort()).toEqual([
        "Dining",
        "Education",
        "Entertainment",
        "Groceries",
        "Health",
        "Shopping",
        "Transport",
        "Travel",
        "Utilities",
      ]);

      const circleEvents = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(circleEvents).toHaveLength(1);
      expect(circleEvents[0]?.action).toBe("setup_completed");
      expect(circleEvents[0]?.changes).toEqual([]);
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.circles.completeCircleSetup, {
        circleId,
        answers: { purpose: "trip" },
      }),
    ).rejects.toThrow(/Only the owner/);
  });

  it("rejects an archived circle before writing answers or categories", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.completeCircleSetup, {
        circleId,
        answers: { purpose: "residence", residenceType: "owned" },
      }),
    ).rejects.toThrow(/archived/);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.setupAnswers).toBeUndefined();
      expect((await ctx.db.get(circleId))?.setupCompletedAt).toBeNull();
      expect(
        await ctx.db
          .query("categories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
    });
  });

  it("skips starter categories that collide with existing names", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await makeCategory(ctx, seed.circleId, {
        name: "groceries",
        type: "expense",
        creatorUserId: seed.owner._id,
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    const result = await t.mutation(api.circles.completeCircleSetup, {
      circleId,
      answers: { purpose: "trip" },
    });

    expect(result.createdCategoryIds).toHaveLength(8);
    await t.run(async (ctx) => {
      const groceries = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_name", (q) =>
          q.eq("circleId", circleId).eq("type", "expense").eq("nameLower", "groceries"),
        )
        .collect();
      expect(groceries).toHaveLength(1);
    });
  });

  it("still derives non-colliding categories after the currency is locked", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run(async (ctx) => {
      const seeded = await seedFixture(ctx, { setupCompletedAt: null });
      await seedTransaction(ctx, seeded);
      await ctx.db.patch(seeded.circleId, { currencyLocked: true });
      return seeded;
    });
    mockCurrentUser.mockResolvedValue(f.owner);

    const result = await t.mutation(api.circles.completeCircleSetup, {
      circleId: f.circleId,
      answers: { purpose: "residence", residenceType: "owned" },
    });

    expect(result.createdCategoryIds).toHaveLength(8);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(f.circleId))?.currency).toBe("USD");
      const mortgage = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_name", (q) =>
          q.eq("circleId", f.circleId).eq("type", "expense").eq("nameLower", "mortgage"),
        )
        .first();
      expect(mortgage?.name).toBe("Mortgage");
    });
  });

  it("rejects reruns so setup-derived category sets cannot be mixed", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.completeCircleSetup, {
      circleId,
      answers: { purpose: "residence", residenceType: "leased" },
    });

    await expect(
      t.mutation(api.circles.completeCircleSetup, {
        circleId,
        answers: { purpose: "residence", residenceType: "owned" },
      }),
    ).rejects.toThrow(/already complete/);

    await t.run(async (ctx) => {
      const categories = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_createdAt", (q) =>
          q.eq("circleId", circleId).eq("type", "expense"),
        )
        .collect();
      expect(categories.map((category) => category.name).sort()).toContain("Rent");
      expect(categories.map((category) => category.name).sort()).not.toContain("Mortgage");
      expect((await ctx.db.get(circleId))?.setupAnswers).toEqual({
        purpose: "residence",
        residenceType: "leased",
      });
      expect((await ctx.db.get(circleId))?.setupCompletedAt).toBeTypeOf("number");
    });
  });
});

describe("updateCircleSettings", () => {
  it("lets the owner change color and setup answers in one settings_changed event", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      const now = Date.now();
      await ctx.db.patch(seed.circleId, {
        setupAnswers: { purpose: "trip" },
        ...circleSetupFields(now),
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.updateCircleSettings, {
      circleId,
      color: "green",
      setupAnswers: { purpose: "residence", residenceType: "leased" },
    });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.color).toBe("green");
      expect(circle?.mark).toBe("T");
      expect(circle?.setupAnswers).toEqual({ purpose: "residence", residenceType: "leased" });

      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("settings_changed");
      expect(events[0]?.changes).toEqual([
        { field: "color", from: "Blue", to: "Green" },
        { field: "setup.purpose", from: "trip", to: "residence" },
        { field: "setup.residenceType", to: "leased" },
      ]);
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "red" }),
    ).rejects.toThrow(/Only the owner/);
  });

  it("rejects a removed member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "gone@example.com", "Gone Member", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "red" }),
    ).rejects.toThrow();
  });

  it("rejects an archived circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "red" }),
    ).rejects.toThrow(/archived/);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.color).toBe("blue");
    });
  });

  it("rejects an invalid color id", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "chartreuse" }),
    ).rejects.toThrow();
  });

  it("rejects iris on a regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "iris" }),
    ).rejects.toThrow();
  });

  it("lets a Personal Circle owner select iris and records the palette label in history", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { kind: "personal", color: "green" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.updateCircleSettings, { circleId, color: "iris" });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.color).toBe("iris");

      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events.at(-1)?.changes).toEqual([{ field: "color", from: "Green", to: "Iris" }]);
    });
  });

  it("lets a bootstrapped Personal Circle owner restore iris after another palette color", async () => {
    const t = convexTest(schema, modules);

    const { owner, personalCircleId: circleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.color).toBe("iris");
    });

    await t.mutation(api.circles.updateCircleSettings, { circleId, color: "teal" });
    await t.mutation(api.circles.updateCircleSettings, { circleId, color: "iris" });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.color).toBe("iris");
    });
  });

  it("rejects setup-answer edits before setup is complete, but still allows color", async () => {
    const t = convexTest(schema, modules);
    // seedCircle leaves setup incomplete — setupCompletedAt is null.
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    // The first write of setup answers must go through completeCircleSetup (one-shot
    // starter seeding); this entry point must not flip the Circle to "setup done".
    await expect(
      t.mutation(api.circles.updateCircleSettings, {
        circleId,
        setupAnswers: { purpose: "trip" },
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    // A color-only edit is unaffected by the incomplete-setup state.
    await t.mutation(api.circles.updateCircleSettings, { circleId, color: "green" });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.setupAnswers).toBeUndefined();
      expect(circle?.setupCompletedAt).toBeNull();
      expect(circle?.color).toBe("green");
    });
  });

  it("lets a completed Circle with empty answers edit setup answers later", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.completeCircleSetup, { circleId, answers: {} });

    await t.mutation(api.circles.updateCircleSettings, {
      circleId,
      setupAnswers: { purpose: "trip" },
    });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.setupAnswers).toEqual({ purpose: "trip" });
      expect(circle?.setupCompletedAt).toBeTypeOf("number");
    });
  });

  it("no-ops when nothing changed", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      const now = Date.now();
      await ctx.db.patch(seed.circleId, {
        setupAnswers: { purpose: "trip" },
        ...circleSetupFields(now),
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.updateCircleSettings, {
      circleId,
      color: "blue",
      setupAnswers: { purpose: "trip" },
    });

    await t.run(async (ctx) => {
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events).toHaveLength(0);
    });
  });

  it("leaves existing categories untouched when setup answers change", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      const now = Date.now();
      await ctx.db.patch(seed.circleId, {
        setupAnswers: { purpose: "residence", residenceType: "leased" },
        ...circleSetupFields(now),
      });
      await makeCategory(ctx, seed.circleId, {
        name: "Rent",
        type: "expense",
        creatorUserId: seed.owner._id,
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.updateCircleSettings, {
      circleId,
      setupAnswers: { purpose: "residence", residenceType: "owned" },
    });

    await t.run(async (ctx) => {
      const categories = await ctx.db
        .query("categories")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      expect(categories).toHaveLength(1);
      expect(categories[0]?.name).toBe("Rent");
    });
  });
});

describe("renameCircle", () => {
  it("updates name, mark, and personalNameCustomizedAt on a Personal Circle", async () => {
    const t = convexTest(schema, modules);

    const { owner, personalCircleId: circleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.renameCircle, {
      circleId,
      name: "Vacation Fund",
    });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.name).toBe("Vacation Fund");
      expect(circle?.mark).toBe("VF");
      expect(circle?.personalNameCustomizedAt).toBeTypeOf("number");

      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("renamed");
      expect(events[0]?.changes).toEqual([
        { field: "name", from: "Ada's Circle", to: "Vacation Fund" },
      ]);
    });
  });

  it("updates the name but leaves mark and personalNameCustomizedAt unchanged on a regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.renameCircle, {
      circleId,
      name: "Summer Trip",
    });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.name).toBe("Summer Trip");
      expect(circle?.mark).toBe("T");
      expect(circle?.personalNameCustomizedAt).toBeUndefined();
    });
  });

  it("rejects an incomplete regular Circle without renaming", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.renameCircle, { circleId, name: "Summer Trip" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.name).toBe("Trip");
      const history = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(history).toHaveLength(0);
    });
  });

  it("rejects a name longer than the shared Circle-name limit", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.renameCircle, {
        circleId,
        name: "x".repeat(LIMITS.circleNameMax + 1),
      }),
    ).rejects.toThrow("Name is too long");

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.name).toBe("Trip");
    });
  });
});

describe("setCurrency", () => {
  it("lets the owner change currency before any Transaction", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { currency: "USD", setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.setCurrency, { circleId, currency: "EUR" });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.currency).toBe("EUR");
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("settings_changed");
      expect(events[0]?.changes).toEqual([{ field: "currency", from: "USD", to: "EUR" }]);
    });
  });

  it("no-ops when the currency is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { currency: "USD", setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.setCurrency, { circleId, currency: "USD" });

    await t.run(async (ctx) => {
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events).toHaveLength(0);
    });
  });

  it("rejects after the first Transaction with a coded currency.locked error", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const seeded = await seedFixture(ctx);
      await seedTransaction(ctx, seeded);
      return seeded;
    });
    mockCurrentUser.mockResolvedValue(fixture.owner);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId: fixture.circleId, currency: "EUR" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.currencyLocked),
    });
  });

  it("rejects when currencyLocked is false but a Transaction exists (defensive check)", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const seeded = await seedFixture(ctx);
      await seedTransaction(ctx, seeded);
      await ctx.db.patch(seeded.circleId, { currencyLocked: false });
      return seeded;
    });
    mockCurrentUser.mockResolvedValue(fixture.owner);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId: fixture.circleId, currency: "EUR" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.currencyLocked),
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId, currency: "EUR" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.currencyForbidden),
    });
  });

  it("rejects an archived circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId, currency: "EUR" }),
    ).rejects.toThrow(/archived/);
  });

  it("rejects an unsupported currency code", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId, currency: "XYZ" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.currencyUnsupported),
    });
  });

  it("rejects an incomplete regular Circle without changing currency", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { currency: "USD" }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.setCurrency, { circleId, currency: "EUR" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.currency).toBe("USD");
      const history = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(history).toHaveLength(0);
    });
  });
});

describe("setPersonalCircleNameAutoSync", () => {
  it("re-enables auto-sync and re-derives name + mark from the current Display Name", async () => {
    const t = convexTest(schema, modules);

    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.renameCircle, {
      circleId: personalCircleId,
      name: "Vacation Fund",
    });

    await t.mutation(api.users.updateProfile, { displayName: "Ada Marie" });
    mockCurrentUser.mockResolvedValue({ ...owner, displayName: "Ada Marie" });

    await t.mutation(api.circles.setPersonalCircleNameAutoSync, { enabled: true });

    const view = await t.query(api.circles.getCircle, { circleId: personalCircleId });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(personalCircleId);
      expect(circle?.personalNameCustomizedAt).toBeUndefined();
      expect(circle?.name).toBe("Ada's Circle");
      expect(circle?.mark).toBe("AC");
    });

    expect(view?.nameCustomized).toBe(false);
  });

  it("freezes the current name when auto-sync is turned off", async () => {
    const t = convexTest(schema, modules);

    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "bob@example.com",
        displayName: "Bob Builder",
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.setPersonalCircleNameAutoSync, { enabled: false });

    await t.mutation(api.users.updateProfile, { displayName: "Robert Builder" });
    mockCurrentUser.mockResolvedValue({ ...owner, displayName: "Robert Builder" });

    const view = await t.query(api.circles.getCircle, { circleId: personalCircleId });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(personalCircleId);
      expect(circle?.personalNameCustomizedAt).toBeTypeOf("number");
      expect(circle?.name).toBe("Bob's Circle");
      expect(circle?.mark).toBe("BC");
    });

    expect(view?.nameCustomized).toBe(true);
  });

  it("no-ops when the caller has no Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.setPersonalCircleNameAutoSync, { enabled: true });
  });

  it("derives nameCustomized false for auto-tracking personal circles and true after rename", async () => {
    const t = convexTest(schema, modules);

    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "carol@example.com",
        displayName: "Carol Danvers",
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);

    const autoView = await t.query(api.circles.getCircle, { circleId: personalCircleId });
    expect(autoView?.nameCustomized).toBe(false);

    await t.mutation(api.circles.renameCircle, {
      circleId: personalCircleId,
      name: "Hero Fund",
    });

    const customizedView = await t.query(api.circles.getCircle, { circleId: personalCircleId });
    expect(customizedView?.nameCustomized).toBe(true);
  });

  it("derives nameCustomized false for regular circles", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const view = await t.query(api.circles.getCircle, { circleId });
    expect(view?.nameCustomized).toBe(false);
  });
});

describe("renameCircle — archived circle", () => {
  it("rejects an archived circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.circles.renameCircle, { circleId, name: "Blocked" }),
    ).rejects.toThrow(/archived/);
  });
});

describe("archiveCircle", () => {
  it("archives a regular circle, revokes pending invites, and records history", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await markCircleSetupComplete(ctx, seed.circleId);
      await seedInvitation(ctx, seed.circleId, seed.owner._id, {
        email: "pending@example.com",
        status: "pending",
      });
      await seedInvitation(ctx, seed.circleId, seed.owner._id, {
        email: "accepted@example.com",
        status: "accepted",
      });
      return seed;
    });
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () => t.mutation(api.circles.archiveCircle, { circleId }));

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.status).toBe("archived");
      expect(circle?.archivedAt).toBeTypeOf("number");

      const invitations = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      expect(invitations.find((row) => row.emailLower === "pending@example.com")?.status).toBe(
        "revoked",
      );
      expect(invitations.find((row) => row.emailLower === "accepted@example.com")?.status).toBe(
        "accepted",
      );

      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events.at(-1)?.action).toBe("archived");
      expect(events.at(-1)?.changes).toEqual([]);

      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
      const memberNotifications = await listNotificationsForUser(ctx, member.user._id);
      expect(memberNotifications).toHaveLength(1);
      expect(memberNotifications[0]?.type).toBe("circle.archived");
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(t.mutation(api.circles.archiveCircle, { circleId })).rejects.toThrow(
      /Only the owner/,
    );
  });

  it("rejects a Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.archiveCircle, { circleId })).rejects.toThrow(
      /Personal Circles can't be archived/,
    );
  });

  it("rejects an already-archived circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.archiveCircle, { circleId })).rejects.toThrow(
      /already archived/,
    );
  });

  it("rejects a setup-incomplete circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.archiveCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.status).toBe("active");
      const history = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(history).toHaveLength(0);
    });
  });
});

describe("restoreCircle", () => {
  it("restores an archived circle, clears archivedAt, and leaves revoked invites revoked", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx, { archived: true, setupCompletedAt: Date.now() });
      await ctx.db.patch(seed.circleId, { archivedAt: Date.now() });
      await seedInvitation(ctx, seed.circleId, seed.owner._id, {
        email: "revoked@example.com",
        status: "revoked",
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.restoreCircle, { circleId });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.status).toBe("active");
      expect(circle?.archivedAt).toBeUndefined();

      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .first();
      expect(invite?.status).toBe("revoked");

      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(events.at(-1)?.action).toBe("restored");
      expect(events.at(-1)?.changes).toEqual([]);
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(t.mutation(api.circles.restoreCircle, { circleId })).rejects.toThrow(
      /Only the owner/,
    );
  });

  it("rejects an active circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.restoreCircle, { circleId })).rejects.toThrow(
      /not archived/,
    );
  });

  it("rejects restoring an incomplete archived regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { archived: true, setupCompletedAt: null }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.restoreCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.status).toBe("archived");
      const history = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", circleId))
        .collect();
      expect(history).toHaveLength(0);
    });
  });
});

describe("archiveCircle — read-only cascade", () => {
  it("blocks circle mutations after archive with circle.archived", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await markCircleSetupComplete(ctx, seed.circleId);
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.archiveCircle, { circleId });

    await expect(
      t.mutation(api.circles.renameCircle, { circleId, name: "Blocked" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });

    await expect(
      t.mutation(api.circles.updateCircleSettings, { circleId, color: "green" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });

    await expect(
      t.mutation(api.circles.completeCircleSetup, {
        circleId,
        answers: { purpose: "trip" },
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });
});

describe("circleHasTransactions", () => {
  it("returns false for an empty circle and true when any transaction exists", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(fixture.owner);

    await expect(
      t.query(api.circles.circleHasTransactions, { circleId: fixture.circleId }),
    ).resolves.toBe(false);

    await t.run((ctx) => seedTransaction(ctx, fixture));
    await expect(
      t.query(api.circles.circleHasTransactions, { circleId: fixture.circleId }),
    ).resolves.toBe(true);
  });

  it("returns null for inaccessible circles", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.query(api.circles.circleHasTransactions, { circleId })).resolves.toBeNull();
  });
});

describe("deleteCircle", () => {
  it("deletes a one-member zero-transaction circle and cascades dependent rows", async () => {
    const t = convexTest(schema, modules);
    const token = generateInvitationToken();
    let groceriesId: Awaited<ReturnType<typeof makeCategory>>;
    const { owner, circleId, ownerMemberId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      groceriesId = await makeCategory(ctx, seed.circleId, {
        name: "Groceries",
        creatorUserId: seed.owner._id,
      });
      const ownerMembership = await ctx.db.get(seed.ownerMemberId);
      await recordEvent(ctx, {
        entity: circleEntity(seed.circleId),
        actor: ownerMembership,
        action: "created",
        changes: [{ field: "name", to: "Trip" }],
      });
      await recordEvent(ctx, {
        entity: categoryEntity(groceriesId, seed.circleId),
        actor: ownerMembership,
        action: "created",
        changes: [{ field: "name", to: "Groceries" }],
      });
      const invitationId = await seedInvitation(ctx, seed.circleId, seed.owner._id, {
        email: "pending@example.com",
        status: "pending",
        tokenHash: await hashInvitationToken(token),
      });
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: seed.owner._id,
        circleId: seed.circleId,
        emailLower: "pending@example.com",
        kind: "create",
        sentAt: Date.now(),
      });
      await ctx.db.insert("e2eInvitationTokens", {
        circleId: seed.circleId,
        emailLower: "pending@example.com",
        invitationId,
        token,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("homeSummaryExclusions", {
        userId: seed.owner._id,
        circleId: seed.circleId,
        excludedAt: Date.now(),
      });
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.deleteCircle, { circleId });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(circleId)).toBeNull();
      expect(
        await ctx.db
          .query("members")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("categories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("invitations")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("e2eInvitationTokens")
          .withIndex("by_circle_and_email", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("homeSummaryExclusions")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("histories")
          .withIndex("by_entity", (q) => q.eq("entityId", circleId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("histories")
          .withIndex("by_entity", (q) => q.eq("entityId", groceriesId))
          .collect(),
      ).toHaveLength(0);

      const emailEvents = await ctx.db
        .query("invitationEmailEvents")
        .withIndex("by_circle_email_and_sentAt", (q) =>
          q.eq("circleId", circleId).eq("emailLower", "pending@example.com"),
        )
        .collect();
      expect(emailEvents).toHaveLength(1);

      expect(await ctx.db.get(ownerMemberId)).toBeNull();
    });

    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    mockCurrentUser.mockResolvedValue(ada);
    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
    });
  });

  it("allows deleting an archived empty circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.deleteCircle, { circleId });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(circleId)).toBeNull();
    });
  });

  it("rejects when any transaction exists, including archived", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx));
    await t.run((ctx) => seedTransaction(ctx, fixture, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(fixture.owner);

    await expect(
      t.mutation(api.circles.deleteCircle, { circleId: fixture.circleId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleDeleteNotEmpty),
    });
  });

  it("deletes when removed member rows exist but no active co-members", async () => {
    const t = convexTest(schema, modules);
    let removedMemberId: Awaited<ReturnType<typeof addMember>>["memberId"];
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      const removed = await addMember(
        ctx,
        seed.circleId,
        "removed@example.com",
        "Removed Member",
        "removed",
      );
      removedMemberId = removed.memberId;
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.circles.deleteCircle, { circleId });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(circleId)).toBeNull();
      expect(await ctx.db.get(removedMemberId)).toBeNull();
      expect(
        await ctx.db
          .query("members")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect(),
      ).toHaveLength(0);
    });
  });

  it("rejects when an active co-member exists", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await addMember(ctx, seed.circleId, "active@example.com", "Active Member", "active");
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.deleteCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleDeleteHasMembers),
    });
  });

  it("rejects a Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.circles.deleteCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleDeletePersonal),
    });
  });

  it("rejects a non-owner member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) =>
      addMember(ctx, circleId, "member@example.com", "Maya Member"),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(t.mutation(api.circles.deleteCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleDeleteForbidden),
    });
  });

  it("throws generic not-found for unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.mutation(api.circles.deleteCircle, { circleId })).rejects.toThrow(
      /circle\.unavailable/,
    );
  });

  it("throws generic not-found for non-members", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const outsider = await t.run((ctx) => makeUser(ctx, "outsider@example.com", "Outsider"));
    mockCurrentUser.mockResolvedValue(outsider);

    await expect(t.mutation(api.circles.deleteCircle, { circleId })).rejects.toThrow(
      /circle\.unavailable/,
    );
  });

  it("surfaces coded ConvexError payloads for user-facing rejections", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx));
    await t.run((ctx) => seedTransaction(ctx, fixture));
    mockCurrentUser.mockResolvedValue(fixture.owner);

    try {
      await t.mutation(api.circles.deleteCircle, { circleId: fixture.circleId });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
    }
  });
});

describe("listCircleHistory", () => {
  async function seedCircleHistoryScenario(t: ReturnType<typeof convexTest>) {
    const owner = await t.run((ctx) => makeUser(ctx, "owner@example.com", "Olive Owner"));
    mockCurrentUser.mockResolvedValue(owner);
    const circleId = await t.mutation(api.circles.createCircle, {
      name: "Trip",
      currency: "USD",
      color: "blue",
      mark: "T",
    });
    const maya = await t.run((ctx) => addMember(ctx, circleId, "maya@example.com", "Maya Member"));
    const bystander = await t.run((ctx) =>
      addMember(ctx, circleId, "bystander@example.com", "Bo Bystander"),
    );
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    return { owner, maya, bystander, circleId };
  }

  it("returns the full lifecycle newest-first with actors, labels, and no raw ids", async () => {
    const t = convexTest(schema, modules);
    const { owner, maya, bystander, circleId } = await seedCircleHistoryScenario(t);

    mockCurrentUser.mockResolvedValue(owner);
    await t.mutation(api.circles.renameCircle, { circleId, name: "Summer Trip" });
    await t.mutation(api.circles.setCurrency, { circleId, currency: "EUR" });
    await t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId });

    mockCurrentUser.mockResolvedValue(maya.user);
    await t.mutation(api.members.removeMember, { circleId, memberId: bystander.memberId });
    await t.mutation(api.circles.archiveCircle, { circleId });
    await t.mutation(api.circles.restoreCircle, { circleId });

    // Any current Member may read Circle History — a non-owner before removal would work too.
    mockCurrentUser.mockResolvedValue(maya.user);
    const result = await t.query(api.circles.listCircleHistory, {
      circleId,
      paginationOpts: { numItems: 20, cursor: null },
    });

    expect(result.page.map((event) => event.action)).toEqual([
      "restored",
      "archived",
      "member removed",
      "ownership transferred",
      "settings_changed",
      "renamed",
      "created",
    ]);
    expect(result.page.map((event) => event.actor?.displayName)).toEqual([
      "Maya Member",
      "Maya Member",
      "Maya Member",
      "Olive Owner",
      "Olive Owner",
      "Olive Owner",
      "Olive Owner",
    ]);
    const transferred = result.page[3];
    expect(transferred?.changes).toEqual([
      { field: "owner", from: "Olive Owner", to: "Maya Member" },
    ]);
    const removed = result.page[2];
    expect(removed?.changes).toEqual([{ field: "member", from: "Bo Bystander" }]);
    for (const event of result.page) {
      for (const change of event.changes) {
        expect(change.from ?? "").not.toMatch(/^[a-z0-9]{20,}/);
        expect(change.to ?? "").not.toMatch(/^[a-z0-9]{20,}/);
      }
    }
  });

  it("paginates at the source: a bounded first page and a cursor to the next", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await seedCircleHistoryScenario(t);
    mockCurrentUser.mockResolvedValue(owner);

    for (const name of ["A", "B", "C", "D"]) {
      await t.mutation(api.circles.renameCircle, { circleId, name });
    }

    const first = await t.query(api.circles.listCircleHistory, {
      circleId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.circles.listCircleHistory, {
      circleId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(2);
    expect(second.page[0]?.id).not.toBe(first.page[0]?.id);
  });

  it("collapses missing, inaccessible, malformed, and non-member to the same empty page", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await seedCircleHistoryScenario(t);
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const paginationOpts = { numItems: 10, cursor: null };

    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(await t.query(api.circles.listCircleHistory, { circleId, paginationOpts })).toEqual(
      emptyPage,
    );

    mockCurrentUser.mockResolvedValue(null);
    expect(await t.query(api.circles.listCircleHistory, { circleId, paginationOpts })).toEqual(
      emptyPage,
    );

    mockCurrentUser.mockResolvedValue(owner);
    expect(
      await t.query(api.circles.listCircleHistory, {
        circleId: "nonsense",
        paginationOpts,
      }),
    ).toEqual(emptyPage);
  });

  it("remains readable for an ARCHIVED circle (history is a read surface)", async () => {
    const t = convexTest(schema, modules);
    const { owner, maya, circleId } = await seedCircleHistoryScenario(t);
    mockCurrentUser.mockResolvedValue(owner);
    await t.mutation(api.circles.archiveCircle, { circleId });

    mockCurrentUser.mockResolvedValue(maya.user);
    const result = await t.query(api.circles.listCircleHistory, {
      circleId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((event) => event.action)).toContain("archived");
    expect(result.page.map((event) => event.action)).toContain("created");
  });

  it("lets a non-owner member read history", async () => {
    const t = convexTest(schema, modules);
    const { maya, circleId } = await seedCircleHistoryScenario(t);
    mockCurrentUser.mockResolvedValue(maya.user);
    const result = await t.query(api.circles.listCircleHistory, {
      circleId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.length).toBeGreaterThan(0);
    expect(result.page.at(-1)?.action).toBe("created");
  });

  describe("invitee email redaction (ADR 0028)", () => {
    const inviteeEmail = "ada@example.com";
    const paginationOpts = { numItems: 20, cursor: null };

    function createInvitationHistoryTest() {
      const t = convexTest(schema, modules);
      registerEmailWorkpool(t);
      return t;
    }

    function expectPageOmitsInviteeEmail(page: unknown, email: string) {
      expect(JSON.stringify(page)).not.toContain(email);
    }

    async function seedCircleReadyForInvites(t: ReturnType<typeof convexTest>) {
      const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
      await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
      const member = await t.run((ctx) =>
        addMember(ctx, circleId, "maya@example.com", "Maya Member"),
      );
      return { owner, member, circleId };
    }

    it("shows invitee email to the current Owner on member invited", async () => {
      const t = createInvitationHistoryTest();
      const { owner, circleId } = await seedCircleReadyForInvites(t);
      mockCurrentUser.mockResolvedValue(owner);
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.createInvitation, { circleId, email: inviteeEmail }),
      );

      const result = await t.query(api.circles.listCircleHistory, { circleId, paginationOpts });
      const invited = result.page.find((event) => event.action === "member invited");
      expect(invited).toBeDefined();
      expect(invited?.changes).toEqual([{ field: "email", to: inviteeEmail }]);
    });

    it("omits invitee email for a non-Owner member on member invited", async () => {
      const t = createInvitationHistoryTest();
      const { owner, member, circleId } = await seedCircleReadyForInvites(t);
      mockCurrentUser.mockResolvedValue(owner);
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.createInvitation, { circleId, email: inviteeEmail }),
      );

      mockCurrentUser.mockResolvedValue(member.user);
      const result = await t.query(api.circles.listCircleHistory, { circleId, paginationOpts });
      const invited = result.page.find((event) => event.action === "member invited");
      expect(invited).toBeDefined();
      expect(invited?.changes).toEqual([]);
      expectPageOmitsInviteeEmail(result.page, inviteeEmail);
    });

    it("omits invitee email for non-Owners across resent, revoked, and accepted invites", async () => {
      const t = createInvitationHistoryTest();
      const { owner, member, circleId } = await seedCircleReadyForInvites(t);
      mockCurrentUser.mockResolvedValue(owner);

      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.createInvitation, { circleId, email: inviteeEmail }),
      );
      const inviteId = await t.run(async (ctx) => {
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .first();
        if (!invite) {
          throw new Error("expected pending invitation");
        }
        return invite._id;
      });
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
      );

      const revokeEmail = "bob@example.com";
      const revokeInviteId = await t.run((ctx) =>
        seedInvitation(ctx, circleId, owner._id, { email: revokeEmail }),
      );
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.revokeInvitation, { invitationId: revokeInviteId }),
      );

      const ada = await t.run((ctx) => makeUser(ctx, inviteeEmail, "Ada Lovelace"));
      const acceptToken = await t.run(async (ctx) => {
        const invite = await ctx.db.get(inviteId);
        if (!invite) {
          throw new Error("expected invitation to accept");
        }
        const token = generateInvitationToken();
        await ctx.db.patch(inviteId, { tokenHash: await hashInvitationToken(token) });
        return token;
      });
      mockCurrentUser.mockResolvedValue(ada);
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.acceptInvitation, { token: acceptToken }),
      );

      mockCurrentUser.mockResolvedValue(member.user);
      const result = await t.query(api.circles.listCircleHistory, { circleId, paginationOpts });
      expect(result.page.map((event) => event.action)).toEqual(
        expect.arrayContaining([
          "member joined",
          "invitation revoked",
          "invitation resent",
          "member invited",
        ]),
      );
      for (const event of result.page) {
        expect(event.changes.every((change) => change.field !== "email")).toBe(true);
      }
      expectPageOmitsInviteeEmail(result.page, inviteeEmail);
      expectPageOmitsInviteeEmail(result.page, revokeEmail);
    });

    it("evaluates invitee email visibility against the current Owner after ownership transfer", async () => {
      const t = createInvitationHistoryTest();
      const { owner, member, circleId } = await seedCircleReadyForInvites(t);
      mockCurrentUser.mockResolvedValue(owner);
      await mutateAndDrain(t, () =>
        t.mutation(api.invitations.createInvitation, { circleId, email: inviteeEmail }),
      );

      await t.mutation(api.members.transferOwnership, {
        circleId,
        toMemberId: member.memberId,
      });

      mockCurrentUser.mockResolvedValue(member.user);
      const asOwner = await t.query(api.circles.listCircleHistory, { circleId, paginationOpts });
      const invitedForOwner = asOwner.page.find((event) => event.action === "member invited");
      expect(invitedForOwner?.changes).toEqual([{ field: "email", to: inviteeEmail }]);

      mockCurrentUser.mockResolvedValue(owner);
      const asFormerOwner = await t.query(api.circles.listCircleHistory, {
        circleId,
        paginationOpts,
      });
      const invitedForFormerOwner = asFormerOwner.page.find(
        (event) => event.action === "member invited",
      );
      expect(invitedForFormerOwner?.changes).toEqual([]);
      expectPageOmitsInviteeEmail(asFormerOwner.page, inviteeEmail);
    });
  });
});
