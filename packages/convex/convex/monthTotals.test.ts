import { currentMonth } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { addMember, seedFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

vi.mock("./auth.js", async () => (await import("../test/mockAuth.js")).authMockModule());

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  resetMockCurrentUser();
});

describe("month totals maintenance (RPT-8 PR2)", () => {
  it("keeps ledger totals in sync across create, month move, archive, restore", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    signInAs(f.owner);

    const txnId = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "expense",
      title: "Lunch",
      amountMinorUnits: 2_500,
      date: "2026-06-10",
      categoryIds: [f.groceriesId],
      expectedCurrency: "USD",
    });

    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-06" }))
        ?.totals.expenseMinor,
    ).toBe(2_500);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: txnId,
      amountMinorUnits: 1_000,
      date: "2026-07-01",
    });

    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-06" }))
        ?.totals.expenseMinor,
    ).toBe(0);
    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-07" }))
        ?.totals.expenseMinor,
    ).toBe(1_000);

    await t.mutation(api.transactions.archiveTransaction, { transactionId: txnId });
    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-07" }))
        ?.totals.expenseMinor,
    ).toBe(0);

    await t.mutation(api.transactions.restoreTransaction, { transactionId: txnId });
    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-07" }))
        ?.totals.expenseMinor,
    ).toBe(1_000);
  });

  it("moves Circle totals on type flip and Paid-By reassignment", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    signInAs(f.owner);
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "maya@example.com", "Maya"));
    const month = currentMonth(new Date());
    const date = `${month}-10`;

    const txnId = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "expense",
      title: "Flip me",
      amountMinorUnits: 3_000,
      date,
      categoryIds: [f.groceriesId],
      expectedCurrency: "USD",
    });

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: txnId,
      type: "income",
      categoryIds: [f.salaryId],
    });

    const afterFlip = await t.query(api.ledger.getMonthlyLedger, {
      circleId: f.circleId,
      month,
    });
    expect(afterFlip?.totals).toEqual({
      incomeMinor: 3_000,
      expenseMinor: 0,
      netMinor: 3_000,
    });
    expect(
      (
        await t.query(api.homeSummary.getHomeSummary, {
          currency: "USD",
          range: 1,
        })
      )?.totals.incomeMinor,
    ).toBe(3_000);

    await t.mutation(api.transactions.updateTransaction, {
      transactionId: txnId,
      paidByMemberId: other.memberId,
    });

    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month }))?.totals
        .incomeMinor,
    ).toBe(3_000);
    expect(
      (
        await t.query(api.homeSummary.getHomeSummary, {
          currency: "USD",
          range: 1,
        })
      )?.totals.incomeMinor,
    ).toBe(0);
  });

  it("keeps Home Summary Paid-By attribution separate from Circle-wide ledger totals", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    signInAs(f.owner);
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "maya@example.com", "Maya"));
    const month = currentMonth(new Date());
    const date = `${month}-10`;

    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 4_000,
        date,
        paidByMemberId: other.memberId,
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_500,
        date,
        paidByMemberId: f.ownerMemberId,
      });
    });

    const ledger = await t.query(api.ledger.getMonthlyLedger, {
      circleId: f.circleId,
      month,
    });
    expect(ledger?.totals.expenseMinor).toBe(5_500);

    const summary = await t.query(api.homeSummary.getHomeSummary, {
      currency: "USD",
      range: 1,
    });
    expect(summary?.totals.expenseMinor).toBe(1_500);
  });

  it("initializes unbackfilled buckets from source truth on the next write", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    signInAs(f.owner);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        amountMinorUnits: 4_000,
        date: "2026-06-10",
      });
      // Simulate deploy over legacy data: Transactions exist, aggregate rows do not.
      for (const row of await ctx.db.query("circleMonthTotals").collect()) {
        await ctx.db.delete(row._id);
      }
      for (const row of await ctx.db.query("memberMonthTotals").collect()) {
        await ctx.db.delete(row._id);
      }
    });

    await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      type: "expense",
      title: "After deploy",
      amountMinorUnits: 1_000,
      date: "2026-06-12",
      categoryIds: [f.groceriesId],
      expectedCurrency: "USD",
    });

    expect(
      (await t.query(api.ledger.getMonthlyLedger, { circleId: f.circleId, month: "2026-06" }))
        ?.totals.expenseMinor,
    ).toBe(5_000);
  });
});
