import { buildRef, MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { ConvexError } from "convex/values";
import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { seedFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { accountDeletionBlockerFields } from "./accountDeletionBlockers.js";
import schema from "./schema.js";

// createCategory/listCategories resolve access through guard.ts, which folds in
// `getCurrentUserOrNull` — backed by Better Auth and unrunnable under
// convex-test. We stub just that seam (as guard.test.ts does) and exercise the
// real handlers, db, indexes, and history writes against the simulated backend.
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

async function makeUser(
  ctx: MutationCtx,
  email: string,
  displayName: string,
): Promise<Doc<"users">> {
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    email,
    displayName,
    acceptedTermsVersion: "2026-05-01",
    acceptedPrivacyVersion: "2026-05-01",
    acceptedAt: now,
    analyticsOptOut: false,
    onboardingCompletedAt: now,
    createdAt: now,
  });
  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error("seed failed");
  }
  return user;
}

interface Seed {
  owner: Doc<"users">;
  circleId: Id<"circles">;
}

/** Seeds an active regular Circle with an owner Member. */
async function seedCircle(
  ctx: MutationCtx,
  opts: { archived?: boolean; kind?: "personal" | "regular" } = {},
): Promise<Seed> {
  const now = Date.now();
  const owner = await makeUser(ctx, "owner@example.com", "Olive Owner");
  const kind = opts.kind ?? "regular";
  const status = opts.archived ? "archived" : "active";
  const circleId = await ctx.db.insert("circles", {
    name: "Trip",
    kind,
    currency: "USD",
    color: "blue",
    mark: "T",
    ownerUserId: owner._id,
    status,
    setupCompletedAt: now,
    currencyLocked: false,
    ...accountDeletionBlockerFields({ kind, status, setupCompletedAt: now }, 1),
    createdAt: now,
  });
  await ctx.db.insert("members", {
    circleId,
    userId: owner._id,
    role: "owner",
    status: "active",
    displayName: owner.displayName,
    joinedAt: now,
  });
  return { owner, circleId };
}

/** Adds a Member (active or removed) to a Circle and returns the User. */
async function addMember(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  email: string,
  displayName: string,
  status: "active" | "removed" = "active",
): Promise<Doc<"users">> {
  const user = await makeUser(ctx, email, displayName);
  await ctx.db.insert("members", {
    circleId,
    userId: user._id,
    role: "member",
    status,
    displayName,
    joinedAt: Date.now(),
    ...(status === "removed" ? { removedAt: Date.now() } : {}),
  });
  return user;
}

const EXPENSE = { name: "Groceries", type: "expense", color: "green" } as const;

type T = TestConvex<typeof schema>;

/** Creates a Category through the real mutation AS `user` (CAT-2 scenarios switch
 * identities mid-test: the creator writes, then the Owner or a bystander acts). */
async function createCategoryAs(
  t: T,
  user: Doc<"users">,
  circleId: Id<"circles">,
  over: Partial<typeof EXPENSE> = {},
) {
  mockCurrentUser.mockResolvedValue(user);
  return await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE, ...over });
}

/** The full CAT-2 cast: an active Circle with its Owner, a non-owner Member who
 * creates a Category, and a second non-owner bystander Member. */
async function seedCategoryScenario(t: T, opts: { archivedCircle?: boolean } = {}) {
  const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
  const creator = await t.run((ctx) =>
    addMember(ctx, circleId, "creator@example.com", "Cleo Creator"),
  );
  const bystander = await t.run((ctx) =>
    addMember(ctx, circleId, "bystander@example.com", "Bo Bystander"),
  );
  const categoryId = await createCategoryAs(t, creator, circleId);
  if (opts.archivedCircle) {
    await t.run((ctx) => ctx.db.patch(circleId, { status: "archived", archivedAt: Date.now() }));
  }
  return { owner, creator, bystander, circleId, categoryId };
}

/** An entity's recorded history rows, oldest first. */
async function eventsFor(t: T, entityId: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("histories")
      .withIndex("by_entity", (q) => q.eq("entityId", entityId))
      .collect(),
  );
}

/** Flips the creator's membership row (removal / rejoin reactivates the SAME row). */
async function setMemberStatus(
  t: T,
  circleId: Id<"circles">,
  userId: Id<"users">,
  status: "active" | "removed",
) {
  await t.run(async (ctx) => {
    const member = await ctx.db
      .query("members")
      .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", userId))
      .unique();
    if (!member) {
      throw new Error("seed failed");
    }
    await ctx.db.patch(member._id, {
      status,
      ...(status === "removed" ? { removedAt: Date.now() } : { removedAt: undefined }),
    });
  });
}

describe("createCategory — happy path", () => {
  it("persists an active expense category with nameLower, creator, and a create event", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const categoryId = await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.name).toBe("Groceries");
      expect(category?.nameLower).toBe("groceries");
      expect(category?.type).toBe("expense");
      expect(category?.color).toBe("green");
      expect(category?.status).toBe("active");
      expect(category?.creatorUserId).toBe(owner._id);
    });
  });

  it("records the create event with a formatted color label and no raw ids", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const categoryId = await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });

    await t.run(async (ctx) => {
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", categoryId))
        .collect();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.action).toBe("created");
      expect(event?.actorMemberId).toBeTruthy();
      expect(event?.changes).toEqual([
        { field: "name", to: "Groceries" },
        { field: "color", to: "Green" }, // formatted label, not "green" id
        { field: "type", to: "expense" },
      ]);
      // No raw category/user id leaks into the frozen change text.
      for (const change of event?.changes ?? []) {
        expect(change.to).not.toBe(categoryId);
        expect(change.to).not.toBe(owner._id);
      }
    });
  });

  it("allows creating both an Expense and an Income category", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });
    await t.mutation(api.categories.createCategory, {
      circleId,
      name: "Salary",
      type: "income",
      color: "teal",
    });

    const expenses = await t.query(api.categories.listCategories, { circleId, type: "expense" });
    const incomes = await t.query(api.categories.listCategories, { circleId, type: "income" });
    expect(expenses?.map((c) => c.name)).toEqual(["Groceries"]);
    expect(incomes?.map((c) => c.name)).toEqual(["Salary"]);
  });
});

describe("createCategory — uniqueness (case-insensitive, includes archived)", () => {
  it("rejects an exact duplicate name of the same type", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });
    try {
      await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });
      expect.unreachable("expected duplicate create to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      if (error instanceof ConvexError) {
        expect(error.data).toEqual(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate));
      }
    }
  });

  it("rejects a case-only difference of the same type", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, {
      circleId,
      name: "Gas",
      type: "expense",
      color: "amber",
    });
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "gas",
        type: "expense",
        color: "red",
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
  });

  it("allows the same name across different types", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, {
      circleId,
      name: "Gas",
      type: "expense",
      color: "amber",
    });
    // "Gas" Income is a different Category from "Gas" Expense.
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "Gas",
        type: "income",
        color: "amber",
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects a name already held by an ARCHIVED category of the same type", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    // Seed an archived "Gas" directly (CAT-2 archives; here we plant the row).
    await t.run(async (ctx) => {
      await ctx.db.insert("categories", {
        circleId,
        name: "Gas",
        nameLower: "gas",
        type: "expense",
        color: "amber",
        creatorUserId: owner._id,
        status: "archived",
        createdAt: Date.now(),
        archivedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "GAS",
        type: "expense",
        color: "red",
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
  });

  it("isolates uniqueness per Circle (same name allowed in a different Circle)", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const otherCircleId = await t.run(async (ctx) => {
      const circle = await ctx.db.insert("circles", {
        name: "Other",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "O",
        ownerUserId: owner._id,
        status: "active",
        setupCompletedAt: Date.now(),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        circleId: circle,
        userId: owner._id,
        role: "owner",
        status: "active",
        displayName: owner.displayName,
        joinedAt: Date.now(),
      });
      return circle;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });
    await expect(
      t.mutation(api.categories.createCategory, { circleId: otherCircleId, ...EXPENSE }),
    ).resolves.toBeTruthy();
  });
});

describe("createCategory — input edges", () => {
  it("rejects an empty name", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "",
        type: "expense",
        color: "green",
      }),
    ).rejects.toThrow();
  });

  it("rejects a whitespace-only name", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "   ",
        type: "expense",
        color: "green",
      }),
    ).rejects.toThrow();
  });

  it("rejects a name over the max length", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "x".repeat(41),
        type: "expense",
        color: "green",
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid color", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, {
        circleId,
        name: "Gas",
        type: "expense",
        color: "chartreuse",
      }),
    ).rejects.toThrow();
  });

  it("trims the name before storing", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    const id = await t.mutation(api.categories.createCategory, {
      circleId,
      name: "  Dining  ",
      type: "expense",
      color: "green",
    });
    await t.run(async (ctx) => {
      const category = await ctx.db.get(id);
      expect(category?.name).toBe("Dining");
      expect(category?.nameLower).toBe("dining");
    });
  });
});

describe("createCategory — permission matrix", () => {
  it("allows the Owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).resolves.toBeTruthy();
  });

  it("allows a non-owner active Member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(member);
    const id = await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });
    await t.run(async (ctx) => {
      const category = await ctx.db.get(id);
      expect(category?.creatorUserId).toBe(member._id);
    });
  });

  it("denies a Removed Member", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).rejects.toThrow("Circle not found");
  });

  it("denies a non-member User", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).rejects.toThrow("Circle not found");
  });

  it("denies an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).rejects.toThrow("Circle not found");
  });

  it("allows a Member in a Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).resolves.toBeTruthy();
  });
});

describe("createCategory — lifecycle edges", () => {
  it("denies creation in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.createCategory, { circleId, ...EXPENSE }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });
});

describe("listCategories", () => {
  it("returns active categories of a type, newest first, with creator identity", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, {
      circleId,
      name: "Gas",
      type: "expense",
      color: "amber",
    });
    await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });

    const result = await t.query(api.categories.listCategories, { circleId, type: "expense" });
    expect(result?.map((c) => c.name)).toEqual(["Groceries", "Gas"]); // newest first
    expect(result?.[0]?.creator.displayName).toBe("Olive Owner");
  });

  it("excludes archived categories by default and includes them when asked", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const id = await t.mutation(api.categories.createCategory, { circleId, ...EXPENSE });

    expect(
      (await t.query(api.categories.listCategories, { circleId, type: "expense" }))?.length,
    ).toBe(1);

    // Archive it (CAT-2 will own this mutation; here we flip the row directly).
    await t.run((ctx) => ctx.db.patch(id, { status: "archived", archivedAt: Date.now() }));

    // Live-update relevance: the default list flips to empty once archived.
    expect(
      (await t.query(api.categories.listCategories, { circleId, type: "expense" }))?.length,
    ).toBe(0);
    expect(
      (
        await t.query(api.categories.listCategories, {
          circleId,
          type: "expense",
          includeArchived: true,
        })
      )?.length,
    ).toBe(1);
  });

  it("returns null for an inaccessible Circle (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(await t.query(api.categories.listCategories, { circleId, type: "expense" })).toBeNull();
  });

  it("returns null for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(null);
    expect(await t.query(api.categories.listCategories, { circleId, type: "expense" })).toBeNull();
  });

  it("resolves capability flags per viewer (creator / Owner / bystander)", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, bystander, circleId } = await seedCategoryScenario(t);

    const as = async (user: Doc<"users">) => {
      mockCurrentUser.mockResolvedValue(user);
      const list = await t.query(api.categories.listCategories, { circleId, type: "expense" });
      return list?.[0];
    };

    // The creator may field-edit and archive their own Category.
    expect(await as(creator)).toMatchObject({ canEditFields: true, canArchive: true });
    // The Owner may moderate (archive/restore) but NOT field-edit another's Category.
    expect(await as(owner)).toMatchObject({ canEditFields: false, canArchive: true });
    // A non-creator, non-owner Member may do neither.
    expect(await as(bystander)).toMatchObject({ canEditFields: false, canArchive: false });
  });
});

describe("updateCategory — happy path", () => {
  it("renames and recolors, updating nameLower and recording one edited event", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, {
      categoryId,
      name: "Food",
      color: "teal",
    });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.name).toBe("Food");
      expect(category?.nameLower).toBe("food");
      expect(category?.color).toBe("teal");
    });

    const events = await eventsFor(t, categoryId);
    expect(events).toHaveLength(2); // created + edited
    const edited = events[1];
    expect(edited?.action).toBe("edited");
    expect(edited?.changes).toEqual([
      { field: "name", from: "Groceries", to: "Food" },
      { field: "color", from: "Green", to: "Teal" }, // display labels, never raw ids
    ]);
  });

  it("records only the field that changed (name-only edit)", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, { categoryId, name: "Food" });

    const events = await eventsFor(t, categoryId);
    expect(events[1]?.changes).toEqual([{ field: "name", from: "Groceries", to: "Food" }]);
  });

  it("records only the field that changed (color-only edit)", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, { categoryId, color: "amber" });

    const events = await eventsFor(t, categoryId);
    expect(events[1]?.changes).toEqual([{ field: "color", from: "Green", to: "Amber" }]);
  });

  it("treats an unchanged submit as a no-op: no patch, no spurious history", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, {
      categoryId,
      name: "Groceries",
      color: "green",
    });

    expect(await eventsFor(t, categoryId)).toHaveLength(1); // only the create
  });

  it("allows a case-only rename of the SAME category and records it", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, { categoryId, name: "GROCERIES" });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.name).toBe("GROCERIES");
      expect(category?.nameLower).toBe("groceries");
    });
    const events = await eventsFor(t, categoryId);
    expect(events[1]?.changes).toEqual([{ field: "name", from: "Groceries", to: "GROCERIES" }]);
  });

  it("trims the new name before storing", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.updateCategory, { categoryId, name: "  Dining  " });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.name).toBe("Dining");
      expect(category?.nameLower).toBe("dining");
    });
  });
});

describe("updateCategory — permission matrix (creator-only field edits)", () => {
  it("denies the Owner renaming another member's category", async () => {
    const t = convexTest(schema, modules);
    const { owner, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Owner Rename" }),
    ).rejects.toThrow("Only the member who created this category can edit it");
  });

  it("denies the Owner recoloring another member's category", async () => {
    const t = convexTest(schema, modules);
    const { owner, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, color: "red" }),
    ).rejects.toThrow("Only the member who created this category can edit it");
  });

  it("denies a non-creator member", async () => {
    const t = convexTest(schema, modules);
    const { bystander, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(bystander);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Hijack" }),
    ).rejects.toThrow("Only the member who created this category can edit it");
  });

  it("denies a Removed creator, then allows them again after rejoin", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await setMemberStatus(t, circleId, creator._id, "removed");
    // Removed ≡ inaccessible: the same anti-enumeration throw as a missing Category.
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).rejects.toThrow("Category not found");

    // Rejoin reactivates the SAME member row; field-edit rights return (PRD 44).
    await setMemberStatus(t, circleId, creator._id, "active");
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).resolves.toBeTruthy();
  });

  it("denies a non-member and an unauthenticated caller with the same generic error", async () => {
    const t = convexTest(schema, modules);
    const { categoryId } = await seedCategoryScenario(t);

    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).rejects.toThrow("Category not found");

    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).rejects.toThrow("Category not found");
  });
});

describe("updateCategory — rename uniqueness", () => {
  it("rejects renaming into an existing active name of the same type", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    await createCategoryAs(t, creator, circleId, { name: "Gas", color: "amber" });
    mockCurrentUser.mockResolvedValue(creator);

    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Gas" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
  });

  it("rejects a case-only collision with ANOTHER category", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    await createCategoryAs(t, creator, circleId, { name: "Gas", color: "amber" });
    mockCurrentUser.mockResolvedValue(creator);

    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "GAS" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
  });

  it("rejects renaming into an ARCHIVED name (still reserved)", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    const archivedId = await createCategoryAs(t, creator, circleId, {
      name: "Gas",
      color: "amber",
    });
    await t.mutation(api.categories.archiveCategory, { categoryId: archivedId });

    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "gas" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
  });

  it("allows renaming to a free name and to a name held by the OTHER type", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    await createCategoryAs(t, creator, circleId, { name: "Refund", type: "income" });
    mockCurrentUser.mockResolvedValue(creator);

    // "Refund" is taken by an Income Category — a different uniqueness scope.
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Refund" }),
    ).resolves.toBeTruthy();
  });
});

describe("updateCategory — input edges and lifecycle", () => {
  it.each([
    ["empty name", { name: "" }],
    ["whitespace-only name", { name: "   " }],
    ["over-long name", { name: "x".repeat(41) }],
    ["invalid color", { color: "chartreuse" }],
  ])("rejects %s", async (_label, patch) => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, ...patch }),
    ).rejects.toThrow();
  });

  it("rejects edits in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t, { archivedCircle: true });
    mockCurrentUser.mockResolvedValue(creator);
    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects edits to an Archived Category (frozen until restored)", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });

    await expect(
      t.mutation(api.categories.updateCategory, { categoryId, name: "Food" }),
    ).rejects.toThrow("Archived categories can't be edited");
  });
});

describe("archiveCategory / restoreCategory — moderation", () => {
  it("lets the creator archive their own category and records the event", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await t.mutation(api.categories.archiveCategory, { categoryId });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.status).toBe("archived");
      expect(category?.archivedAt).toEqual(expect.any(Number));
    });
    const events = await eventsFor(t, categoryId);
    const archived = events[1];
    expect(archived?.action).toBe("archived");
    expect(archived?.changes).toEqual([]); // the lifecycle flip IS the event — no `to`
    expect(archived?.actorMemberId).toBeTruthy();
  });

  it("lets the Owner archive and restore ANY member's category, with the Owner as actor", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, async () => {
      await t.mutation(api.categories.archiveCategory, { categoryId });
      await t.mutation(api.categories.restoreCategory, { categoryId });
    });

    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.status).toBe("active");
      expect(category?.archivedAt).toBeUndefined();

      const ownerMember = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", owner._id))
        .unique();
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", categoryId))
        .collect();
      expect(events.map((event) => event.action)).toEqual(["created", "archived", "restored"]);
      expect(events[1]?.actorMemberId).toBe(ownerMember?._id);
      expect(events[2]?.actorMemberId).toBe(ownerMember?._id);

      const creatorMember = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", creator._id),
        )
        .unique();
      expect(creatorMember).toBeTruthy();
      const notifications = await listNotificationsForUser(ctx, creator._id);
      expect(notifications.filter((row) => row.type === "category.archived")).toHaveLength(1);
      expect(notifications.filter((row) => row.type === "category.restored")).toHaveLength(1);
    });
  });

  it("lets the creator restore their own archived category", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });
    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).resolves.toBeTruthy();
  });

  it("denies a non-creator, non-owner member both archive and restore", async () => {
    const t = convexTest(schema, modules);
    const { creator, bystander, categoryId } = await seedCategoryScenario(t);

    mockCurrentUser.mockResolvedValue(bystander);
    await expect(t.mutation(api.categories.archiveCategory, { categoryId })).rejects.toThrow(
      "Only the creator or the owner can archive this category",
    );

    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });

    mockCurrentUser.mockResolvedValue(bystander);
    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).rejects.toThrow(
      "Only the creator or the owner can restore this category",
    );
  });

  it("denies a Removed Member and a non-member with the generic error", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    await setMemberStatus(t, circleId, creator._id, "removed");
    mockCurrentUser.mockResolvedValue(creator);
    await expect(t.mutation(api.categories.archiveCategory, { categoryId })).rejects.toThrow(
      "Category not found",
    );

    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).rejects.toThrow(
      "Category not found",
    );
  });

  it("denies archive after removeMember flips the creator (MEM-5)", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, circleId, categoryId } = await seedCategoryScenario(t);
    const creatorMember = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", creator._id),
        )
        .unique();
      if (!row) {
        throw new Error("seed failed");
      }
      return row;
    });
    mockCurrentUser.mockResolvedValue(owner);
    await t.mutation(api.members.removeMember, {
      circleId,
      memberId: creatorMember._id,
    });

    mockCurrentUser.mockResolvedValue(creator);
    await expect(t.mutation(api.categories.archiveCategory, { categoryId })).rejects.toThrow(
      "Category not found",
    );
  });

  it("rejects a redundant archive and a redundant restore (no silent no-op)", async () => {
    const t = convexTest(schema, modules);
    const { creator, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).rejects.toThrow(
      "Category is not archived",
    );
    await t.mutation(api.categories.archiveCategory, { categoryId });
    await expect(t.mutation(api.categories.archiveCategory, { categoryId })).rejects.toThrow(
      "Category is already archived",
    );
  });

  it("rejects archive and restore in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });
    await t.run((ctx) => ctx.db.patch(circleId, { status: "archived", archivedAt: Date.now() }));

    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
    await t.run((ctx) => ctx.db.patch(categoryId, { status: "active" }));
    await expect(t.mutation(api.categories.archiveCategory, { categoryId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects a restore that would collide with a now-active same-name category", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });

    // CAT-1 reserves archived names, so plant the colliding active row directly —
    // the defensive re-check must still hold if the invariant is ever bypassed.
    await t.run(async (ctx) => {
      await ctx.db.insert("categories", {
        circleId,
        name: "groceries",
        nameLower: "groceries",
        type: "expense",
        color: "red",
        creatorUserId: creator._id,
        status: "active",
        createdAt: Date.now(),
      });
    });

    await expect(t.mutation(api.categories.restoreCategory, { categoryId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate),
    });
    await t.run(async (ctx) => {
      const category = await ctx.db.get(categoryId);
      expect(category?.status).toBe("archived"); // unchanged — the restore failed atomically
    });
  });

  it("flips the default list live: archived drops out, restore brings it back", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    const activeNames = async () =>
      (await t.query(api.categories.listCategories, { circleId, type: "expense" }))?.map(
        (category) => category.name,
      );

    expect(await activeNames()).toEqual(["Groceries"]);
    await t.mutation(api.categories.archiveCategory, { categoryId });
    expect(await activeNames()).toEqual([]);
    await t.mutation(api.categories.restoreCategory, { categoryId });
    expect(await activeNames()).toEqual(["Groceries"]);
  });
});

describe("listCategoryHistory", () => {
  it("returns the full lifecycle newest-first with actors, labels, and no raw ids", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, circleId, categoryId } = await seedCategoryScenario(t);

    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.updateCategory, { categoryId, name: "Food", color: "teal" });
    mockCurrentUser.mockResolvedValue(owner);
    await t.mutation(api.categories.archiveCategory, { categoryId });
    await t.mutation(api.categories.restoreCategory, { categoryId });

    // Any current Member may read Category History — the bystander's view works too,
    // but read as the creator here to also assert actor identity resolution.
    mockCurrentUser.mockResolvedValue(creator);
    const result = await t.query(api.categories.listCategoryHistory, {
      circleId,
      categoryId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page.map((event) => event.action)).toEqual([
      "restored",
      "archived",
      "edited",
      "created",
    ]);
    expect(result.page.map((event) => event.actor?.displayName)).toEqual([
      "Olive Owner",
      "Olive Owner",
      "Cleo Creator",
      "Cleo Creator",
    ]);
    const edited = result.page[2];
    expect(edited?.changes).toEqual([
      { field: "name", from: "Groceries", to: "Food" },
      { field: "color", from: "Green", to: "Teal" },
    ]);
    // No raw internal id ever appears in the frozen change values (PRD story 80).
    for (const event of result.page) {
      for (const change of event.changes) {
        expect(change.from ?? "").not.toMatch(/^[a-z0-9]{20,}/);
        expect(change.to ?? "").not.toMatch(/^[a-z0-9]{20,}/);
      }
    }
  });

  it("paginates at the source: a bounded first page and a cursor to the next", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    // created + 4 edits = 5 events, past a 2-item page.
    for (const name of ["A", "B", "C", "D"]) {
      await t.mutation(api.categories.updateCategory, { categoryId, name });
    }

    const first = await t.query(api.categories.listCategoryHistory, {
      circleId,
      categoryId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.categories.listCategoryHistory, {
      circleId,
      categoryId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(2);
    expect(second.page[0]?.id).not.toBe(first.page[0]?.id);
  });

  it("collapses missing, inaccessible, malformed, and wrong-Circle to the same empty page", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId, categoryId } = await seedCategoryScenario(t);
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const paginationOpts = { numItems: 10, cursor: null };

    // A non-member.
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(
      await t.query(api.categories.listCategoryHistory, { circleId, categoryId, paginationOpts }),
    ).toEqual(emptyPage);

    // Unauthenticated.
    mockCurrentUser.mockResolvedValue(null);
    expect(
      await t.query(api.categories.listCategoryHistory, { circleId, categoryId, paginationOpts }),
    ).toEqual(emptyPage);

    // Malformed ids (raw strings from the URL).
    mockCurrentUser.mockResolvedValue(creator);
    expect(
      await t.query(api.categories.listCategoryHistory, {
        circleId: "nonsense",
        categoryId: "garbage",
        paginationOpts,
      }),
    ).toEqual(emptyPage);

    // A category belonging to a DIFFERENT Circle than the URL's.
    const otherCircleId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("circles", {
        name: "Other",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "O",
        ownerUserId: creator._id,
        status: "active",
        setupCompletedAt: Date.now(),
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        circleId: id,
        userId: creator._id,
        role: "owner",
        status: "active",
        displayName: creator.displayName,
        joinedAt: Date.now(),
      });
      return id;
    });
    expect(
      await t.query(api.categories.listCategoryHistory, {
        circleId: otherCircleId,
        categoryId,
        paginationOpts,
      }),
    ).toEqual(emptyPage);
  });

  it("remains readable for an ARCHIVED category (history is a read surface)", async () => {
    const t = convexTest(schema, modules);
    const { creator, bystander, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });

    // Any current Member — even one with no edit/moderation rights — may read it.
    mockCurrentUser.mockResolvedValue(bystander);
    const result = await t.query(api.categories.listCategoryHistory, {
      circleId,
      categoryId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((event) => event.action)).toEqual(["archived", "created"]);
  });
});

/** Seeds Categories directly (bypassing the mutation) so filterCategories tests
 * control `createdAt`, status, and volume without dozens of mutation round-trips.
 * `createdAt` is the domain sort key and may diverge from `_creationTime` (Circle
 * Setup derives starter Categories with deliberate values) — these tests exploit
 * that to prove the index sorts on the domain field. */
async function seedCategories(
  t: T,
  circleId: Id<"circles">,
  creatorUserId: Id<"users">,
  rows: {
    name: string;
    type?: "expense" | "income";
    status?: "active" | "archived";
    createdAt: number;
  }[],
) {
  await t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert("categories", {
        circleId,
        name: row.name,
        nameLower: row.name.toLowerCase(),
        type: row.type ?? "expense",
        color: "green",
        creatorUserId,
        status: row.status ?? "active",
        createdAt: row.createdAt,
        ...(row.status === "archived" ? { archivedAt: row.createdAt + 1 } : {}),
      });
    }
  });
}

/** One filterCategories page as `user`, defaulting to a wide page. */
async function filterPage(
  t: T,
  user: Doc<"users"> | null,
  args: {
    circleId: Id<"circles">;
    type?: "all" | "expense" | "income";
    status?: "active" | "archived" | "all";
    query?: string;
    numItems?: number;
    cursor?: string | null;
  },
) {
  mockCurrentUser.mockResolvedValue(user);
  return await t.query(api.categories.filterCategories, {
    circleId: args.circleId,
    type: args.type ?? "expense",
    status: args.status ?? "all",
    ...(args.query !== undefined ? { query: args.query } : {}),
    paginationOpts: { numItems: args.numItems ?? 50, cursor: args.cursor ?? null },
  });
}

describe("filterCategories — name search (CAT-4)", () => {
  it("includes the canonical ref on each row for Category Detail links (issue #240)", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [{ name: "Groceries", createdAt: 1 }]);
    const page = await filterPage(t, owner, { circleId });
    const row = page.page[0];
    if (!row) {
      throw new Error("expected a category row");
    }
    expect(row.ref).toBe(buildRef("Groceries", row.id));
  });

  it("matches a substring of the name, case-insensitively, whitespace-normalized", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Groceries", createdAt: 1 },
      { name: "Weekly   Shop", createdAt: 2 },
      { name: "Rent", createdAt: 3 },
    ]);

    // Mid-word substring — a prefix-only scan would miss this (the slice's "ocer" case).
    const mid = await filterPage(t, owner, { circleId, query: "ocer" });
    expect(mid.page.map((c) => c.name)).toEqual(["Groceries"]);

    // Case-insensitive, and the QUERY side is normalized too (trim + collapse).
    const noisy = await filterPage(t, owner, { circleId, query: "  WEEKLY  shop " });
    expect(noisy.page.map((c) => c.name)).toEqual(["Weekly   Shop"]);
  });

  it("treats an empty or whitespace-only query as no text narrowing", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Groceries", createdAt: 1 },
      { name: "Rent", createdAt: 2 },
    ]);

    for (const query of [undefined, "", "   \t "]) {
      const result = await filterPage(t, owner, { circleId, query });
      expect(result.page.map((c) => c.name)).toEqual(["Rent", "Groceries"]);
    }
  });

  it("returns an empty page (not an error) when nothing matches", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [{ name: "Groceries", createdAt: 1 }]);

    const result = await filterPage(t, owner, { circleId, query: "zzz-no-such" });
    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
  });

  it("spans active and archived rows under status=all", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Gas Station", createdAt: 1 },
      { name: "Gas Heating", status: "archived", createdAt: 2 },
      { name: "Rent", createdAt: 3 },
    ]);

    const result = await filterPage(t, owner, { circleId, status: "all", query: "gas" });
    expect(result.page.map((c) => c.name)).toEqual(["Gas Heating", "Gas Station"]);
    expect(result.page.map((c) => c.status)).toEqual(["archived", "active"]);
  });

  it("matches the NAME only — never another text field", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx)); // owner "Olive Owner"
    await seedCategories(t, circleId, owner._id, [{ name: "Groceries", createdAt: 1 }]);

    // The creator's display name is resolvable text on the row's view, but the
    // search must not consult it.
    const result = await filterPage(t, owner, { circleId, query: "olive" });
    expect(result.page).toEqual([]);
  });
});

describe("filterCategories — lifecycle status (CAT-4)", () => {
  async function seedMixed(t: T) {
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Active Old", createdAt: 1 },
      { name: "Archived Old", status: "archived", createdAt: 2 },
      { name: "Active New", createdAt: 3 },
      { name: "Archived New", status: "archived", createdAt: 4 },
    ]);
    return { owner, circleId };
  }

  it("active returns only active rows", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await seedMixed(t);
    const result = await filterPage(t, owner, { circleId, status: "active" });
    expect(result.page.map((c) => c.name)).toEqual(["Active New", "Active Old"]);
  });

  it("archived returns only archived rows", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await seedMixed(t);
    const result = await filterPage(t, owner, { circleId, status: "archived" });
    expect(result.page.map((c) => c.name)).toEqual(["Archived New", "Archived Old"]);
  });

  it("all interleaves both statuses by createdAt", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await seedMixed(t);
    const result = await filterPage(t, owner, { circleId, status: "all" });
    expect(result.page.map((c) => c.name)).toEqual([
      "Archived New",
      "Active New",
      "Archived Old",
      "Active Old",
    ]);
  });

  it("scopes to the requested type", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Groceries", type: "expense", createdAt: 1 },
      { name: "Salary", type: "income", createdAt: 2 },
    ]);
    const result = await filterPage(t, owner, { circleId, type: "income" });
    expect(result.page.map((c) => c.name)).toEqual(["Salary"]);
  });

  it("reactivity: archiving a row drops it from status=active and flips it under all", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, circleId, categoryId } = await seedCategoryScenario(t);

    expect((await filterPage(t, owner, { circleId, status: "active" })).page).toHaveLength(1);

    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.archiveCategory, { categoryId });

    expect((await filterPage(t, owner, { circleId, status: "active" })).page).toHaveLength(0);
    const all = await filterPage(t, owner, { circleId, status: "all" });
    expect(all.page.map((c) => c.status)).toEqual(["archived"]);

    // Restore is symmetric.
    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.categories.restoreCategory, { categoryId });
    expect((await filterPage(t, owner, { circleId, status: "active" })).page).toHaveLength(1);
  });
});

describe("filterCategories — all types (issue #138)", () => {
  it("interleaves expense and income newest-first across the merge", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // Alternating types, ascending createdAt — the merge must order purely by
    // createdAt desc, NOT group by type (neither type index alone ranges both).
    await seedCategories(t, circleId, owner._id, [
      { name: "Groceries", type: "expense", createdAt: 1 },
      { name: "Salary", type: "income", createdAt: 2 },
      { name: "Rent", type: "expense", createdAt: 3 },
      { name: "Bonus", type: "income", createdAt: 4 },
    ]);

    const result = await filterPage(t, owner, { circleId, type: "all" });
    expect(result.page.map((c) => c.name)).toEqual(["Bonus", "Rent", "Salary", "Groceries"]);
    expect(result.page.map((c) => c.type)).toEqual(["income", "expense", "income", "expense"]);
  });

  it("honors the lifecycle scope per type under the merge (status=active drops archived)", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Active Expense", type: "expense", createdAt: 1 },
      { name: "Archived Income", type: "income", status: "archived", createdAt: 2 },
      { name: "Active Income", type: "income", createdAt: 3 },
    ]);

    const active = await filterPage(t, owner, { circleId, type: "all", status: "active" });
    expect(active.page.map((c) => c.name)).toEqual(["Active Income", "Active Expense"]);

    // status=all under the merge surfaces archived rows of either type, interleaved.
    const all = await filterPage(t, owner, { circleId, type: "all", status: "all" });
    expect(all.page.map((c) => c.name)).toEqual([
      "Active Income",
      "Archived Income",
      "Active Expense",
    ]);
  });

  it("applies the name search across both types under the merge", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [
      { name: "Gas Bill", type: "expense", createdAt: 1 },
      { name: "Gas Refund", type: "income", createdAt: 2 },
      { name: "Rent", type: "expense", createdAt: 3 },
    ]);

    const result = await filterPage(t, owner, { circleId, type: "all", query: "gas" });
    expect(result.page.map((c) => c.name)).toEqual(["Gas Refund", "Gas Bill"]);
  });

  it("paginates across the merged stream, keeping createdAt desc over page boundaries", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // 5 rows alternating type by createdAt; pages of 2 cut across the merge, and the
    // final (partial) page reports done — the same lifecycle the CAT-4 status tests assert.
    await seedCategories(
      t,
      circleId,
      owner._id,
      Array.from({ length: 5 }, (_, i) => ({
        name: `Cat ${i}`,
        type: i % 2 === 0 ? ("expense" as const) : ("income" as const),
        createdAt: i,
      })),
    );

    const first = await filterPage(t, owner, { circleId, type: "all", numItems: 2 });
    expect(first.page.map((c) => c.name)).toEqual(["Cat 4", "Cat 3"]);
    expect(first.isDone).toBe(false);

    const second = await filterPage(t, owner, {
      circleId,
      type: "all",
      numItems: 2,
      cursor: first.continueCursor,
    });
    expect(second.page.map((c) => c.name)).toEqual(["Cat 2", "Cat 1"]);

    const third = await filterPage(t, owner, {
      circleId,
      type: "all",
      numItems: 2,
      cursor: second.continueCursor,
    });
    expect(third.page.map((c) => c.name)).toEqual(["Cat 0"]);
    expect(third.isDone).toBe(true);
  });

  it("paginates same-createdAt rows across types without skipping or repeating either", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // Circle Setup can create both types in one millisecond. The later income
    // insert has the larger _creationTime and must be the first page.
    await seedCategories(t, circleId, owner._id, [
      { name: "Expense", type: "expense", createdAt: 100 },
      { name: "Income", type: "income", createdAt: 100 },
    ]);

    const first = await filterPage(t, owner, { circleId, type: "all", numItems: 1 });
    const second = await filterPage(t, owner, {
      circleId,
      type: "all",
      numItems: 1,
      cursor: first.continueCursor,
    });
    const third = await filterPage(t, owner, {
      circleId,
      type: "all",
      numItems: 1,
      cursor: second.continueCursor,
    });

    expect(first.page.map((category) => category.name)).toEqual(["Income"]);
    expect(second.page.map((category) => category.name)).toEqual(["Expense"]);
    expect(third.page).toEqual([]);
    expect(third.isDone).toBe(true);
  });
});

describe("filterCategories — pagination at the source (CAT-4)", () => {
  it("bounds the first page and continues from the cursor (status=all path)", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(
      t,
      circleId,
      owner._id,
      Array.from({ length: 7 }, (_, i) => ({
        name: `Cat ${i}`,
        status: i % 2 === 0 ? ("active" as const) : ("archived" as const),
        createdAt: i,
      })),
    );

    const first = await filterPage(t, owner, { circleId, status: "all", numItems: 3 });
    expect(first.page.map((c) => c.name)).toEqual(["Cat 6", "Cat 5", "Cat 4"]);
    expect(first.isDone).toBe(false);

    const second = await filterPage(t, owner, {
      circleId,
      status: "all",
      numItems: 3,
      cursor: first.continueCursor,
    });
    expect(second.page.map((c) => c.name)).toEqual(["Cat 3", "Cat 2", "Cat 1"]);

    const third = await filterPage(t, owner, {
      circleId,
      status: "all",
      numItems: 3,
      cursor: second.continueCursor,
    });
    expect(third.page.map((c) => c.name)).toEqual(["Cat 0"]);
    expect(third.isDone).toBe(true);
  });

  it("bounds and continues on the status-index path too", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // Archived rows interleaved — the status index must skip them at the source.
    await seedCategories(
      t,
      circleId,
      owner._id,
      Array.from({ length: 10 }, (_, i) => ({
        name: `Cat ${i}`,
        status: i % 2 === 0 ? ("active" as const) : ("archived" as const),
        createdAt: i,
      })),
    );

    const first = await filterPage(t, owner, { circleId, status: "active", numItems: 3 });
    expect(first.page.map((c) => c.name)).toEqual(["Cat 8", "Cat 6", "Cat 4"]);
    expect(first.isDone).toBe(false);

    const second = await filterPage(t, owner, {
      circleId,
      status: "active",
      numItems: 3,
      cursor: first.continueCursor,
    });
    expect(second.page.map((c) => c.name)).toEqual(["Cat 2", "Cat 0"]);
    expect(second.isDone).toBe(true);
  });

  it("fills filtered pages — no short page while further matches exist", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // 12 rows, every other one matches "match": a naive paginate-then-filter
    // would return ~1–2 matches per 3-row source page.
    await seedCategories(
      t,
      circleId,
      owner._id,
      Array.from({ length: 12 }, (_, i) => ({
        name: i % 2 === 0 ? `Match ${i}` : `Other ${i}`,
        createdAt: i,
      })),
    );

    const first = await filterPage(t, owner, { circleId, query: "match", numItems: 3 });
    expect(first.page.map((c) => c.name)).toEqual(["Match 10", "Match 8", "Match 6"]);
    expect(first.isDone).toBe(false);

    const second = await filterPage(t, owner, {
      circleId,
      query: "match",
      numItems: 3,
      cursor: first.continueCursor,
    });
    expect(second.page.map((c) => c.name)).toEqual(["Match 4", "Match 2", "Match 0"]);

    // The page filled exactly at the source's last row, so the stream only
    // learns it is exhausted on the next read: a final empty, done page —
    // never an empty page while further MATCHES exist.
    const third = await filterPage(t, owner, {
      circleId,
      query: "match",
      numItems: 3,
      cursor: second.continueCursor,
    });
    expect(third.page).toEqual([]);
    expect(third.isDone).toBe(true);
  });
});

describe("filterCategories — sort (CAT-4)", () => {
  it("orders by the domain createdAt desc, not insertion (_creationTime) order", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // Inserted oldest-last by _creationTime but with REVERSED domain createdAt:
    // the sort must follow createdAt (Circle Setup sets deliberate values).
    await seedCategories(t, circleId, owner._id, [
      { name: "Newest", createdAt: 300 },
      { name: "Middle", createdAt: 200 },
      { name: "Oldest", createdAt: 100 },
    ]);

    const result = await filterPage(t, owner, { circleId });
    expect(result.page.map((c) => c.name)).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("breaks createdAt ties by _creationTime desc, matching listCategories", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    // Same createdAt millisecond — the later insert (higher _creationTime) wins.
    await seedCategories(t, circleId, owner._id, [
      { name: "First Insert", createdAt: 100 },
      { name: "Second Insert", createdAt: 100 },
    ]);

    const filtered = await filterPage(t, owner, { circleId });
    expect(filtered.page.map((c) => c.name)).toEqual(["Second Insert", "First Insert"]);

    // Identical to the pre-pagination order the collected picker query keeps.
    mockCurrentUser.mockResolvedValue(owner);
    const collected = await t.query(api.categories.listCategories, {
      circleId,
      type: "expense",
      includeArchived: true,
    });
    expect(filtered.page.map((c) => c.name)).toEqual(collected?.map((c) => c.name));
  });

  it("keeps createdAt desc across page boundaries", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(
      t,
      circleId,
      owner._id,
      // Shuffled insertion order; createdAt is the authority.
      [40, 10, 50, 20, 30].map((createdAt) => ({ name: `Cat ${createdAt}`, createdAt })),
    );

    const first = await filterPage(t, owner, { circleId, numItems: 2 });
    const second = await filterPage(t, owner, {
      circleId,
      numItems: 2,
      cursor: first.continueCursor,
    });
    const third = await filterPage(t, owner, {
      circleId,
      numItems: 2,
      cursor: second.continueCursor,
    });
    expect([...first.page, ...second.page, ...third.page].map((c) => c.name)).toEqual([
      "Cat 50",
      "Cat 40",
      "Cat 30",
      "Cat 20",
      "Cat 10",
    ]);
  });
});

describe("filterCategories — access and anti-enumeration (CAT-4)", () => {
  const emptyPage = { page: [], isDone: true, continueCursor: "" };

  it("collapses non-member, unauthenticated, and missing Circle to the same empty page", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await seedCategories(t, circleId, owner._id, [{ name: "Groceries", createdAt: 1 }]);

    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    expect(await filterPage(t, stranger, { circleId })).toEqual(emptyPage);
    expect(await filterPage(t, null, { circleId })).toEqual(emptyPage);

    // A Circle that no longer exists is indistinguishable from an inaccessible one.
    await t.run(async (ctx) => {
      await ctx.db.delete(circleId);
    });
    expect(await filterPage(t, owner, { circleId })).toEqual(emptyPage);
  });

  it("a removed Member reads the same empty page", async () => {
    const t = convexTest(schema, modules);
    const { creator, circleId } = await seedCategoryScenario(t);
    await setMemberStatus(t, circleId, creator._id, "removed");
    expect(await filterPage(t, creator, { circleId })).toEqual(emptyPage);
  });

  it("an archived Circle still lists (read-only view keeps its Category Filter)", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    await seedCategories(t, circleId, owner._id, [{ name: "Groceries", createdAt: 1 }]);

    const result = await filterPage(t, owner, { circleId });
    expect(result.page.map((c) => c.name)).toEqual(["Groceries"]);
  });

  it("resolves capability flags per viewer, same contract as listCategories", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, bystander, circleId } = await seedCategoryScenario(t);

    const flagsAs = async (user: Doc<"users">) => {
      const result = await filterPage(t, user, { circleId });
      const row = result.page[0];
      return { canEditFields: row?.canEditFields, canArchive: row?.canArchive };
    };

    expect(await flagsAs(creator)).toEqual({ canEditFields: true, canArchive: true });
    expect(await flagsAs(owner)).toEqual({ canEditFields: false, canArchive: true });
    expect(await flagsAs(bystander)).toEqual({ canEditFields: false, canArchive: false });
  });
});

describe("getCategory — Category Detail (issue #240)", () => {
  it("returns detail with canonical ref for active and archived categories", async () => {
    const t = convexTest(schema, modules);
    const { owner, creator, circleId, categoryId } = await seedCategoryScenario(t);
    mockCurrentUser.mockResolvedValue(creator);

    const active = await t.query(api.categories.getCategory, {
      circleId,
      categoryId,
    });
    expect(active?.name).toBe("Groceries");
    expect(active?.ref).toBe(buildRef("Groceries", categoryId));
    expect(active?.canEditFields).toBe(true);

    await t.mutation(api.categories.archiveCategory, { categoryId });
    const archived = await t.query(api.categories.getCategory, {
      circleId,
      categoryId,
    });
    expect(archived?.status).toBe("archived");
    expect(archived?.ref).toBe(buildRef("Groceries", categoryId));

    mockCurrentUser.mockResolvedValue(owner);
    expect(await t.query(api.categories.getCategory, { circleId, categoryId })).not.toBeNull();
  });

  it("returns null for missing, malformed, inaccessible, and wrong-circle ids", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId, categoryId } = await seedCategoryScenario(t);
    const other = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    expect(await t.query(api.categories.getCategory, { circleId, categoryId: "!" })).toBeNull();
    expect(
      await t.query(api.categories.getCategory, {
        circleId,
        categoryId: "categories;missing",
      }),
    ).toBeNull();
    expect(
      await t.query(api.categories.getCategory, {
        circleId: other.circleId,
        categoryId,
      }),
    ).toBeNull();

    mockCurrentUser.mockResolvedValue(null);
    expect(await t.query(api.categories.getCategory, { circleId, categoryId })).toBeNull();
  });
});

describe("listRecentCategoryTransactions — Category Detail preview (issue #240)", () => {
  it("returns up to five transactions ordered by date then createdAt", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const older = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Older shop",
        date: "2026-05-01",
        categoryIds: [f.groceriesId],
        createdAt: 100,
      }),
    );
    const newer = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Newer shop",
        date: "2026-05-20",
        categoryIds: [f.groceriesId],
        createdAt: 200,
      }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Same date later create",
        date: "2026-05-20",
        categoryIds: [f.groceriesId],
        createdAt: 300,
      }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Other category",
        date: "2026-06-01",
        categoryIds: [f.diningId],
      }),
    );

    const recent = await t.query(api.categories.listRecentCategoryTransactions, {
      circleId: f.circleId,
      categoryId: f.groceriesId,
    });
    expect(recent.map((txn) => txn.title)).toEqual([
      "Same date later create",
      "Newer shop",
      "Older shop",
    ]);
    expect(recent.some((txn) => txn.id === older)).toBe(true);
    expect(recent.some((txn) => txn.id === newer)).toBe(true);
  });

  it("includes archived transactions and returns [] for anti-enumeration cases", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const archivedTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Archived txn",
        status: "archived",
        categoryIds: [f.groceriesId],
      }),
    );

    const recent = await t.query(api.categories.listRecentCategoryTransactions, {
      circleId: f.circleId,
      categoryId: f.groceriesId,
    });
    expect(recent.some((txn) => txn.id === archivedTxnId && txn.status === "archived")).toBe(true);

    expect(
      await t.query(api.categories.listRecentCategoryTransactions, {
        circleId: f.circleId,
        categoryId: "categories;missing",
      }),
    ).toEqual([]);
  });
});
