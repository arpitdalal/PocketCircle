import { currentMonth } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, makeCategory, makeUser, seedFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import { RECENT_TRANSACTIONS_LIMIT } from "./dashboard.js";
import { collectMonthActiveTransactions, sumMonthTotals } from "./monthActivity.js";
import schema from "./schema.js";

// getDashboard resolves access through guard.ts, which folds
// in `getCurrentUserOrNull` — backed by Better Auth and unrunnable under convex-test.
// We stub just that seam (as guard.test.ts does) and exercise the real handlers, db,
// indexes, totals math, and filter logic against the simulated backend.
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

describe("getDashboard — totals math", () => {
  it("sums income/expense and computes net in minor units for the selected month", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        type: "income",
        amountMinorUnits: 500_000,
        date: "2026-06-05",
        categoryIds: [f.salaryId],
      });
      await seedTransaction(ctx, f, { amountMinorUnits: 1250, date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 7500,
        date: "2026-06-20",
        categoryIds: [f.diningId],
      });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals).toEqual({
      incomeMinor: 500_000,
      expenseMinor: 8_750,
      netMinor: 491_250,
    });
    expect(dashboard?.currency).toBe("USD");
    expect(dashboard?.month).toBe("2026-06");
  });

  it("returns a negative net when expenses exceed income", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        type: "income",
        amountMinorUnits: 2_000,
        date: "2026-06-01",
        categoryIds: [f.salaryId],
      });
      await seedTransaction(ctx, f, { amountMinorUnits: 9_000, date: "2026-06-02" });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals).toEqual({
      incomeMinor: 2_000,
      expenseMinor: 9_000,
      netMinor: -7_000,
    });
  });

  it("returns zeros and an empty recent feed for a month with no transactions", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { date: "2026-05-15" }));

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-07",
    });
    expect(dashboard?.totals).toEqual({ incomeMinor: 0, expenseMinor: 0, netMinor: 0 });
    expect(dashboard?.recent).toEqual([]);
  });

  it("excludes archived transactions from totals (TXN-3 contract)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 1_000, date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 9_999,
        date: "2026-06-11",
        status: "archived",
      });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals).toEqual({ incomeMinor: 0, expenseMinor: 1_000, netMinor: -1_000 });
  });

  it("counts only the selected month, ignoring neighbouring months", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 100, date: "2026-05-31" });
      await seedTransaction(ctx, f, { amountMinorUnits: 200, date: "2026-06-15" });
      await seedTransaction(ctx, f, { amountMinorUnits: 400, date: "2026-07-01" });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals.expenseMinor).toBe(200);
  });

  it("defaults to the current month when month is omitted", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const now = currentMonth(new Date());
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 333, date: `${now}-15` });
      await seedTransaction(ctx, f, { amountMinorUnits: 999, date: "2000-01-01" });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, { circleId: f.circleId });
    expect(dashboard?.month).toBe(now);
    expect(dashboard?.totals.expenseMinor).toBe(333);
  });

  it("returns the Circle Currency for edge formatting", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.currency).toBe("EUR");
  });

  it("rejects a malformed month", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.query(api.dashboard.getDashboard, { circleId: f.circleId, month: "2026-13" }),
    ).rejects.toThrow(/invalid month/i);
  });
});

describe("getDashboard — recent feed", () => {
  it("returns the latest active transactions by record time, newest first", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    // Insert in a known record order; createdAt is set to Date.now() per insert, so
    // later inserts are more recent regardless of Transaction Date.
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "First recorded", date: "2026-06-20" });
      await seedTransaction(ctx, f, { title: "Second recorded", date: "2026-06-01" });
      await seedTransaction(ctx, f, { title: "Third recorded", date: "2026-06-10" });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    // Record-time order (createdAt desc), NOT Transaction-Date order — a backfilled
    // older date still ranks recent if it was entered last.
    expect(dashboard?.recent.map((txn) => txn.title)).toEqual([
      "Third recorded",
      "Second recorded",
      "First recorded",
    ]);
  });

  it(`caps the recent feed at ${RECENT_TRANSACTIONS_LIMIT} while totals still sum the whole month`, async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      for (let i = 0; i < RECENT_TRANSACTIONS_LIMIT + 3; i++) {
        await seedTransaction(ctx, f, {
          title: `Txn ${i}`,
          amountMinorUnits: 100,
          date: `2026-06-${String(i + 1).padStart(2, "0")}`,
        });
      }
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.recent).toHaveLength(RECENT_TRANSACTIONS_LIMIT);
    // Totals are the full month, not just the capped recent slice.
    expect(dashboard?.totals.expenseMinor).toBe((RECENT_TRANSACTIONS_LIMIT + 3) * 100);
  });

  it("excludes archived transactions from the recent feed", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "Active one", date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        title: "Archived one",
        date: "2026-06-11",
        status: "archived",
      });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.recent.map((txn) => txn.title)).toEqual(["Active one"]);
  });

  it("resolves recent rows to full views with Paid By and Categories", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const alex = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Dinner",
        date: "2026-06-10",
        paidByMemberId: alex.memberId,
        categoryIds: [f.diningId],
      }),
    );

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    const row = dashboard?.recent[0];
    expect(row?.paidBy.displayName).toBe("Alex");
    expect(row?.categories.map((category) => category.name)).toEqual(["Dining"]);
  });
});

describe("getDashboard — isolation & access (ADR 0016)", () => {
  it("never includes a transaction from another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 100, date: "2026-06-05" });
      await seedTransaction(ctx, other, { amountMinorUnits: 9_999, date: "2026-06-05" });
    });

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals.expenseMinor).toBe(100);
    expect(dashboard?.recent).toHaveLength(1);
  });

  it("returns null for a non-member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard).toBeNull();
  });

  it("returns null for a removed member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "r@example.com", "Rae Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed.user);
    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard).toBeNull();
  });

  it("returns null for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(null);
    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard).toBeNull();
  });

  it("is readable (view-only) for a member of an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { amountMinorUnits: 5_000, date: "2026-06-09" }));

    const dashboard = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(dashboard?.totals.expenseMinor).toBe(5_000);
  });

  it("reflects a transaction archived live: it drops out of totals and recent", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx, f, { amountMinorUnits: 1_000, date: "2026-06-10" }),
    );

    const before = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(before?.totals.expenseMinor).toBe(1_000);

    await t.run((ctx) => ctx.db.patch(txnId, { status: "archived" }));

    const after = await t.query(api.dashboard.getDashboard, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(after?.totals.expenseMinor).toBe(0);
    expect(after?.recent).toEqual([]);
  });
});

describe("getMonthlyComparison — series math (RPT-4)", () => {
  it("returns a chronological per-month series of income/expense/net in minor units", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        type: "income",
        amountMinorUnits: 500_000,
        date: "2026-04-05",
        categoryIds: [f.salaryId],
      });
      await seedTransaction(ctx, f, { amountMinorUnits: 1_250, date: "2026-04-10" });
      await seedTransaction(ctx, f, { amountMinorUnits: 7_500, date: "2026-05-20" });
      await seedTransaction(ctx, f, {
        type: "income",
        amountMinorUnits: 2_000,
        date: "2026-06-01",
        categoryIds: [f.salaryId],
      });
      await seedTransaction(ctx, f, { amountMinorUnits: 9_000, date: "2026-06-02" });
    });

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 3,
    });
    expect(comparison?.series).toEqual([
      { month: "2026-04", incomeMinor: 500_000, expenseMinor: 1_250, netMinor: 498_750 },
      { month: "2026-05", incomeMinor: 0, expenseMinor: 7_500, netMinor: -7_500 },
      { month: "2026-06", incomeMinor: 2_000, expenseMinor: 9_000, netMinor: -7_000 },
    ]);
    expect(comparison?.currency).toBe("USD");
  });

  it("zero-fills months with no transactions — no gaps in the series", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    // Only the first and last months of the window have activity.
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 100, date: "2026-01-15" });
      await seedTransaction(ctx, f, { amountMinorUnits: 200, date: "2026-06-15" });
    });

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 6,
    });
    expect(comparison?.series.map((entry) => entry.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    expect(comparison?.series.map((entry) => entry.expenseMinor)).toEqual([100, 0, 0, 0, 0, 200]);
    expect(comparison?.series[1]).toEqual({
      month: "2026-02",
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    });
  });

  it("excludes archived transactions and months outside the window", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 1_000, date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 9_999,
        date: "2026-06-11",
        status: "archived",
      });
      // Before the window start and after the end month — neither may appear.
      await seedTransaction(ctx, f, { amountMinorUnits: 5_000, date: "2026-03-31" });
      await seedTransaction(ctx, f, { amountMinorUnits: 5_000, date: "2026-07-01" });
    });

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 3,
    });
    expect(comparison?.series.map((entry) => entry.expenseMinor)).toEqual([0, 0, 1_000]);
  });

  it.each([1, 3, 6, 12] as const)(
    "a %i-month range produces exactly that many months ending at endMonth",
    async (rangeMonths) => {
      const t = convexTest(schema, modules);
      const f = await t.run((ctx) => seedFixture(ctx));
      mockCurrentUser.mockResolvedValue(f.owner);

      const comparison = await t.query(api.dashboard.getMonthlyComparison, {
        circleId: f.circleId,
        endMonth: "2026-06",
        rangeMonths,
      });
      expect(comparison?.series).toHaveLength(rangeMonths);
      expect(comparison?.series.at(-1)?.month).toBe("2026-06");
    },
  );

  it("spans a year boundary correctly", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { amountMinorUnits: 700, date: "2025-12-31" }));

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-02",
      rangeMonths: 6,
    });
    expect(comparison?.series.map((entry) => entry.month)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(comparison?.series[3]?.expenseMinor).toBe(700);
  });

  it("defaults endMonth to the current month when omitted", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const now = currentMonth(new Date());
    await t.run((ctx) => seedTransaction(ctx, f, { amountMinorUnits: 333, date: `${now}-15` }));

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      rangeMonths: 6,
    });
    expect(comparison?.series.at(-1)?.month).toBe(now);
    expect(comparison?.series.at(-1)?.expenseMinor).toBe(333);
  });

  it("rejects a malformed endMonth", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.query(api.dashboard.getMonthlyComparison, {
        circleId: f.circleId,
        endMonth: "2026-13",
        rangeMonths: 6,
      }),
    ).rejects.toThrow(/invalid month/i);
  });

  it("rejects an unsupported rangeMonths at the validator", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.query(api.dashboard.getMonthlyComparison, {
        circleId: f.circleId,
        endMonth: "2026-06",
        // @ts-expect-error — 2 is not a Comparison Range; the validator must refuse it.
        rangeMonths: 2,
      }),
    ).rejects.toThrow();
  });

  it("returns the Circle Currency for edge formatting", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 1,
    });
    expect(comparison?.currency).toBe("EUR");
  });
});

describe("getMonthlyComparison — isolation & access (ADR 0016)", () => {
  it("never includes a transaction from another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 100, date: "2026-06-05" });
      await seedTransaction(ctx, other, { amountMinorUnits: 9_999, date: "2026-06-05" });
    });

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 1,
    });
    expect(comparison?.series[0]?.expenseMinor).toBe(100);
  });

  it("returns null for a non-member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 6,
    });
    expect(comparison).toBeNull();
  });

  it("returns null for a removed member and an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "r@example.com", "Rae Removed", "removed"),
    );

    mockCurrentUser.mockResolvedValue(removed.user);
    expect(
      await t.query(api.dashboard.getMonthlyComparison, {
        circleId: f.circleId,
        endMonth: "2026-06",
        rangeMonths: 6,
      }),
    ).toBeNull();

    mockCurrentUser.mockResolvedValue(null);
    expect(
      await t.query(api.dashboard.getMonthlyComparison, {
        circleId: f.circleId,
        endMonth: "2026-06",
        rangeMonths: 6,
      }),
    ).toBeNull();
  });

  it("is readable (view-only) for a member of an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { amountMinorUnits: 5_000, date: "2026-06-09" }));

    const comparison = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 1,
    });
    expect(comparison?.series[0]?.expenseMinor).toBe(5_000);
  });

  it("reflects a transaction archived live: its month drops to zero", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx, f, { amountMinorUnits: 1_000, date: "2026-06-10" }),
    );

    const before = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 1,
    });
    expect(before?.series[0]?.expenseMinor).toBe(1_000);

    await t.run((ctx) => ctx.db.patch(txnId, { status: "archived" }));

    const after = await t.query(api.dashboard.getMonthlyComparison, {
      circleId: f.circleId,
      endMonth: "2026-06",
      rangeMonths: 1,
    });
    expect(after?.series[0]?.expenseMinor).toBe(0);
  });
});

describe("getCategoryAnalytics — tagged spend (RPT-5)", () => {
  it("ranks categories by tagged total descending with stable name tiebreak", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 3_000,
        date: "2026-06-05",
        categoryIds: [f.diningId],
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 5_000,
        date: "2026-06-06",
        categoryIds: [f.groceriesId],
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 3_000,
        date: "2026-06-07",
        categoryIds: [f.diningId],
      });
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(analytics?.rows.map((row) => row.name)).toEqual(["Dining", "Groceries"]);
    expect(analytics?.rows.map((row) => row.taggedTotalMinor)).toEqual([6_000, 5_000]);
  });

  it("aggregates correctly across many transactions in a month (RPT-5 batched reads)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await seedTransaction(ctx, f, {
          amountMinorUnits: 1_000,
          date: `2026-06-0${i + 1}`,
          categoryIds: i % 2 === 0 ? [f.diningId] : [f.groceriesId],
        });
      }
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });

    const byName = new Map(analytics?.rows.map((r) => [r.name, r]));
    expect(byName.get("Dining")).toMatchObject({ taggedTotalMinor: 3_000, txnCount: 3 });
    expect(byName.get("Groceries")).toMatchObject({ taggedTotalMinor: 3_000, txnCount: 3 });
  });

  it("aggregates correctly when transaction count exceeds link-read concurrency (RPT-5)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await seedTransaction(ctx, f, {
          amountMinorUnits: 1_000,
          date: `2026-06-${String(i + 1).padStart(2, "0")}`,
          categoryIds: i % 2 === 0 ? [f.diningId] : [f.groceriesId],
        });
      }
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });

    const byName = new Map(analytics?.rows.map((r) => [r.name, r]));
    expect(byName.get("Dining")).toMatchObject({ taggedTotalMinor: 15_000, txnCount: 15 });
    expect(byName.get("Groceries")).toMatchObject({ taggedTotalMinor: 15_000, txnCount: 15 });
  });

  it("is non-additive: a multi-category transaction contributes its full amount to each category", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_000,
        date: "2026-06-10",
        categoryIds: [f.groceriesId, f.diningId],
      });
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    const categorySum = analytics?.rows.reduce((sum, row) => sum + row.taggedTotalMinor, 0);
    expect(categorySum).toBe(2_000);

    const monthTxns = await t.run((ctx) =>
      collectMonthActiveTransactions(ctx, f.circleId, "2026-06"),
    );
    expect(sumMonthTotals(monthTxns).expenseMinor).toBe(1_000);
  });

  it("includes an archived category when in-period active transactions still use it", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const archivedId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old Subscriptions",
        creatorUserId: f.owner._id,
        status: "archived",
      }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        amountMinorUnits: 2_100,
        date: "2026-06-12",
        categoryIds: [archivedId],
      }),
    );

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    const archived = analytics?.rows.find((row) => row.categoryId === archivedId);
    expect(archived).toMatchObject({
      name: "Old Subscriptions",
      status: "archived",
      taggedTotalMinor: 2_100,
      txnCount: 1,
    });
  });

  it("omits an archived category with no in-period active transactions", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const archivedId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Unused Archived",
        creatorUserId: f.owner._id,
        status: "archived",
      }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        amountMinorUnits: 500,
        date: "2026-05-15",
        categoryIds: [archivedId],
      }),
    );

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(analytics?.rows.some((row) => row.categoryId === archivedId)).toBe(false);
  });

  it("filters by transaction type and month", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        type: "income",
        amountMinorUnits: 50_000,
        date: "2026-06-01",
        categoryIds: [f.salaryId],
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_000,
        date: "2026-06-02",
        categoryIds: [f.groceriesId],
      });
      await seedTransaction(ctx, f, { amountMinorUnits: 9_999, date: "2026-05-15" });
    });

    const income = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "income",
    });
    expect(income?.rows).toEqual([
      expect.objectContaining({ name: "Salary", taggedTotalMinor: 50_000, txnCount: 1 }),
    ]);

    const expenses = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(expenses?.rows).toEqual([
      expect.objectContaining({ name: "Groceries", taggedTotalMinor: 1_000, txnCount: 1 }),
    ]);
  });

  it("excludes archived transactions from the math", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_000,
        date: "2026-06-10",
        categoryIds: [f.groceriesId],
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 9_999,
        date: "2026-06-11",
        status: "archived",
        categoryIds: [f.diningId],
      });
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(analytics?.rows).toEqual([
      expect.objectContaining({ name: "Groceries", taggedTotalMinor: 1_000 }),
    ]);
  });

  it("defaults to the current month and rejects a malformed month", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const now = currentMonth(new Date());
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        amountMinorUnits: 333,
        date: `${now}-15`,
        categoryIds: [f.groceriesId],
      }),
    );

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, { circleId: f.circleId });
    expect(analytics?.rows[0]?.taggedTotalMinor).toBe(333);

    await expect(
      t.query(api.dashboard.getCategoryAnalytics, { circleId: f.circleId, month: "2026-13" }),
    ).rejects.toThrow(/invalid month/i);
  });

  it("returns the Circle Currency for edge formatting", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
    });
    expect(analytics?.currency).toBe("EUR");
  });
});

describe("getCategoryAnalytics — isolation & access (ADR 0016)", () => {
  it("returns null for a non-member and an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(
      await t.query(api.dashboard.getCategoryAnalytics, {
        circleId: f.circleId,
        month: "2026-06",
      }),
    ).toBeNull();

    mockCurrentUser.mockResolvedValue(null);
    expect(
      await t.query(api.dashboard.getCategoryAnalytics, {
        circleId: f.circleId,
        month: "2026-06",
      }),
    ).toBeNull();
  });

  it("never includes a transaction from another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 100,
        date: "2026-06-05",
        categoryIds: [f.groceriesId],
      });
      await seedTransaction(ctx, other, {
        amountMinorUnits: 9_999,
        date: "2026-06-05",
        categoryIds: [other.groceriesId],
      });
    });

    const analytics = await t.query(api.dashboard.getCategoryAnalytics, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(analytics?.rows).toEqual([
      expect.objectContaining({ name: "Groceries", taggedTotalMinor: 100 }),
    ]);
  });
});
