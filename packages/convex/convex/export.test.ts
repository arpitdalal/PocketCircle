import {
  formatMoneyAmount,
  money,
  TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
} from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  makeUser,
  searchTransactionPage,
  seedFixture,
  seedTransaction,
  seedTransactionsBulk,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import { EXPORT_LIMIT } from "./export.js";
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

function exportArgs(
  circleId: Parameters<typeof api.export.exportTransactions>[0]["circleId"],
  overrides: Partial<Parameters<typeof api.export.exportTransactions>[0]> = {},
) {
  return {
    circleId,
    type: "all" as const,
    status: "all" as const,
    ...overrides,
  };
}

function rowTitles(result: Awaited<ReturnType<typeof api.export.exportTransactions>>) {
  if (!result.ok) {
    throw new Error("expected export success");
  }
  return result.rows.map((row) => row.title);
}

function assertNoRawIds(
  result: Extract<Awaited<ReturnType<typeof api.export.exportTransactions>>, { ok: true }>,
  knownIds: string[],
) {
  for (const row of result.rows) {
    const serialized = JSON.stringify(row);
    for (const id of knownIds) {
      expect(serialized).not.toContain(id);
    }
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("ref");
  }
}

describe("exportTransactions", () => {
  it("exports all lifecycle statuses when status=all and includes a status column", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "Active row", date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        title: "Archived row",
        date: "2026-06-11",
        status: "archived",
      });
    });

    const result = await t.query(api.export.exportTransactions, exportArgs(f.circleId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rowTitles(result).sort()).toEqual(["Active row", "Archived row"]);
    expect(result.rows.map((row) => row.status).sort()).toEqual(["active", "archived"]);
  });

  it("exports only active or archived rows when lifecycle status is narrowed", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { title: "Active row", date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        title: "Archived row",
        date: "2026-06-11",
        status: "archived",
      });
    });

    const active = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { status: "active" }),
    );
    expect(active.ok).toBe(true);
    if (active.ok) {
      expect(rowTitles(active)).toEqual(["Active row"]);
    }

    const archived = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { status: "archived" }),
    );
    expect(archived.ok).toBe(true);
    if (archived.ok) {
      expect(rowTitles(archived)).toEqual(["Archived row"]);
    }
  });

  it("matches Transaction Search filter semantics", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const alex = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Groceries Alex",
        date: "2026-06-10",
        categoryIds: [f.groceriesId],
        paidByMemberId: alex.memberId,
        amountMinorUnits: 1_500,
      });
      await seedTransaction(ctx, f, {
        title: "Dining Alex",
        date: "2026-06-11",
        categoryIds: [f.diningId],
        paidByMemberId: alex.memberId,
        amountMinorUnits: 2_500,
      });
      await seedTransaction(ctx, f, {
        title: "Outside",
        date: "2026-06-12",
        amountMinorUnits: 2_500,
      });
    });

    const filters = {
      circleId: f.circleId,
      type: "expense" as const,
      status: "active" as const,
      categoryIds: [f.groceriesId, f.diningId],
      paidByMemberIds: [alex.memberId],
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      amountMin: 1_000,
      amountMax: 3_000,
      query: "alex",
    };

    const search = await t.query(api.search.searchTransactions, {
      ...filters,
      ...searchTransactionPage(1, 25),
    });
    const exported = await t.query(api.export.exportTransactions, filters);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(rowTitles(exported).sort()).toEqual(search.transactions.map((txn) => txn.title).sort());
  });

  it("formats rows for human-readable CSV without internal ids", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "removed@example.com", "Remy Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: 'Coffee, "special"',
        note: "line1\nline2",
        date: "2026-06-10",
        amountMinorUnits: 1_250,
        categoryIds: [f.groceriesId, f.diningId],
        paidByMemberId: removed.memberId,
      });
    });

    const result = await t.query(api.export.exportTransactions, exportArgs(f.circleId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.rows[0];
    expect(row).toMatchObject({
      date: "2026-06-10",
      type: "expense",
      title: 'Coffee, "special"',
      note: "line1\nline2",
      amount: formatMoneyAmount(money(1_250, "USD")),
      currency: "USD",
      categories: "Groceries, Dining",
      recordedBy: "Olive Owner",
      paidBy: "Remy Removed",
      status: "active",
    });
    assertNoRawIds(result, [
      f.circleId,
      f.ownerMemberId,
      removed.memberId,
      f.groceriesId,
      f.diningId,
    ]);
  });

  it("refuses stream-path export when more than EXPORT_LIMIT rows match", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run(async (ctx) => {
      await seedTransactionsBulk(ctx, f, EXPORT_LIMIT + 1);
    });

    const result = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { status: "active" }),
    );
    expect(result).toEqual({ ok: false, reason: "tooMany", limit: EXPORT_LIMIT });
  });

  it("refuses text-path export when the indexed ceiling is exceeded", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const needle = "export-ceiling";
    await t.run(async (ctx) => {
      await seedTransactionsBulk(ctx, f, TRANSACTION_SEARCH_INDEXED_RESULT_CEILING + 1, {
        titlePrefix: needle,
        syncSearch: true,
      });
    });

    const result = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { query: needle }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "tooMany",
      limit: TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
    });
  }, 120_000);

  it("exports fully through the text path when matches stay within the ceiling", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const needle = "within-ceiling";
    await t.run(async (ctx) => {
      for (let index = 0; index < 12; index += 1) {
        const day = (index + 1).toString().padStart(2, "0");
        await seedTransaction(ctx, f, {
          title: `${needle} ${index}`,
          date: `2026-06-${day}`,
        });
      }
    });

    const result = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { query: needle }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(12);
    }
  });

  it("returns inaccessible for non-members without leaking rows", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    await t.run((ctx) => seedTransaction(ctx, f, { title: "Secret", date: "2026-06-10" }));

    const result = await t.query(api.export.exportTransactions, exportArgs(f.circleId));
    expect(result).toEqual({ ok: false, reason: "inaccessible" });
  });

  it("exports from an archived circle for its member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Archived circle row", date: "2026-06-10" }),
    );

    const result = await t.query(api.export.exportTransactions, exportArgs(f.circleId));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(rowTitles(result)).toEqual(["Archived circle row"]);
    }
  });

  it("returns headers-only success for an empty matching set", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const result = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { query: "missing" }),
    );
    expect(result).toEqual({ ok: true, rows: [], currency: "USD" });
  });

  it("returns empty success for unknown-only category or member filters", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.run((ctx) => seedTransaction(ctx, f, { title: "Row", date: "2026-06-10" }));

    const categoryOnly = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { categoryIds: ["categories|unknown"] }),
    );
    expect(categoryOnly).toEqual({ ok: true, rows: [], currency: "USD" });

    const memberOnly = await t.query(
      api.export.exportTransactions,
      exportArgs(f.circleId, { recordedByMemberIds: ["members|unknown"] }),
    );
    expect(memberOnly).toEqual({ ok: true, rows: [], currency: "USD" });
  });

  it("throws for invalid search filters", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await expect(
      t.query(api.export.exportTransactions, exportArgs(f.circleId, { dateFrom: "not-a-date" })),
    ).rejects.toThrow("Invalid search filters");
  });
});
