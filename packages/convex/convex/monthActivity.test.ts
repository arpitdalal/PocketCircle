import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { addMember, type Fixture, seedFixture, seedTransaction } from "../test/seed.js";
import type { Id } from "./_generated/dataModel.js";
import {
  collectMonthTransactions,
  type MonthTransactionScope,
  monthDateRange,
  sumMonthTotals,
} from "./monthActivity.js";
import schema from "./schema.js";

// `sumMonthTotals` is the single home of the Income/Expense/Net reporting math
// shared by the Monthly Ledger and the Dashboard (RPT-1/RPT-3). It reads only
// `type` + `amountMinorUnits`, so it is exercised here as the pure reducer it is —
// the index-backed collect and access checks are covered through the query handlers
// in ledger.test.ts / dashboard.test.ts.
describe("sumMonthTotals", () => {
  it("returns zeros for an empty set", () => {
    expect(sumMonthTotals([])).toEqual({ incomeMinor: 0, expenseMinor: 0, netMinor: 0 });
  });

  it("sums income and expense separately and nets them in minor units", () => {
    const totals = sumMonthTotals([
      { type: "income", amountMinorUnits: 500_000 },
      { type: "expense", amountMinorUnits: 1_250 },
      { type: "expense", amountMinorUnits: 7_500 },
    ]);
    expect(totals).toEqual({ incomeMinor: 500_000, expenseMinor: 8_750, netMinor: 491_250 });
  });

  it("nets negative when expenses exceed income", () => {
    expect(
      sumMonthTotals([
        { type: "income", amountMinorUnits: 2_000 },
        { type: "expense", amountMinorUnits: 9_000 },
      ]),
    ).toEqual({ incomeMinor: 2_000, expenseMinor: 9_000, netMinor: -7_000 });
  });
});

describe("monthDateRange", () => {
  it("yields the half-open [month, next-month) plain-date range", () => {
    expect(monthDateRange("2026-06")).toEqual({ start: "2026-06", endExclusive: "2026-07" });
  });

  it("rolls the year over at the December boundary", () => {
    expect(monthDateRange("2026-12")).toEqual({ start: "2026-12", endExclusive: "2027-01" });
  });
});

// The lifecycle-scoped month read itself (ADR 0036): totals surfaces pin `active`, a
// list-derived aggregate passes its list's scope. Exercised here against the real
// indexes so the scope contract cannot drift behind the query handlers that call it.
describe("collectMonthTransactions", () => {
  const modules = import.meta.glob("./**/*.ts");

  /** One active + one archived Transaction for the owner, one active for another Member. */
  async function seedScopedMonth(t: ReturnType<typeof convexTest>, f: Fixture) {
    const other = await t.run((ctx) => addMember(ctx, f.circleId, "alex@example.com", "Alex"));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, { amountMinorUnits: 1_000, date: "2026-06-10" });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 2_000,
        date: "2026-06-11",
        status: "archived",
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 3_000,
        date: "2026-06-12",
        paidByMemberId: other.memberId,
      });
      // A neighbouring month never leaks in.
      await seedTransaction(ctx, f, { amountMinorUnits: 4_000, date: "2026-05-31" });
    });
    return other.memberId;
  }

  function amountReader(
    t: ReturnType<typeof convexTest>,
    f: Fixture,
    paidByMemberId?: Id<"members">,
  ) {
    return async (status?: MonthTransactionScope) =>
      (
        await t.run((ctx) =>
          collectMonthTransactions(
            ctx,
            f.circleId,
            "2026-06",
            ...(status === undefined
              ? []
              : paidByMemberId === undefined
                ? [status]
                : [status, paidByMemberId]),
          ),
        )
      )
        .map((txn) => txn.amountMinorUnits)
        .sort((a, b) => a - b);
  }

  it("defaults to active and spans archived and both under each scope", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    await seedScopedMonth(t, f);
    const amountsIn = amountReader(t, f);

    expect(await amountsIn()).toEqual([1_000, 3_000]);
    expect(await amountsIn("active")).toEqual([1_000, 3_000]);
    expect(await amountsIn("archived")).toEqual([2_000]);
    expect(await amountsIn("all")).toEqual([1_000, 2_000, 3_000]);
  });

  it("narrows to one Paid By member under every scope, `all` included", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const otherMemberId = await seedScopedMonth(t, f);
    const otherPayer = amountReader(t, f, otherMemberId);
    const ownerPayer = amountReader(t, f, f.ownerMemberId);

    expect(await otherPayer("active")).toEqual([3_000]);
    expect(await otherPayer("archived")).toEqual([]);
    expect(await otherPayer("all")).toEqual([3_000]);
    expect(await ownerPayer("all")).toEqual([1_000, 2_000]);
  });
});
