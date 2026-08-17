import { buildRef, comparisonWindowMonths, currentMonth } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  seedCircle,
  seedFixture,
  seedOwnedCircle,
  seedOwnedFixture,
  seedPersonalCircleOwner,
  seedPersonalFixture,
  seedTransaction,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
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

function monthStr(date: Date) {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
}

function thisMonthDay(day: number) {
  return `${monthStr(new Date())}-${day.toString().padStart(2, "0")}`;
}

async function insertExclusion(ctx: MutationCtx, userId: Id<"users">, circleId: Id<"circles">) {
  await ctx.db.insert("homeSummaryExclusions", {
    userId,
    circleId,
    excludedAt: Date.now(),
  });
}

describe("getHomeSummary", () => {
  it("rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    mockCurrentUser.mockResolvedValue(null);
    await expect(t.query(api.homeSummary.getHomeSummary, {})).rejects.toThrow("Not authenticated");
  });

  it("returns empty state for a user with no memberships", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", owner._id))
        .collect();
      for (const membership of memberships) {
        await ctx.db.patch(membership._id, { status: "removed", removedAt: Date.now() });
      }
    });
    mockCurrentUser.mockResolvedValue(owner);

    const result = await t.query(api.homeSummary.getHomeSummary, {});
    expect(result.availableCurrencies).toEqual([]);
    expect(result.includedCount).toBe(0);
    expect(result.availableCount).toBe(0);
    expect(result.series.length).toBeGreaterThan(0);
    expect(result.totals.incomeMinor).toBe(0);
    expect(result.circles).toEqual([]);
  });

  it("applies default range of 1 month", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    const result = await t.query(api.homeSummary.getHomeSummary, {});
    expect(result.range).toBe(1);
    expect(result.series).toHaveLength(1);
  });

  it.each([3, 6, 12] as const)("supports range=%s with that many month buckets", async (range) => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range });
    expect(result.range).toBe(range);
    expect(result.series).toHaveLength(range);
  });

  it("exact first/last month boundaries: includes first and last, excludes outside", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const endMonth = currentMonth(new Date());
    const months = comparisonWindowMonths(endMonth, 3);
    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    const beforeRange = comparisonWindowMonths(endMonth, 4)[0];
    if (!firstMonth || !lastMonth || !beforeRange) {
      throw new Error("expected a 3-month window");
    }

    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 100,
        date: `${firstMonth}-01`,
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 200,
        date: `${lastMonth}-28`,
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 999,
        date: `${beforeRange}-15`,
        paidByMemberId: fixture.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 3 });
    expect(result.totals.expenseMinor).toBe(300);
  });

  it("income/expense/net integer totals over whole selected range and same contribution/series", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const date = thisMonthDay(1);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 100,
        date,
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 200,
        date: thisMonthDay(2),
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 300,
        date: thisMonthDay(3),
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        type: "income",
        amountMinorUnits: 1000,
        date: thisMonthDay(4),
        paidByMemberId: fixture.ownerMemberId,
        categoryIds: [fixture.salaryId],
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });

    expect(result.totals).toEqual({ incomeMinor: 1000, expenseMinor: 600, netMinor: 400 });
    expect(result.series[0]).toMatchObject({
      incomeMinor: 1000,
      expenseMinor: 600,
      netMinor: 400,
    });
    expect(result.contributions[0]).toMatchObject({
      incomeMinor: 1000,
      expenseMinor: 600,
      netMinor: 400,
    });
  });

  it("aggregates Paid By current User across Personal and regular Circles of the same currency", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const regular = await t.run((ctx) => seedOwnedFixture(ctx, personal.owner, { name: "Trip" }));
    const date = thisMonthDay(15);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, personal, {
        amountMinorUnits: 1000,
        date,
        paidByMemberId: personal.ownerMemberId,
      });
      await seedTransaction(ctx, regular, {
        amountMinorUnits: 2000,
        date,
        paidByMemberId: regular.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(personal.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });

    expect(result.selectedCurrency).toBe("USD");
    expect(result.availableCurrencies).toEqual(["USD"]);
    expect(result.includedCount).toBe(2);
    expect(result.availableCount).toBe(2);
    expect(result.totals.expenseMinor).toBe(3000);
    expect(result.contributions).toHaveLength(2);
    expect(result.series[0]?.expenseMinor).toBe(3000);
  });

  it("another member recorded with user Paid By counts", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    const { memberId: otherMemberId } = await t.run((ctx) =>
      addMember(ctx, fixture.circleId, "other@x.com", "Other"),
    );

    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 750,
        date: thisMonthDay(10),
        recordedByMemberId: otherMemberId,
        paidByMemberId: fixture.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.totals.expenseMinor).toBe(750);
  });

  it("user recorded with another Paid By does NOT count for user", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    const { memberId: otherMemberId } = await t.run((ctx) =>
      addMember(ctx, fixture.circleId, "other@x.com", "Other"),
    );

    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 999,
        date: thisMonthDay(10),
        recordedByMemberId: fixture.ownerMemberId,
        paidByMemberId: otherMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.totals.expenseMinor).toBe(0);
  });

  it("only active transactions count (archived excluded)", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    const date = thisMonthDay(10);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 100,
        date,
        paidByMemberId: fixture.ownerMemberId,
      });
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 999,
        date,
        paidByMemberId: fixture.ownerMemberId,
        status: "archived",
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.totals.expenseMinor).toBe(100);
  });

  it("differently denominated circles never summed together", async () => {
    const t = convexTest(schema, modules);
    const usd = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const eur = await t.run((ctx) =>
      seedOwnedFixture(ctx, usd.owner, { name: "Euro Trip", currency: "EUR" }),
    );
    const date = thisMonthDay(10);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, usd, {
        amountMinorUnits: 100,
        date,
        paidByMemberId: usd.ownerMemberId,
      });
      await seedTransaction(ctx, eur, {
        amountMinorUnits: 9999,
        date,
        paidByMemberId: eur.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(usd.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { currency: "USD", range: 1 });
    expect(result.selectedCurrency).toBe("USD");
    expect(result.totals.expenseMinor).toBe(100);
    expect(result.availableCurrencies).toContain("EUR");
  });

  it("selected-range recent includes older selected month and exact order/bound", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const oldestMonth = comparisonWindowMonths(currentMonth(new Date()), 3)[0];
    if (!oldestMonth) {
      throw new Error("expected a 3-month window");
    }

    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await seedTransaction(ctx, fixture, {
          amountMinorUnits: 100 * (i + 1),
          date: `${oldestMonth}-${(i + 1).toString().padStart(2, "0")}`,
          paidByMemberId: fixture.ownerMemberId,
          createdAt: 1000 + i * 100,
        });
      }
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 3 });

    expect(result.recent).toHaveLength(5);
    const amounts = result.recent.map((row) => row.amountMinorUnits);
    expect(amounts[0]).toBe(600);
    expect(amounts[4]).toBe(200);
  });

  it("scope circles return ALL currencies with included/status/ref", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    const eur = await t.run((ctx) =>
      seedOwnedFixture(ctx, personal.owner, { name: "Euro Trip", currency: "EUR" }),
    );
    await t.run((ctx) => insertExclusion(ctx, personal.owner._id, eur.circleId));

    mockCurrentUser.mockResolvedValue(personal.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, {});

    expect(result.circles).toHaveLength(2);
    const personalCircle = result.circles.find((circle) => circle.id === personal.circleId);
    const eurCircle = result.circles.find((circle) => circle.id === eur.circleId);
    if (!personalCircle || !eurCircle) {
      throw new Error("expected both Circles in scope");
    }

    expect(personalCircle).toMatchObject({
      included: true,
      kind: "personal",
      currency: "USD",
      status: "active",
      ref: buildRef("Ada's Circle", personal.circleId),
    });
    expect(eurCircle).toMatchObject({
      included: false,
      kind: "regular",
      currency: "EUR",
      ref: buildRef("Euro Trip", eur.circleId),
    });
  });

  it("contributions have canonical circleRef", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 100,
        date: thisMonthDay(10),
        paidByMemberId: fixture.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.contributions[0]?.circleRef).toBe(buildRef("Trip", fixture.circleId));
  });

  it("recent transactions have circleRef, circleName, and transaction ref", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 100,
        date: thisMonthDay(10),
        paidByMemberId: fixture.ownerMemberId,
      });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    const txn = result.recent[0];
    if (!txn) {
      throw new Error("expected a recent Transaction");
    }
    expect(txn.circleName).toBe("Trip");
    expect(txn.circleRef).toBe(buildRef("Trip", fixture.circleId));
    expect(txn.ref).toEqual(expect.any(String));
  });

  it("exclusions remove every section (totals, series, contributions, recent)", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 500,
        date: thisMonthDay(10),
        paidByMemberId: fixture.ownerMemberId,
      });
      await insertExclusion(ctx, fixture.owner._id, fixture.circleId);
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.totals.expenseMinor).toBe(0);
    expect(result.series[0]?.expenseMinor).toBe(0);
    expect(result.contributions).toHaveLength(0);
    expect(result.recent).toHaveLength(0);
    expect(result.includedCount).toBe(0);
    expect(result.availableCount).toBe(1);
  });

  it("new Circles default included (no exclusion row = included)", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    await t.run((ctx) =>
      seedOwnedCircle(ctx, owner, { name: "Brand New", setupCompletedAt: Date.now() }),
    );

    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, {});
    expect(result.includedCount).toBe(2);
    expect(result.circles.find((circle) => circle.name === "Brand New")?.included).toBe(true);
  });

  it("removed membership means no data for that circle", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 500,
        date: thisMonthDay(10),
        paidByMemberId: fixture.ownerMemberId,
      });
      await ctx.db.patch(fixture.ownerMemberId, { status: "removed", removedAt: Date.now() });
    });

    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, {});
    expect(result.availableCount).toBe(0);
    expect(result.circles).toHaveLength(0);
    expect(result.totals.expenseMinor).toBe(0);
  });

  it("canonicalizes invalid currency to Personal Circle currency", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada", currency: "CAD" }),
    );
    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { currency: "INVALID" });
    expect(result.selectedCurrency).toBe("CAD");
  });

  it("canonicalizes unavailable currency to Personal Circle currency", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada", currency: "CAD" }),
    );
    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { currency: "GBP" });
    expect(result.selectedCurrency).toBe("CAD");
  });

  it("availableCurrencies includes excluded circles", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    await t.run(async (ctx) => {
      const seeded = await seedOwnedCircle(ctx, owner, {
        name: "Euro Trip",
        currency: "EUR",
        setupCompletedAt: Date.now(),
      });
      await insertExclusion(ctx, owner._id, seeded.circleId);
    });

    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, {});
    expect(result.availableCurrencies).toEqual(expect.arrayContaining(["EUR", "USD"]));
  });

  it("archived circles remain visible and their active Transactions still count", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD", archived: true }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 4400,
        date: thisMonthDay(10),
        paidByMemberId: fixture.ownerMemberId,
      });
    });
    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.availableCurrencies).toContain("USD");
    expect(result.availableCount).toBe(1);
    expect(result.includedCount).toBe(1);
    expect(result.totals.expenseMinor).toBe(4400);
    expect(result.circles[0]?.status).toBe("archived");
  });

  it("restoring an archived Circle keeps it included and does not drop history", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run((ctx) => seedFixture(ctx, { currency: "USD", archived: true }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        amountMinorUnits: 2200,
        date: thisMonthDay(8),
        paidByMemberId: fixture.ownerMemberId,
      });
      await ctx.db.patch(fixture.circleId, { status: "active", archivedAt: undefined });
    });
    mockCurrentUser.mockResolvedValue(fixture.owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 1 });
    expect(result.includedCount).toBe(1);
    expect(result.totals.expenseMinor).toBe(2200);
    expect(result.circles[0]?.status).toBe("active");
  });

  it("returns ordered zero-filled series for months with no transactions", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { range: 6 });
    expect(result.series).toHaveLength(6);
    for (const entry of result.series) {
      expect(entry).toMatchObject({ incomeMinor: 0, expenseMinor: 0, netMinor: 0 });
    }
    expect(result.series.map((entry) => entry.month)).toEqual(
      comparisonWindowMonths(currentMonth(new Date()), 6),
    );
  });

  it("includedCount/availableCount remain selected-currency counts", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada", currency: "USD" }),
    );
    await t.run((ctx) =>
      seedOwnedCircle(ctx, owner, {
        name: "Euro",
        currency: "EUR",
        setupCompletedAt: Date.now(),
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);
    const result = await t.query(api.homeSummary.getHomeSummary, { currency: "USD" });
    expect(result.includedCount).toBe(1);
    expect(result.availableCount).toBe(1);
    expect(result.circles).toHaveLength(2);
  });
});

describe("excludeCircle / includeCircle", () => {
  it("creates an exclusion row idempotently", async () => {
    const t = convexTest(schema, modules);
    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.homeSummary.excludeCircle, { circleId: personalCircleId });
    await t.mutation(api.homeSummary.excludeCircle, { circleId: personalCircleId });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("homeSummaryExclusions")
        .withIndex("by_user", (q) => q.eq("userId", owner._id))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("throws for non-member (inaccessible circle)", async () => {
    const t = convexTest(schema, modules);
    const { owner: user1 } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    const { circleId: otherCircle } = await t.run((ctx) => seedCircle(ctx));

    mockCurrentUser.mockResolvedValue(user1);
    await expect(
      t.mutation(api.homeSummary.excludeCircle, { circleId: otherCircle }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.homeSummary.excludeCircle, { circleId: personalCircleId }),
    ).rejects.toThrow("Not authenticated");
  });

  it("removes the exclusion row idempotently", async () => {
    const t = convexTest(schema, modules);
    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.homeSummary.excludeCircle, { circleId: personalCircleId });
    await t.mutation(api.homeSummary.includeCircle, { circleId: personalCircleId });
    await t.mutation(api.homeSummary.includeCircle, { circleId: personalCircleId });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("homeSummaryExclusions")
        .withIndex("by_user", (q) => q.eq("userId", owner._id))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("includeCircle throws for an inaccessible circle", async () => {
    const t = convexTest(schema, modules);
    const { owner: user1 } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    const { circleId: otherCircle } = await t.run((ctx) => seedCircle(ctx));

    mockCurrentUser.mockResolvedValue(user1);
    await expect(
      t.mutation(api.homeSummary.includeCircle, { circleId: otherCircle }),
    ).rejects.toThrow("Circle not found");
  });

  it("includeCircle rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@x.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.homeSummary.includeCircle, { circleId: personalCircleId }),
    ).rejects.toThrow("Not authenticated");
  });
});
