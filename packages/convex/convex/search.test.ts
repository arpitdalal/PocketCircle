import { searchOffsetTakeLimit } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  firstPage,
  makeCategory,
  makeUser,
  searchTransactionPage,
  seedFixture,
  seedTransaction,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
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
  vi.unstubAllEnvs();
});

async function seedSparseSearchRows(
  ctx: Parameters<typeof seedTransaction>[0],
  f: Parameters<typeof seedTransaction>[1],
  opts: {
    needle: string;
    count?: number;
    row?: (index: number) => Parameters<typeof seedTransaction>[2];
  },
) {
  const count = opts.count ?? 12;
  for (let index = 0; index < count; index += 1) {
    const day = (index + 1).toString().padStart(2, "0");
    const matches = index % 2 === 0;
    await seedTransaction(ctx, f, {
      title: matches ? `${opts.needle} ${index}` : `miss ${index}`,
      note: matches ? "matched sparse row" : "ordinary row",
      date: `2026-06-${day}`,
      ...opts.row?.(index),
    });
  }
}

describe("filterLedgerTransactions", () => {
  it("filters the selected month by title/note only", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Whole Foods",
        note: "Weekly groceries",
        date: "2026-06-10",
      });
      await seedTransaction(ctx, f, {
        title: "Category name only",
        note: "no match",
        date: "2026-06-11",
        categoryIds: [f.diningId],
      });
      await seedTransaction(ctx, f, {
        title: "Whole Foods old",
        note: "Weekly groceries",
        date: "2026-05-10",
      });
    });

    const title = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "whole   foods",
      ...firstPage(25),
    });
    expect(title.page.map((txn) => txn.title)).toEqual(["Whole Foods"]);

    const categoryName = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "dining",
      ...firstPage(25),
    });
    expect(categoryName.page).toEqual([]);
  });

  it("finds newly created transactions via indexed text search", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      expectedCurrency: "USD",
      type: "expense",
      title: "Indexed vendor",
      amountMinorUnits: 4200,
      date: "2026-06-12",
      categoryIds: [f.groceriesId],
    });

    const result = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "indexed",
      ...firstPage(25),
    });
    expect(result.page.map((txn) => txn.title)).toEqual(["Indexed vendor"]);
  });

  it("ORs values within category/member fields and ANDs fields together", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const alex = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    const sam = await t.run((ctx) => addMember(ctx, f.circleId, "sam@example.com", "Sam"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Groceries Alex",
        date: "2026-06-10",
        categoryIds: [f.groceriesId],
        paidByMemberId: alex.memberId,
      });
      await seedTransaction(ctx, f, {
        title: "Dining Alex",
        date: "2026-06-11",
        categoryIds: [f.diningId],
        paidByMemberId: alex.memberId,
      });
      await seedTransaction(ctx, f, {
        title: "Groceries Sam",
        date: "2026-06-12",
        categoryIds: [f.groceriesId],
        paidByMemberId: sam.memberId,
      });
    });

    const result = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
      status: "active",
      categoryIds: [f.groceriesId, f.diningId],
      paidByMemberIds: [alex.memberId],
      ...firstPage(25),
    });
    expect(result.page.map((txn) => txn.title)).toEqual(["Dining Alex", "Groceries Alex"]);
  });

  it("uses the text index instead of scanning past text misses", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "Newest miss", date: "2026-06-03" });
      await seedTransaction(ctx, f, { title: "Middle miss", date: "2026-06-02" });
      await seedTransaction(ctx, f, { title: "Needle match", date: "2026-06-01" });
    });

    const page = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "needle",
      ...firstPage(1),
    });
    expect(page.page.map((txn) => txn.title)).toEqual(["Needle match"]);
    expect(page.isDone).toBe(true);
  });

  it("paginates sparse text matches through the search index", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedSparseSearchRows(ctx, f, { needle: "needle" });
    });

    const first = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "needle",
      ...firstPage(5),
    });
    expect(first.page).toHaveLength(5);
    expect(first.page.every((txn) => txn.title.includes("needle"))).toBe(true);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "needle",
      paginationOpts: { numItems: 5, cursor: first.continueCursor },
    });
    expect([...first.page, ...second.page].map((txn) => txn.title).sort()).toEqual([
      "needle 0",
      "needle 10",
      "needle 2",
      "needle 4",
      "needle 6",
      "needle 8",
    ]);
    expect(second.isDone).toBe(true);
  });

  it("pushes a single Paid By selection into indexed text search", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const alex = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedSparseSearchRows(ctx, f, {
        needle: "payer",
        row: () => ({ paidByMemberId: alex.memberId }),
      });
    });

    const page = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "payer",
      paidByMemberIds: [alex.memberId],
      ...firstPage(5),
    });
    expect(page.page).toHaveLength(5);
    expect(page.page.every((txn) => txn.paidBy.displayName === "Alex")).toBe(true);
    expect(page.isDone).toBe(false);
  });

  it("pushes a single Recorded By selection into indexed text search", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const sam = await t.run((ctx) => addMember(ctx, f.circleId, "sam@example.com", "Sam"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedSparseSearchRows(ctx, f, {
        needle: "recorder",
        row: () => ({ recordedByMemberId: sam.memberId }),
      });
    });

    const page = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "all",
      status: "active",
      query: "recorder",
      recordedByMemberIds: [sam.memberId],
      ...firstPage(5),
    });
    expect(page.page).toHaveLength(5);
    expect(page.page.every((txn) => txn.recordedBy.displayName === "Sam")).toBe(true);
    expect(page.isDone).toBe(false);
  });

  it("fills text-search pages after category post-filters", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      for (let index = 0; index < 6; index += 1) {
        await seedTransaction(ctx, f, {
          title: `receipt receipt receipt filtered ${index}`,
          date: `2026-06-${(index + 1).toString().padStart(2, "0")}`,
          categoryIds: [f.diningId],
        });
      }
      for (let index = 0; index < 4; index += 1) {
        await seedTransaction(ctx, f, {
          title: `receipt kept ${index}`,
          date: `2026-06-${(index + 10).toString().padStart(2, "0")}`,
          categoryIds: [f.groceriesId],
        });
      }
    });

    const first = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
      status: "active",
      query: "receipt",
      categoryIds: [f.groceriesId],
      ...firstPage(3),
    });
    expect(first.page).toHaveLength(3);
    expect(
      first.page.every((txn) => txn.categories.some((category) => category.name === "Groceries")),
    ).toBe(true);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
      status: "active",
      query: "receipt",
      categoryIds: [f.groceriesId],
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect([...first.page, ...second.page].map((txn) => txn.title).sort()).toEqual([
      "receipt kept 0",
      "receipt kept 1",
      "receipt kept 2",
      "receipt kept 3",
    ]);
    expect(second.isDone).toBe(true);
  });

  it("fills text-search pages after multi-member post-filters", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const alex = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    const sam = await t.run((ctx) => addMember(ctx, f.circleId, "sam@example.com", "Sam"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      for (let index = 0; index < 6; index += 1) {
        await seedTransaction(ctx, f, {
          title: `split split split filtered ${index}`,
          date: `2026-06-${(index + 1).toString().padStart(2, "0")}`,
          paidByMemberId: f.ownerMemberId,
        });
      }
      for (let index = 0; index < 4; index += 1) {
        await seedTransaction(ctx, f, {
          title: `split kept ${index}`,
          date: `2026-06-${(index + 10).toString().padStart(2, "0")}`,
          paidByMemberId: index % 2 === 0 ? alex.memberId : sam.memberId,
        });
      }
    });

    const first = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
      status: "active",
      query: "split",
      paidByMemberIds: [alex.memberId, sam.memberId],
      ...firstPage(3),
    });
    expect(first.page).toHaveLength(3);
    expect(first.page.every((txn) => ["Alex", "Sam"].includes(txn.paidBy.displayName))).toBe(true);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.search.filterLedgerTransactions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
      status: "active",
      query: "split",
      paidByMemberIds: [alex.memberId, sam.memberId],
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect([...first.page, ...second.page].map((txn) => txn.title).sort()).toEqual([
      "split kept 0",
      "split kept 1",
      "split kept 2",
      "split kept 3",
    ]);
    expect(second.isDone).toBe(true);
  });
});

describe("searchTransactions", () => {
  it("defaults by explicit status/type to all active circle transactions newest first", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "May row", date: "2026-05-10" });
      await seedTransaction(ctx, f, { title: "June row", date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        title: "Archived row",
        date: "2026-06-11",
        status: "archived",
      });
    });

    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      ...searchTransactionPage(1, 25),
    });
    expect(result.transactions.map((txn) => txn.title)).toEqual(["June row", "May row"]);
    expect(result.totalCount).toBe(2);
    expect(result.totalCountCapped).toBe(false);
  });

  it("supports status all, inclusive dates, and inclusive amount range", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Start",
        date: "2026-05-01",
        amountMinorUnits: 1_000,
      });
      await seedTransaction(ctx, f, {
        title: "End archived",
        date: "2026-05-31",
        amountMinorUnits: 2_000,
        status: "archived",
      });
      await seedTransaction(ctx, f, {
        title: "Outside",
        date: "2026-06-01",
        amountMinorUnits: 2_000,
      });
    });

    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "all",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      amountMin: 1_000,
      amountMax: 2_000,
      ...searchTransactionPage(1, 25),
    });
    expect(result.transactions.map((txn) => txn.title)).toEqual(["End archived", "Start"]);
    expect(result.totalCount).toBe(2);
  });

  it("uses indexed whole-word text search with final-term prefix matching", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "Coffee beans", note: "local roaster" });
      await seedTransaction(ctx, f, { title: "Office supplies", note: "paper" });
      await seedTransaction(ctx, f, { title: "Cafe", note: "coffee filters" });
    });

    const substring = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      query: "off",
      ...searchTransactionPage(1, 25),
    });
    expect(substring.transactions.map((txn) => txn.title)).toEqual(["Office supplies"]);

    const prefix = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      query: "coffee fi",
      ...searchTransactionPage(1, 25),
    });
    expect(prefix.transactions.map((txn) => txn.title).sort()).toEqual(["Cafe", "Coffee beans"]);
  });

  it("returns an empty page for reversed date or amount ranges", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { title: "Row", date: "2026-05-10" }));

    const reversedDates = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      dateFrom: "2026-05-31",
      dateTo: "2026-05-01",
      ...searchTransactionPage(1, 25),
    });
    expect(reversedDates.transactions).toEqual([]);

    const reversedAmount = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      amountMin: 2_000,
      amountMax: 1_000,
      ...searchTransactionPage(1, 25),
    });
    expect(reversedAmount.transactions).toEqual([]);
  });

  it("paginates sparse text matches across an unscoped date window", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedSparseSearchRows(ctx, f, {
        needle: "global",
        row: (index) => (index % 3 === 0 ? { status: "archived" } : {}),
      });
    });

    const first = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "all",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      query: "global",
      ...searchTransactionPage(1, 5),
    });
    expect(first.transactions).toHaveLength(5);
    expect(first.transactions.every((txn) => txn.title.includes("global"))).toBe(true);
    expect(first.totalCount).toBe(6);
    expect(first.totalCountCapped).toBe(false);

    const second = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "all",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      query: "global",
      ...searchTransactionPage(2, 5),
    });
    expect(second.transactions.map((txn) => txn.title).sort()).toEqual(["global 10"]);
    expect(second.totalCount).toBe(6);
    expect(second.totalCountCapped).toBe(false);
  });

  it("marks indexed search capped when scan sentinel row is hit", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const pageSize = 1;
    const scanCap = searchOffsetTakeLimit(pageSize);
    const needle = "sentinel";
    await t.run(async (ctx) => {
      for (let index = 0; index < scanCap; index += 1) {
        const day = (index % 28) + 1;
        await seedTransaction(ctx, f, {
          title: `${needle} ${index}`,
          date: `2026-06-${day.toString().padStart(2, "0")}`,
        });
      }
    });

    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      query: needle,
      ...searchTransactionPage(1, pageSize),
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.totalCount).toBe(scanCap);
    expect(result.totalCountCapped).toBe(true);
  });

  it("marks stream search capped when take sentinel row is hit", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const pageSize = 1;
    const takeLimit = searchOffsetTakeLimit(pageSize);
    await t.run(async (ctx) => {
      for (let index = 0; index < takeLimit; index += 1) {
        const day = (index % 28) + 1;
        await seedTransaction(ctx, f, {
          title: `stream cap ${index}`,
          date: `2026-06-${day.toString().padStart(2, "0")}`,
        });
      }
    });

    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      ...searchTransactionPage(1, pageSize),
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.totalCount).toBe(takeLimit);
    expect(result.totalCountCapped).toBe(true);
  });

  it("bounds indexed totalCount by the search-result ceiling for large pageSize", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const pageSize = 100;
    const needle = "wide-page";
    await t.run(async (ctx) => {
      for (let index = 0; index < 30; index += 1) {
        const day = (index % 28) + 1;
        await seedTransaction(ctx, f, {
          title: `${needle} ${index}`,
          date: `2026-06-${day.toString().padStart(2, "0")}`,
        });
      }
    });

    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      query: needle,
      ...searchTransactionPage(1, pageSize),
    });
    expect(result.transactions).toHaveLength(30);
    expect(result.totalCount).toBe(30);
    expect(result.totalCountCapped).toBe(false);
    expect(result.totalCount).toBeLessThan(searchOffsetTakeLimit(pageSize));
  });
});

describe("search options", () => {
  it("returns ledger options used in the selected month, including archived categories and removed members", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "removed@example.com", "Remy Removed", "removed"),
    );
    const archivedCategory = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old Utilities",
        status: "archived",
        creatorUserId: f.owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Old bill",
        date: "2026-06-10",
        categoryIds: [archivedCategory],
        paidByMemberId: removed.memberId,
      });
      await seedTransaction(ctx, f, { title: "Other month", date: "2026-05-10" });
    });

    const options = await t.query(api.search.getLedgerFilterOptions, {
      circleId: f.circleId,
      month: "2026-06",
      type: "expense",
    });
    expect(options?.categories.map((category) => [category.name, category.status])).toEqual([
      ["Old Utilities", "archived"],
    ]);
    expect(options?.members.map((member) => [member.displayName, member.status])).toContainEqual([
      "Remy Removed",
      "removed",
    ]);
  });

  it("returns exhaustive search options for the whole circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    await t.run((ctx) =>
      addMember(ctx, f.circleId, "removed@example.com", "Remy Removed", "removed"),
    );
    await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old Utilities",
        status: "archived",
        creatorUserId: f.owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    const options = await t.query(api.search.getTransactionSearchOptions, {
      circleId: f.circleId,
      type: "all",
    });
    expect(options?.categories.map((category) => category.name)).toEqual([
      "Dining",
      "Groceries",
      "Old Utilities",
      "Salary",
    ]);
    expect(options?.members.map((member) => [member.displayName, member.status])).toContainEqual([
      "Remy Removed",
      "removed",
    ]);
  });

  it("returns null for inaccessible circles and remains readable for archived circles", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { archived: true }));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(
      await t.query(api.search.getTransactionSearchOptions, {
        circleId: f.circleId,
        type: "all",
      }),
    ).toBeNull();

    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Archived circle row", date: "2026-06-10" }),
    );
    const result = await t.query(api.search.searchTransactions, {
      circleId: f.circleId,
      type: "all",
      status: "active",
      ...searchTransactionPage(1, 25),
    });
    expect(result.transactions.map((txn) => txn.title)).toEqual(["Archived circle row"]);
  });
});
