import {
  buildRef,
  MUTATION_ERRORS,
  mutationErrorData,
  transactionSearchText,
} from "@spend-circle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import {
  addMember,
  firstPage,
  makeCategory,
  makeUser,
  seedCircle,
  seedFixture,
  seedTransaction,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";

// createTransaction/listTransactions resolve access through guard.ts, which folds
// in `getCurrentUserOrNull` — backed by Better Auth and unrunnable under
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

function baseExpense(categoryIds: Id<"categories">[]) {
  return {
    type: "expense" as const,
    title: "Weekly shop",
    amountMinorUnits: 1250,
    date: "2026-05-15",
    categoryIds,
  };
}

/** An entity's history newest-first. */
async function historyOf(ctx: MutationCtx, entityId: string): Promise<Doc<"histories">[]> {
  return await ctx.db
    .query("histories")
    .withIndex("by_entity", (q) => q.eq("entityId", entityId))
    .order("desc")
    .collect();
}

/** The Category ids currently attached to a Transaction. */
async function categoryIdsOf(
  ctx: MutationCtx,
  id: Id<"transactions">,
): Promise<Id<"categories">[]> {
  const links = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", id))
    .collect();
  return links.map((link) => link.categoryId);
}

async function searchDocumentOf(ctx: MutationCtx, id: Id<"transactions">) {
  return await ctx.db
    .query("transactionSearchDocuments")
    .withIndex("by_transaction", (q) => q.eq("transactionId", id))
    .unique();
}

describe("createTransaction — happy path", () => {
  it("persists minor units, plain date, month bucket, recordedBy/paidBy = creator", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.amountMinorUnits).toBe(1250);
      expect(txn?.date).toBe("2026-05-15");
      expect(txn?.month).toBe("2026-05");
      expect(txn?.type).toBe("expense");
      expect(txn?.status).toBe("active");
      expect(txn?.recordedByMemberId).toBe(f.ownerMemberId);
      expect(txn?.paidByMemberId).toBe(f.ownerMemberId); // defaults to recorded-by
      expect(txn?.note).toBeUndefined();
      expect(txn?.createdAt).toBe(txn?.updatedAt);
      const searchDoc = await searchDocumentOf(ctx, id);
      expect(searchDoc?.searchText).toBe(transactionSearchText({ title: "Weekly shop" }));
      expect(searchDoc?.circleId).toBe(f.circleId);
      expect(searchDoc?.status).toBe("active");
      expect(searchDoc?.categoryId0).toBe(f.groceriesId);
      expect(searchDoc?.categoryId1).toBeUndefined();

      const links = await ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", id))
        .collect();
      expect(links.map((l) => l.categoryId)).toEqual([f.groceriesId]);
    });
  });

  it("creates an income transaction with multiple categories and an optional note", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const secondIncome = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Bonus",
        type: "income",
        creatorUserId: f.owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "income",
      title: "Paycheck",
      note: "  May salary  ",
      amountMinorUnits: 500000,
      date: "2026-05-31",
      categoryIds: [f.salaryId, secondIncome],
    });

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.type).toBe("income");
      expect(txn?.note).toBe("May salary"); // trimmed
      const searchDoc = await searchDocumentOf(ctx, id);
      expect(searchDoc?.categoryId0).toBe(f.salaryId);
      expect(searchDoc?.categoryId1).toBe(secondIncome);
      expect(searchDoc?.categoryId2).toBeUndefined();
      const links = await ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", id))
        .collect();
      expect(links).toHaveLength(2);
    });
  });

  it("records a create event with formatted money/date/categories and no raw ids", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "expense",
      title: "Weekly shop",
      note: "eggs and milk",
      amountMinorUnits: 1250,
      date: "2026-05-15",
      categoryIds: [f.groceriesId, f.diningId],
    });

    await t.run(async (ctx) => {
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", id))
        .collect();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.action).toBe("created");
      expect(event?.actorMemberId).toBe(f.ownerMemberId);
      expect(event?.changes).toEqual([
        { field: "type", to: "expense" },
        { field: "title", to: "Weekly shop" },
        // Amount freezes a typed money value, not a formatted string (ADR 0021):
        // no `from`/`to`, no symbol, no locale baked in.
        { field: "amount", toMoney: { minorUnits: 1250, currency: "USD" } },
        { field: "date", to: "2026-05-15" },
        { field: "paidBy", to: "Olive Owner" },
        { field: "categories", to: "Groceries, Dining" },
        { field: "note", to: "eggs and milk" },
      ]);
      for (const change of event?.changes ?? []) {
        for (const value of [change.from, change.to]) {
          expect(value).not.toBe(id);
          expect(value).not.toBe(f.groceriesId);
          expect(value).not.toBe(f.ownerMemberId);
        }
      }
    });
  });

  it("freezes the typed amount with the Circle's own Currency (not a default)", async () => {
    // ADR 0021: the money value freezes the Circle Currency at event time, so a
    // non-USD Circle records that Currency — never a hardcoded USD or an ambient
    // locale's currency.
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "EUR" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      amountMinorUnits: 4500,
    });

    await t.run(async (ctx) => {
      const amount = (await historyOf(ctx, id))[0]?.changes.find((c) => c.field === "amount");
      expect(amount).toEqual({ field: "amount", toMoney: { minorUnits: 4500, currency: "EUR" } });
    });
  });

  it("omits the note change when no note is given", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    await t.run(async (ctx) => {
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", id))
        .collect();
      expect(events[0]?.changes.some((c) => c.field === "note")).toBe(false);
    });
  });
});

describe("createTransaction — amount edges", () => {
  it.each([
    ["zero", 0],
    ["negative", -100],
    ["non-integer", 12.5],
    ["one minor unit over max", 99_999_999_999 + 1],
  ])("rejects a %s amount", async (_label, amountMinorUnits) => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        amountMinorUnits,
      }),
    ).rejects.toThrow();
  });

  it("accepts the maximum allowed amount", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        amountMinorUnits: 99_999_999_999,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("createTransaction — date edges", () => {
  it("rejects an invalid date format", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        date: "15/05/2026",
      }),
    ).rejects.toThrow();
  });

  it("keeps the entered month at a month boundary (no timezone shift)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      date: "2026-05-31",
    });
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.date).toBe("2026-05-31");
      expect(txn?.month).toBe("2026-05");
    });
  });
});

describe("createTransaction — category rules", () => {
  it("rejects zero categories", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([]),
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate category ids", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId, f.groceriesId]),
      }),
    ).rejects.toThrow();
  });

  it("rejects a category from another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const otherCategory = await t.run(async (ctx) => {
      const other = await seedCircle(ctx, { kind: "regular" });
      // reuse the owner email collision guard: a distinct circle, distinct cat
      return makeCategory(ctx, other.circleId, {
        name: "Foreign",
        type: "expense",
        creatorUserId: other.owner._id,
      });
    });
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([otherCategory]),
      }),
    ).rejects.toThrow(/not found in this circle/i);
  });

  it("rejects a category of the wrong type", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.salaryId]), // income category on an expense
      }),
    ).rejects.toThrow(/type does not match/i);
  });

  it("rejects an archived category (cannot be newly added)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const archivedId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old",
        type: "expense",
        status: "archived",
        creatorUserId: f.owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([archivedId]),
      }),
    ).rejects.toThrow(/archived categories cannot be added/i);
  });

  it("accepts multiple active correct-type categories", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId, f.diningId]),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("createTransaction — Paid By", () => {
  it("defaults Paid By to the creator", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.paidByMemberId).toBe(f.ownerMemberId);
    });
  });

  it("sets Paid By to another current Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await mutateAndDrain(t, () =>
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        paidByMemberId: other.memberId,
      }),
    );
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.recordedByMemberId).toBe(f.ownerMemberId);
      expect(txn?.paidByMemberId).toBe(other.memberId);
      const events = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", id))
        .collect();
      expect(events[0]?.changes.find((c) => c.field === "paidBy")?.to).toBe("Maya Member");

      const notifications = await listNotificationsForUser(ctx, other.user._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("transaction.paid_by");
    });
  });

  it("works on an income transaction (Paid By for income too)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "income",
      title: "Refund",
      amountMinorUnits: 999,
      date: "2026-05-10",
      categoryIds: [f.salaryId],
      paidByMemberId: other.memberId,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.paidByMemberId).toBe(other.memberId);
    });
  });

  it("rejects a Removed Member as Paid By", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "r@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        paidByMemberId: removed.memberId,
      }),
    ).rejects.toThrow(/current member of this circle/i);
  });

  it("rejects a Member of a different Circle as Paid By", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const foreignMemberId = await t.run(async (ctx) => {
      const other = await seedCircle(ctx);
      return other.ownerMemberId;
    });
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        paidByMemberId: foreignMemberId,
      }),
    ).rejects.toThrow(/current member of this circle/i);
  });
});

describe("createTransaction — title / note", () => {
  it("rejects an empty title", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        title: "",
      }),
    ).rejects.toThrow();
  });

  it("rejects a whitespace-only title", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        title: "   ",
      }),
    ).rejects.toThrow();
  });

  it("rejects an over-max title and note", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        title: "x".repeat(121),
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        note: "x".repeat(1001),
      }),
    ).rejects.toThrow();
  });

  it("trims the title before storing", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "  Weekly shop  ",
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.title).toBe("Weekly shop");
    });
  });
});

describe("createTransaction — permission matrix", () => {
  it("allows the Owner", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    ).resolves.toBeTruthy();
  });

  it("allows a non-owner active Member (recordedBy = them)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(member.user);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.recordedByMemberId).toBe(member.memberId);
    });
  });

  it("denies a Removed Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "r@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed.user);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    ).rejects.toThrow("Circle not found");
  });

  it("denies a non-member User", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    ).rejects.toThrow("Circle not found");
  });

  it("denies an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    ).rejects.toThrow("Circle not found");
  });

  it("allows a Personal Circle owner", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx, { kind: "personal" });
      const cat = await makeCategory(ctx, seed.circleId, {
        name: "Groceries",
        creatorUserId: seed.owner._id,
      });
      return { ...seed, cat };
    });
    mockCurrentUser.mockResolvedValue(personal.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: personal.circleId,
        ...baseExpense([personal.cat]),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("createTransaction — lifecycle edges", () => {
  it("denies creation in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx, { archived: true });
      const cat = await makeCategory(ctx, seed.circleId, {
        name: "Groceries",
        creatorUserId: seed.owner._id,
      });
      return { ...seed, cat };
    });
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.cat]),
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects an incomplete regular Circle with no Transaction/History/currency-lock side effects", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { setupCompletedAt: null }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await expect(
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_circle", (q) => q.eq("circleId", f.circleId))
        .collect();
      expect(txns).toHaveLength(0);
      const history = await ctx.db
        .query("histories")
        .withIndex("by_circle", (q) => q.eq("circleId", f.circleId))
        .collect();
      expect(history).toHaveLength(0);
      const searchDocs = await ctx.db
        .query("transactionSearchDocuments")
        .withIndex("by_circle", (q) => q.eq("circleId", f.circleId))
        .collect();
      expect(searchDocs).toHaveLength(0);
      expect((await ctx.db.get(f.circleId))?.currencyLocked).toBe(false);
      expect((await ctx.db.get(f.circleId))?.setupCompletedAt).toBeNull();
    });
  });
});

describe("createTransaction — currency lock side effect", () => {
  it("flips currencyLocked true on the first Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(f.circleId))?.currencyLocked).toBe(false);
    });

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(f.circleId))?.currencyLocked).toBe(true);
    });
  });

  it("leaves an already-locked Circle locked", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, {}));
    await t.run((ctx) => ctx.db.patch(f.circleId, { currencyLocked: true }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(f.circleId))?.currencyLocked).toBe(true);
    });
  });
});

/** A first-page query of `size` items (cursor null = from the start). */

describe("listTransactions", () => {
  it("returns active transactions sorted by date desc then created-at desc", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "Older",
      date: "2026-05-01",
    });
    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "Newer",
      date: "2026-05-20",
    });

    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page.map((txn) => txn.title)).toEqual(["Newer", "Older"]);
    expect(result.isDone).toBe(true);
    expect(result.page[0]?.paidBy.displayName).toBe("Olive Owner");
    expect(result.page[0]?.categories.map((c) => c.name)).toEqual(["Groceries"]);
  });

  it("orders same-date transactions by created-at desc", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "First",
      date: "2026-05-10",
    });
    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "Second",
      date: "2026-05-10",
    });

    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page.map((txn) => txn.title)).toEqual(["Second", "First"]);
  });

  it("paginates: a bounded page, isDone false, then the next page via the cursor", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    for (const date of ["2026-05-01", "2026-05-02", "2026-05-03"]) {
      await t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        title: `Txn ${date}`,
        date,
      });
    }

    const page1 = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(2),
    });
    expect(page1.page.map((txn) => txn.title)).toEqual(["Txn 2026-05-03", "Txn 2026-05-02"]);
    expect(page1.isDone).toBe(false);

    const page2 = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      paginationOpts: { numItems: 2, cursor: page1.continueCursor },
    });
    expect(page2.page.map((txn) => txn.title)).toEqual(["Txn 2026-05-01"]);
    expect(page2.isDone).toBe(true);
  });

  it("excludes archived transactions", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.run((ctx) => ctx.db.patch(id, { status: "archived", archivedAt: Date.now() }));
    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page).toHaveLength(0);
  });

  it("flips live when a Transaction is created (basis for RPT live tests)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    expect(
      (await t.query(api.transactions.listTransactions, { circleId: f.circleId, ...firstPage(25) }))
        .page.length,
    ).toBe(0);

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    expect(
      (await t.query(api.transactions.listTransactions, { circleId: f.circleId, ...firstPage(25) }))
        .page.length,
    ).toBe(1);
  });

  it("returns an empty exhausted page for an inaccessible Circle (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
  });

  it("returns an empty exhausted page for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(null);
    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
  });

  it("marks canEditFields true for the viewer's own Transactions, false for others", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Mine", recordedByMemberId: f.ownerMemberId }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Theirs", recordedByMemberId: other.memberId }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    const byTitle = new Map(result.page.map((txn) => [txn.title, txn.canEditFields]));
    expect(byTitle.get("Mine")).toBe(true);
    expect(byTitle.get("Theirs")).toBe(false);
  });
});

describe("updateTransaction — field edits", () => {
  it("edits title/amount/date and records one 'edited' event with only changed fields", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { currency: "USD" }));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    // Pin updatedAt to a sentinel so the post-edit bump is observable regardless of
    // clock granularity (the seed + edit can land in the same millisecond).
    await t.run((ctx) => ctx.db.patch(id, { updatedAt: 1 }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      title: "  Big shop  ",
      amountMinorUnits: 5000,
      date: "2026-06-02",
    });

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.title).toBe("Big shop"); // trimmed
      expect(txn?.amountMinorUnits).toBe(5000);
      expect(txn?.date).toBe("2026-06-02");
      expect(txn?.month).toBe("2026-06"); // bucket kept in sync
      expect(txn?.updatedAt).toBeGreaterThan(1); // bumped off the sentinel
      const searchDoc = await searchDocumentOf(ctx, id);
      expect(searchDoc?.searchText).toBe(transactionSearchText({ title: "Big shop" }));
      expect(searchDoc?.date).toBe("2026-06-02");

      const events = await historyOf(ctx, id);
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("edited");
      expect(events[0]?.actorMemberId).toBe(f.ownerMemberId);
      expect(events[0]?.changes).toEqual([
        { field: "title", from: "Weekly shop", to: "Big shop" },
        // Typed money from/to, frozen with the Circle Currency (ADR 0021).
        {
          field: "amount",
          fromMoney: { minorUnits: 1250, currency: "USD" },
          toMoney: { minorUnits: 5000, currency: "USD" },
        },
        { field: "date", from: "2026-05-15", to: "2026-06-02" },
      ]);
    });
  });

  it("syncs transactionCategories ordering fields when only the date changes", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { date: "2026-05-15", createdAt: 100 }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      date: "2026-06-02",
    });

    await t.run(async (ctx) => {
      const links = await ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", id))
        .collect();
      expect(links).toHaveLength(1);
      expect(links[0]?.transactionDate).toBe("2026-06-02");
      expect(links[0]?.transactionCreatedAt).toBe(100);
    });
  });

  it("is a true no-op when nothing actually changes (no patch, no history)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const before = await t.run(async (ctx) => (await ctx.db.get(id))?.updatedAt);
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      title: "Weekly shop", // same value
      amountMinorUnits: 1250, // same value
      categoryIds: [f.groceriesId], // same set
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.updatedAt).toBe(before); // not bumped
      expect(await historyOf(ctx, id)).toHaveLength(0); // no spurious event
    });
  });

  it("treats reordering the same categories as a no-op", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { categoryIds: [f.groceriesId, f.diningId] }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      categoryIds: [f.diningId, f.groceriesId], // reversed, same set
    });
    await t.run(async (ctx) => {
      expect(await historyOf(ctx, id)).toHaveLength(0);
    });
  });

  it("adds, changes, and clears the note with the right from/to", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    // Add a note (from absent).
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.mutation(api.transactions.updateTransaction, { transactionId: id, note: "  eggs  " });
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.note).toBe("eggs");
      expect((await searchDocumentOf(ctx, id))?.searchText).toBe(
        transactionSearchText({ title: "Weekly shop", note: "eggs" }),
      );
      expect((await historyOf(ctx, id))[0]?.changes).toEqual([{ field: "note", to: "eggs" }]);
    });

    // Change the note (from + to).
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      note: "eggs and milk",
    });
    await t.run(async (ctx) => {
      expect((await historyOf(ctx, id))[0]?.changes).toEqual([
        { field: "note", from: "eggs", to: "eggs and milk" },
      ]);
    });

    // Clear the note with "" (from only; field removed).
    await t.mutation(api.transactions.updateTransaction, { transactionId: id, note: "  " });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.note).toBeUndefined();
      expect((await historyOf(ctx, id))[0]?.changes).toEqual([
        { field: "note", from: "eggs and milk" },
      ]);
    });
  });

  it("records multiple field edits as one event with multiple changes (no raw ids)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      title: "Renamed",
      categoryIds: [f.diningId],
    });
    await t.run(async (ctx) => {
      const events = await historyOf(ctx, id);
      expect(events).toHaveLength(1);
      expect(events[0]?.changes).toEqual([
        { field: "title", from: "Weekly shop", to: "Renamed" },
        { field: "categories", from: "Groceries", to: "Dining" },
      ]);
      for (const change of events[0]?.changes ?? []) {
        expect(change.to).not.toBe(id);
        expect(change.to).not.toBe(f.diningId);
      }
    });
  });

  it.each([
    ["zero amount", { amountMinorUnits: 0 }],
    ["non-integer amount", { amountMinorUnits: 12.5 }],
    ["over-max amount", { amountMinorUnits: 99_999_999_999 + 1 }],
    ["empty title", { title: "   " }],
    ["over-max title", { title: "x".repeat(121) }],
    ["over-max note", { note: "x".repeat(1001) }],
    ["bad date", { date: "2026-13-01" }],
  ])("rejects an invalid %s like create does", async (_label, patch) => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, ...patch }),
    ).rejects.toThrow();
  });
});

describe("updateTransaction — Paid By", () => {
  it("changes Paid By to another current Member and records the from/to", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      paidByMemberId: other.memberId,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.paidByMemberId).toBe(other.memberId);
      expect((await historyOf(ctx, id))[0]?.changes).toEqual([
        { field: "paidBy", from: "Olive Owner", to: "Maya Member" },
      ]);
    });
  });

  it("rejects changing Paid By to a Removed Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "r@example.com", "Rex Removed", "removed"),
    );
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        paidByMemberId: removed.memberId,
      }),
    ).rejects.toThrow(/current member of this circle/i);
  });

  it("rejects changing Paid By to a Member of another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const foreignMemberId = await t.run(async (ctx) => (await seedCircle(ctx)).ownerMemberId);
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        paidByMemberId: foreignMemberId,
      }),
    ).rejects.toThrow(/current member of this circle/i);
  });

  it("keeping the same Paid By is a no-op (no validation, no event)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { paidByMemberId: f.ownerMemberId }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      paidByMemberId: f.ownerMemberId,
    });
    await t.run(async (ctx) => {
      expect(await historyOf(ctx, id)).toHaveLength(0);
    });
  });
});

describe("updateTransaction — categories (same type)", () => {
  it("rewrites the category set and records the from/to", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { categoryIds: [f.groceriesId] }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      categoryIds: [f.groceriesId, f.diningId],
    });
    await t.run(async (ctx) => {
      expect(await categoryIdsOf(ctx, id)).toEqual([f.groceriesId, f.diningId]);
      const searchDoc = await searchDocumentOf(ctx, id);
      expect(searchDoc?.categoryId0).toBe(f.groceriesId);
      expect(searchDoc?.categoryId1).toBe(f.diningId);
      expect(searchDoc?.categoryId2).toBeUndefined();
      expect((await historyOf(ctx, id))[0]?.changes).toEqual([
        { field: "categories", from: "Groceries", to: "Groceries, Dining" },
      ]);
    });
  });

  it("keeps an already-attached Category that was archived mid-life (PRD 57)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    // Groceries is attached, THEN archived; the edit (changing another field) must
    // not reject for the still-attached archived Category.
    const id = await t.run((ctx) => seedTransaction(ctx, f, { categoryIds: [f.groceriesId] }));
    await t.run((ctx) =>
      ctx.db.patch(f.groceriesId, { status: "archived", archivedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      categoryIds: [f.groceriesId], // keep the already-attached archived one
      title: "Renamed",
    });
    await t.run(async (ctx) => {
      expect(await categoryIdsOf(ctx, id)).toEqual([f.groceriesId]);
    });
  });

  it("rejects NEWLY adding an archived Category", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const archivedId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old",
        type: "expense",
        status: "archived",
        creatorUserId: f.owner._id,
      }),
    );
    const id = await t.run((ctx) => seedTransaction(ctx, f, { categoryIds: [f.groceriesId] }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        categoryIds: [f.groceriesId, archivedId],
      }),
    ).rejects.toThrow(/archived categories cannot be added/i);
  });

  it("rejects a category of the wrong type and one from another Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    const foreignId = await t.run(async (ctx) => {
      const other = await seedCircle(ctx);
      return makeCategory(ctx, other.circleId, {
        name: "Foreign",
        type: "expense",
        creatorUserId: other.owner._id,
      });
    });
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        categoryIds: [f.salaryId], // income category on an expense
      }),
    ).rejects.toThrow(/type does not match/i);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        categoryIds: [foreignId],
      }),
    ).rejects.toThrow(/not found in this circle/i);
  });

  it("rejects emptying the category set", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, categoryIds: [] }),
    ).rejects.toThrow();
  });
});

describe("updateTransaction — type change", () => {
  it("changes type, clears old categories, attaches new ones, and records 'type changed'", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { type: "expense", categoryIds: [f.groceriesId, f.diningId] }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      type: "income",
      categoryIds: [f.salaryId],
    });
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.type).toBe("income");
      expect(await categoryIdsOf(ctx, id)).toEqual([f.salaryId]); // old cleared, new set
      const events = await historyOf(ctx, id);
      expect(events[0]?.action).toBe("type changed");
      expect(events[0]?.changes).toEqual([
        { field: "type", from: "expense", to: "income" },
        { field: "categories", from: "Groceries, Dining", to: "Salary" },
      ]);
    });
  });

  it("requires categories of the new type — none supplied is rejected", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { type: "expense" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, type: "income" }),
    ).rejects.toThrow(/requires categories of the new type/i);
  });

  it("rejects old-type categories supplied with the new type", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { type: "expense" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        type: "income",
        categoryIds: [f.groceriesId], // still an expense category
      }),
    ).rejects.toThrow(/type does not match/i);
  });

  it("rejects an archived new-type category on a type change", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const archivedIncome = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old Income",
        type: "income",
        status: "archived",
        creatorUserId: f.owner._id,
      }),
    );
    const id = await t.run((ctx) => seedTransaction(ctx, f, { type: "expense" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        type: "income",
        categoryIds: [archivedIncome],
      }),
    ).rejects.toThrow(/archived categories cannot be added/i);
  });
});

describe("updateTransaction — permission matrix", () => {
  it("allows the Recorded By Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Mine edited" }),
    ).resolves.toBeTruthy();
  });

  it("forbids the Owner from editing another Member's fields (TXN-3 moderation only)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Owner edit" }),
    ).rejects.toThrow(/only the member who recorded/i);
  });

  it("forbids a non-recorder Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: f.ownerMemberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Nope" }),
    ).rejects.toThrow(/only the member who recorded/i);
  });

  it("forbids a Removed Recorded By, then allows them again on rejoin (PRD 44)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    // Removed: the SAME member row flips to removed → access collapses to not-found.
    await t.run((ctx) =>
      ctx.db.patch(member.memberId, { status: "removed", removedAt: Date.now() }),
    );
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "While removed" }),
    ).rejects.toThrow("Transaction not found");

    // Rejoin reactivates the SAME row, so recordedByMemberId matches again — edit rights restored.
    await t.run((ctx) => ctx.db.patch(member.memberId, { status: "active" }));
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Rejoined edit" }),
    ).resolves.toBeTruthy();
  });

  it("forbids edits after removeMember flips the Recorded By Member (MEM-5)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.members.removeMember, { circleId: f.circleId, memberId: member.memberId });

    mockCurrentUser.mockResolvedValue(member.user);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "While removed" }),
    ).rejects.toThrow("Transaction not found");
  });

  it("hides existence from a non-member and an unauthenticated caller (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));

    mockCurrentUser.mockResolvedValue(stranger);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toThrow("Transaction not found");

    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toThrow("Transaction not found");
  });

  it("throws the SAME 'Transaction not found' for a missing Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    // A real-but-deleted id keeps the Convex arg validator happy while the row is gone.
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.run((ctx) => ctx.db.delete(id));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toThrow("Transaction not found");
  });
});

describe("updateTransaction — lifecycle edges", () => {
  it("rejects editing an archived Transaction (frozen — PRD 40)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toThrow(/archived transactions can't be edited/i);
  });

  it("rejects editing in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.run((ctx) => ctx.db.patch(f.circleId, { status: "archived", archivedAt: Date.now() }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects editing on an incomplete regular Circle without mutating the Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { setupCompletedAt: null }));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Changed" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.title).toBe("Weekly shop");
      expect(await historyOf(ctx, id)).toHaveLength(0);
      const search = await searchDocumentOf(ctx, id);
      expect(search?.searchText).toContain("weekly shop");
    });
  });
});

describe("listTransactions — view shape", () => {
  it("returns the canonical slug-id ref on each row (TXN-5)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const result = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(result.page[0]?.ref).toBe(buildRef("Weekly shop", id));
  });
});

describe("archiveTransaction — permissions (TXN-3)", () => {
  it("lets the Recorded By Member archive their own Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.status).toBe("archived");
      expect(txn?.archivedAt).toBeTypeOf("number");
    });
  });

  it("lets the Owner archive another Member's Transaction (moderation)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await mutateAndDrain(t, () =>
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    );
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.status).toBe("archived");

      const notifications = await listNotificationsForUser(ctx, member.user._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("transaction.archived");
    });
  });

  it("forbids a non-owner, non-creator Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    // Recorded by the owner; Maya is neither the recorder nor the owner.
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: f.ownerMemberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow(/only the recorder or the owner/i);
  });

  it("forbids a Removed creator, then allows them again on rejoin (PRD 44)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await t.run((ctx) =>
      ctx.db.patch(member.memberId, { status: "removed", removedAt: Date.now() }),
    );
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow("Transaction not found");

    await t.run((ctx) => ctx.db.patch(member.memberId, { status: "active" }));
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).resolves.toBeTruthy();
  });

  it("hides existence from a non-member, an unauthenticated caller, and a missing Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));

    mockCurrentUser.mockResolvedValue(stranger);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow("Transaction not found");

    mockCurrentUser.mockResolvedValue(null);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow("Transaction not found");

    await t.run((ctx) => ctx.db.delete(id));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow("Transaction not found");
  });
});

describe("archiveTransaction — Owner gains no field-edit via this path (TXN-3)", () => {
  it("rejects the Owner editing fields of a Transaction they archived", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });
    // Even after restoring it (so it's no longer frozen), the Owner still can't edit
    // another Member's fields — archive/restore is moderation only (PRD 39).
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Owner rewrite" }),
    ).rejects.toThrow(/only the member who recorded/i);
  });
});

describe("archiveTransaction — frozen & state edges (TXN-3)", () => {
  it("rejects archiving an already-archived Transaction (no silent no-op)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toThrow(/already archived/i);
  });

  it("freezes the Transaction — editing an archived one is rejected (TXN-2 invariant)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "x" }),
    ).rejects.toThrow(/archived transactions can't be edited/i);
  });

  it("rejects archiving in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.run((ctx) => ctx.db.patch(f.circleId, { status: "archived", archivedAt: Date.now() }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects archiving on an incomplete regular Circle without side effects", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { setupCompletedAt: null }));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);

    await expect(
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.status).toBe("active");
      expect(await historyOf(ctx, id)).toHaveLength(0);
      expect((await searchDocumentOf(ctx, id))?.status).toBe("active");
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });
});

describe("archiveTransaction — reporting contract & history (TXN-3)", () => {
  it("excludes an archived Transaction from the default active list, includes it in the archived view", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });

    const active = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(active.page).toHaveLength(0);

    const archived = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      status: "archived",
      ...firstPage(25),
    });
    expect(archived.page.map((txn) => txn.title)).toEqual(["Weekly shop"]);
    expect(archived.page[0]?.status).toBe("archived");
  });

  it("records an 'archived' event with the moderator as actor, no field changes, no raw ids", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId }),
    );
    // The OWNER moderates — the actor must be the owner, not the recorder.
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });

    await t.run(async (ctx) => {
      const events = await historyOf(ctx, id);
      expect(events[0]?.action).toBe("archived");
      expect(events[0]?.actorMemberId).toBe(f.ownerMemberId);
      expect(events[0]?.changes).toEqual([]);
    });
  });
});

describe("restoreTransaction (TXN-3)", () => {
  it("lets the Recorded By Member restore their own archived Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId, status: "archived" }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });
    await t.run(async (ctx) => {
      const txn = await ctx.db.get(id);
      expect(txn?.status).toBe("active");
      expect(txn?.archivedAt).toBeUndefined(); // cleared on restore
    });
  });

  it("lets the Owner restore another Member's archived Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: member.memberId, status: "archived" }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.status).toBe("active");
    });
  });

  it("forbids a non-owner, non-creator Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: f.ownerMemberId, status: "archived" }),
    );
    mockCurrentUser.mockResolvedValue(member.user);
    await expect(
      t.mutation(api.transactions.restoreTransaction, { transactionId: id }),
    ).rejects.toThrow(/only the recorder or the owner/i);
  });

  it("rejects restoring an active Transaction (no silent no-op)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.restoreTransaction, { transactionId: id }),
    ).rejects.toThrow(/not archived/i);
  });

  it("rejects restoring in an archived Circle", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    await t.run((ctx) => ctx.db.patch(f.circleId, { status: "archived", archivedAt: Date.now() }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await expect(
      t.mutation(api.transactions.restoreTransaction, { transactionId: id }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects restoring on an incomplete regular Circle without side effects", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx, { setupCompletedAt: null }));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await expect(
      t.mutation(api.transactions.restoreTransaction, { transactionId: id }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(id))?.status).toBe("archived");
      expect(await historyOf(ctx, id)).toHaveLength(0);
      expect((await searchDocumentOf(ctx, id))?.status).toBe("archived");
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });

  it("records a 'restored' event with the moderator as actor and no field changes", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });
    await t.run(async (ctx) => {
      const events = await historyOf(ctx, id);
      expect(events[0]?.action).toBe("restored");
      expect(events[0]?.actorMemberId).toBe(f.ownerMemberId);
      expect(events[0]?.changes).toEqual([]);
    });
  });

  it("re-enters the active list and is editable by its recorder again after restore", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });

    const active = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    expect(active.page.map((txn) => txn.title)).toEqual(["Weekly shop"]);
    // Editing works again now that it's no longer frozen.
    await expect(
      t.mutation(api.transactions.updateTransaction, { transactionId: id, title: "Edited again" }),
    ).resolves.toBeTruthy();
  });
});

describe("listTransactions — canArchive flag (TXN-3)", () => {
  it("marks canArchive for the recorder and the Owner, but not a non-owner non-creator", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const member = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Owner txn", recordedByMemberId: f.ownerMemberId }),
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Maya txn", recordedByMemberId: member.memberId }),
    );

    // The Owner can archive both (own + moderation).
    mockCurrentUser.mockResolvedValue(f.owner);
    const ownerView = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    const ownerByTitle = new Map(ownerView.page.map((txn) => [txn.title, txn.canArchive]));
    expect(ownerByTitle.get("Owner txn")).toBe(true);
    expect(ownerByTitle.get("Maya txn")).toBe(true);

    // Maya can archive only her own; canEditFields tracks recorder-only too.
    mockCurrentUser.mockResolvedValue(member.user);
    const mayaView = await t.query(api.transactions.listTransactions, {
      circleId: f.circleId,
      ...firstPage(25),
    });
    const mayaArchive = new Map(mayaView.page.map((txn) => [txn.title, txn.canArchive]));
    expect(mayaArchive.get("Owner txn")).toBe(false);
    expect(mayaArchive.get("Maya txn")).toBe(true);
  });
});

describe("getEditableTransaction — edit target resolution (TXN-5)", () => {
  it("returns the editable Transaction with its canonical ref for the Recorded By Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const view = await t.query(api.transactions.getEditableTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
    expect(view?.ref).toBe(buildRef("Weekly shop", id));
    expect(view?.canEditFields).toBe(true);
  });

  it("returns null for a missing Transaction (deleted)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.run((ctx) => ctx.db.delete(id));
    mockCurrentUser.mockResolvedValue(f.owner);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("returns null for a malformed Transaction id (normalizes to null, never throws)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: "not-a-real-id",
      }),
    ).toBeNull();
  });

  it("returns null when the Transaction belongs to a different Circle than the URL's", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, other));
    // The caller can access BOTH circles, but the ref names `f` while the Transaction
    // lives in `other` — a wrong-Circle link must not resolve (anti-enumeration).
    await t.run((ctx) =>
      ctx.db.insert("members", {
        circleId: other.circleId,
        userId: f.owner._id,
        role: "member",
        status: "active",
        displayName: f.owner.displayName,
        joinedAt: Date.now(),
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("returns null for an archived (frozen) Transaction — an edit link means active", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("returns null for a non-recorder Member — even the Owner (no edit via the URL)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId: alexMemberId, user: alex } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "alex@example.com", "Alex"),
    );
    // Alex records it; the Owner (who can moderate but not field-edit) opens the link.
    const id = await t.run((ctx) => seedTransaction(ctx, f, { recordedByMemberId: alexMemberId }));
    mockCurrentUser.mockResolvedValue(f.owner);
    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();

    // Alex (the recorder) does resolve it.
    mockCurrentUser.mockResolvedValue(alex);
    const view = await t.query(api.transactions.getEditableTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
  });

  it("returns null when the caller is not a member of the Circle (inaccessible ≡ missing)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    const outsider = await t.run((ctx) => makeUser(ctx, "out@example.com", "Outsider"));
    mockCurrentUser.mockResolvedValue(outsider);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("returns null for a Removed Member (live revocation)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId, user } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "rex@example.com", "Rex"),
    );
    const id = await t.run((ctx) => seedTransaction(ctx, f, { recordedByMemberId: memberId }));
    mockCurrentUser.mockResolvedValue(user);
    // While active + the recorder, Rex resolves it.
    expect(
      (
        await t.query(api.transactions.getEditableTransaction, {
          circleId: f.circleId,
          transactionId: id,
        })
      )?.id,
    ).toBe(id);
    // Removed: access collapses to null even on his own Transaction.
    await t.run((ctx) => ctx.db.patch(memberId, { status: "removed", removedAt: Date.now() }));
    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("returns null when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(null);

    expect(
      await t.query(api.transactions.getEditableTransaction, {
        circleId: f.circleId,
        transactionId: id,
      }),
    ).toBeNull();
  });

  it("still resolves the recorder's active Transaction in an archived Circle (route owns read-only)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    await t.run((ctx) => ctx.db.patch(f.circleId, { status: "archived", archivedAt: Date.now() }));
    mockCurrentUser.mockResolvedValue(f.owner);

    // The query does not special-case an archived Circle (a Member keeps access); the
    // edit route surfaces read-only in place rather than ejecting (ADR 0017).
    const view = await t.query(api.transactions.getEditableTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
  });
});

describe("getTransaction — detail resolution (TXN-4)", () => {
  it("returns the detail view with canonical ref + capability flags for the recorder", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { title: "Weekly shop" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
    expect(view?.ref).toBe(buildRef("Weekly shop", id));
    expect(view?.title).toBe("Weekly shop");
    expect(view?.canEditFields).toBe(true); // the recorder
    expect(view?.canArchive).toBe(true);
    expect(view?.categories.map((c) => c.name)).toEqual(["Groceries"]);
  });

  it("resolves for ANY current Member, not just the recorder (read surface)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId: alexMemberId } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "alex@example.com", "Alex"),
    );
    // Alex records it; the Owner (a non-recorder) opens the DETAIL — must resolve.
    const id = await t.run((ctx) => seedTransaction(ctx, f, { recordedByMemberId: alexMemberId }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
    // The Owner cannot field-edit another Member's Transaction, but may archive it.
    expect(view?.canEditFields).toBe(false);
    expect(view?.canArchive).toBe(true);
  });

  it("resolves an ARCHIVED (frozen) Transaction — detail is a read surface", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { status: "archived" }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.id).toBe(id);
    expect(view?.status).toBe("archived");
  });

  it("returns null for a non-member, a different-Circle Transaction, a missing/malformed id, and unauthenticated (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const id = await t.run((ctx) => seedTransaction(ctx, f));

    // Non-member.
    const outsider = await t.run((ctx) => makeUser(ctx, "out@example.com", "Outsider"));
    mockCurrentUser.mockResolvedValue(outsider);
    expect(
      await t.query(api.transactions.getTransaction, { circleId: f.circleId, transactionId: id }),
    ).toBeNull();

    // A Transaction in ANOTHER Circle than the URL's, even though the caller can see both.
    const other = await t.run((ctx) => seedFixture(ctx));
    const otherTxn = await t.run((ctx) => seedTransaction(ctx, other));
    await t.run((ctx) =>
      ctx.db.insert("members", {
        circleId: other.circleId,
        userId: f.owner._id,
        role: "member",
        status: "active",
        displayName: f.owner.displayName,
        joinedAt: Date.now(),
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    expect(
      await t.query(api.transactions.getTransaction, {
        circleId: f.circleId,
        transactionId: otherTxn,
      }),
    ).toBeNull();

    // Missing (deleted) and malformed ids.
    await t.run((ctx) => ctx.db.delete(id));
    expect(
      await t.query(api.transactions.getTransaction, { circleId: f.circleId, transactionId: id }),
    ).toBeNull();
    expect(
      await t.query(api.transactions.getTransaction, {
        circleId: f.circleId,
        transactionId: "not-a-real-id",
      }),
    ).toBeNull();

    // Unauthenticated.
    mockCurrentUser.mockResolvedValue(null);
    expect(
      await t.query(api.transactions.getTransaction, {
        circleId: f.circleId,
        transactionId: otherTxn,
      }),
    ).toBeNull();
  });

  it("flips to null when the viewing Member is removed (live revocation)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId, user } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "rex@example.com", "Rex"),
    );
    const id = await t.run((ctx) => seedTransaction(ctx, f));
    mockCurrentUser.mockResolvedValue(user);
    expect(
      (await t.query(api.transactions.getTransaction, { circleId: f.circleId, transactionId: id }))
        ?.id,
    ).toBe(id);
    await t.run((ctx) => ctx.db.patch(memberId, { status: "removed", removedAt: Date.now() }));
    expect(
      await t.query(api.transactions.getTransaction, { circleId: f.circleId, transactionId: id }),
    ).toBeNull();
  });
});

describe("getTransaction — Audit Metadata (TXN-4, PRD 76)", () => {
  it("created-by is the recorder and created-at is the creation instant; both pairs are display-name only (no raw IDs)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    const txn = await t.run((ctx) => ctx.db.get(id));
    expect(view?.audit.createdBy.displayName).toBe("Olive Owner");
    expect(view?.audit.createdAt).toBe(txn?.createdAt);
    // No internal id leaks into the audit display (PRD 80): the Member id is its own
    // field, the display name is a human string, never the raw owner Member id.
    expect(view?.audit.createdBy.displayName).not.toBe(f.ownerMemberId);
    // With only a create event, updated == created.
    expect(view?.audit.updatedBy.displayName).toBe("Olive Owner");
  });

  it("updated-by/at reflect the LAST editor and the edit instant", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    const created = await t.run((ctx) => ctx.db.get(id));
    // A later field edit by the recorder.
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      title: "Weekly shop v2",
    });

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.audit.createdBy.displayName).toBe("Olive Owner");
    expect(view?.audit.updatedBy.displayName).toBe("Olive Owner");
    expect(view?.audit.updatedAt).toBeGreaterThanOrEqual(created?.createdAt ?? 0);
    // The newest event drives "updated" — its timestamp, not the stale creation one.
    const latest = await t.run((ctx) => historyOf(ctx, id));
    expect(view?.audit.updatedAt).toBe(latest[0]?.createdAt);
  });

  it("updated-by reflects a moderator who archived another Member's Transaction (distinct from created-by)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId: alexMemberId, user: alex } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "alex@example.com", "Alex"),
    );
    // Alex records it.
    mockCurrentUser.mockResolvedValue(alex);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      paidByMemberId: alexMemberId,
    });
    // The Owner archives it (moderation) — the last change to the record.
    mockCurrentUser.mockResolvedValue(f.owner);
    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });

    const view = await t.query(api.transactions.getTransaction, {
      circleId: f.circleId,
      transactionId: id,
    });
    expect(view?.audit.createdBy.displayName).toBe("Alex");
    expect(view?.audit.updatedBy.displayName).toBe("Olive Owner");
  });
});

describe("listTransactionHistory — Transaction History content (TXN-4, PRD 77)", () => {
  it("renders events newest-first with actor Display Name, field names, and old/new values", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "Weekly shop",
    });
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      title: "Renamed shop",
    });

    const result = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      ...firstPage(25),
    });
    expect(result.page.map((e) => e.action)).toEqual(["edited", "created"]);
    expect(result.page[0]?.actor?.displayName).toBe("Olive Owner");
    const titleChange = result.page[0]?.changes.find((c) => c.field === "title");
    expect(titleChange?.from).toBe("Weekly shop");
    expect(titleChange?.to).toBe("Renamed shop");
  });

  it("freezes money changes as typed minor units + Currency (not a formatted string)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      amountMinorUnits: 1250,
    });
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      amountMinorUnits: 9900,
    });

    const result = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      ...firstPage(25),
    });
    const amountChange = result.page[0]?.changes.find((c) => c.field === "amount");
    expect(amountChange?.fromMoney).toEqual({ minorUnits: 1250, currency: "USD" });
    expect(amountChange?.toMoney).toEqual({ minorUnits: 9900, currency: "USD" });
    // No preformatted string snuck onto the money field.
    expect(amountChange?.from).toBeUndefined();
    expect(amountChange?.to).toBeUndefined();
  });

  it("never exposes a raw internal Id in any change value (PRD 80)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { memberId: alexMemberId, user: alex } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "alex@example.com", "Alex"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);
    // Touch every field type that records a value: paidBy (a Member), categories
    // (Categories), date, title, amount — none may surface as an id.
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      paidByMemberId: alexMemberId,
      categoryIds: [f.diningId],
      date: "2026-06-01",
    });

    const result = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      ...firstPage(25),
    });
    const ids = new Set<string>([
      id,
      f.circleId,
      f.groceriesId,
      f.diningId,
      f.ownerMemberId,
      alexMemberId,
      alex._id,
    ]);
    for (const event of result.page) {
      for (const change of event.changes) {
        for (const value of [change.from, change.to]) {
          if (value == null) continue;
          expect(ids.has(value)).toBe(false);
          // A defensive heuristic against any long opaque token leaking through.
          expect(value).not.toMatch(/^[a-z0-9]{20,}$/);
        }
      }
    }
    // The values that DID get recorded are the human-readable ones.
    const paidBy = result.page[0]?.changes.find((c) => c.field === "paidBy");
    expect(paidBy?.to).toBe("Alex");
    const categories = result.page[0]?.changes.find((c) => c.field === "categories");
    expect(categories?.to).toBe("Dining");
  });

  it("includes archived / restored / type-change events after those actions", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: id,
      type: "income",
      categoryIds: [f.salaryId],
    });
    await t.mutation(api.transactions.archiveTransaction, { transactionId: id });
    await t.mutation(api.transactions.restoreTransaction, { transactionId: id });

    const result = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      ...firstPage(25),
    });
    expect(result.page.map((e) => e.action)).toEqual([
      "restored",
      "archived",
      "type changed",
      "created",
    ]);
  });

  it("returns an empty page for a non-member, a different-Circle Transaction, and a missing id (anti-enumeration parity with listTransactions)", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
    });

    // Non-member.
    const outsider = await t.run((ctx) => makeUser(ctx, "out@example.com", "Outsider"));
    mockCurrentUser.mockResolvedValue(outsider);
    const nonMember = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      ...firstPage(25),
    });
    expect(nonMember).toEqual({ page: [], isDone: true, continueCursor: "" });

    // Different-Circle Transaction (caller is a member of `f` only).
    mockCurrentUser.mockResolvedValue(f.owner);
    const other = await t.run((ctx) => seedFixture(ctx));
    const otherTxn = await t.run((ctx) => seedTransaction(ctx, other));
    const wrongCircle = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: otherTxn,
      ...firstPage(25),
    });
    expect(wrongCircle.page).toEqual([]);
    expect(wrongCircle.isDone).toBe(true);

    // Malformed id.
    const malformed = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: "not-a-real-id",
      ...firstPage(25),
    });
    expect(malformed.page).toEqual([]);
  });

  it("paginates at the source — a bounded first page plus a cursor to the rest", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);
    const id = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      ...baseExpense([f.groceriesId]),
      title: "Edit me",
    });
    // Five field edits → six events total (create + 5). A page of three must not be the
    // whole set: the query pages off the index rather than collecting everything.
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.transactions.updateTransaction, {
        transactionId: id,
        title: `Edit me ${i}`,
      });
    }

    const first = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page).toHaveLength(3);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.transactions.listTransactionHistory, {
      circleId: f.circleId,
      transactionId: id,
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(3);
    expect(second.isDone).toBe(true);
    // No id appears twice across the two pages — a real continuation, not a re-read.
    const allIds = [...first.page, ...second.page].map((e) => e.id);
    expect(new Set(allIds).size).toBe(6);
  });
});
