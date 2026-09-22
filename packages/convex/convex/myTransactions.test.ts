import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { addMember, seedOwnedFixture, seedPersonalFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

vi.mock("./auth.js", async () => (await import("../test/mockAuth.js")).authMockModule());

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  resetMockCurrentUser();
});

describe("searchMyTransactions", () => {
  it("returns Paid-By-me Transactions across Circles, newest date first", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const trip = await t.run((ctx) =>
      seedOwnedFixture(ctx, personal.owner, { name: "Trip", currency: "CAD" }),
    );
    signInAs(personal.owner);

    await t.run(async (ctx) => {
      await seedTransaction(ctx, personal, {
        title: "Personal coffee",
        date: "2026-06-01",
        createdAt: 1,
      });
      await seedTransaction(ctx, trip, {
        title: "Trip dinner",
        date: "2026-06-10",
        createdAt: 2,
      });
      const other = await addMember(ctx, trip.circleId, "sam@example.com", "Sam");
      await seedTransaction(ctx, trip, {
        title: "Sam paid",
        date: "2026-06-15",
        recordedByMemberId: personal.ownerMemberId,
        paidByMemberId: other.memberId,
      });
    });

    const page = await t.query(api.myTransactions.searchMyTransactions, {
      type: "all",
      status: "all",
      page: 1,
    });

    expect(page.transactions.map((txn) => txn.title)).toEqual(["Trip dinner", "Personal coffee"]);
    expect(page.transactions[0]?.circle.name).toBe("Trip");
    expect(page.transactions[0]?.circle.currency).toBe("CAD");
    expect(page.totalCount).toBe(2);
  });

  it("includes Transactions recorded by someone else when Paid By is me", async () => {
    const t = convexTest(schema, modules);
    const trip = await t.run(async (ctx) => {
      const personal = await seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      });
      const owned = await seedOwnedFixture(ctx, personal.owner, { name: "Trip" });
      const sam = await addMember(ctx, owned.circleId, "sam@example.com", "Sam");
      await seedTransaction(ctx, owned, {
        title: "Sam recorded for Ada",
        recordedByMemberId: sam.memberId,
        paidByMemberId: owned.ownerMemberId,
      });
      return { personal, owned };
    });
    signInAs(trip.personal.owner);

    const page = await t.query(api.myTransactions.searchMyTransactions, {
      type: "all",
      status: "all",
      page: 1,
    });

    expect(page.transactions.map((txn) => txn.title)).toEqual(["Sam recorded for Ada"]);
  });

  it("narrows to selected Circles and ignores unknown ids", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const personal = await seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      });
      const trip = await seedOwnedFixture(ctx, personal.owner, { name: "Trip" });
      await seedTransaction(ctx, personal, { title: "Personal only", date: "2026-06-01" });
      await seedTransaction(ctx, trip, { title: "Trip only", date: "2026-06-02" });
      return { personal, trip };
    });
    signInAs(seeded.personal.owner);

    const page = await t.query(api.myTransactions.searchMyTransactions, {
      circleIds: [seeded.trip.circleId, "not-a-circle"],
      type: "all",
      status: "all",
      page: 1,
    });

    expect(page.transactions.map((txn) => txn.title)).toEqual(["Trip only"]);
  });

  it("filters by title text across Circles", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const personal = await seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      });
      const trip = await seedOwnedFixture(ctx, personal.owner, { name: "Trip" });
      await seedTransaction(ctx, personal, { title: "Whole Foods", date: "2026-06-01" });
      await seedTransaction(ctx, trip, { title: "Uber", date: "2026-06-02" });
      return personal;
    });
    signInAs(seeded.owner);

    const page = await t.query(api.myTransactions.searchMyTransactions, {
      query: "whole",
      type: "all",
      status: "all",
      page: 1,
    });

    expect(page.transactions.map((txn) => txn.title)).toEqual(["Whole Foods"]);
  });

  it("includes Archived Circle Transactions when membership remains", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const personal = await seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      });
      const archived = await seedOwnedFixture(ctx, personal.owner, {
        name: "Old Trip",
        archived: true,
      });
      await seedTransaction(ctx, archived, { title: "Archived circle spend", date: "2026-01-01" });
      return personal;
    });
    signInAs(seeded.owner);

    const page = await t.query(api.myTransactions.searchMyTransactions, {
      type: "all",
      status: "all",
      page: 1,
    });

    expect(page.transactions.some((txn) => txn.title === "Archived circle spend")).toBe(true);
  });

  it("paginates with numbered pages", async () => {
    const t = convexTest(schema, modules);
    const personal = await t.run((ctx) =>
      seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    signInAs(personal.owner);

    await t.run(async (ctx) => {
      for (let index = 1; index <= 3; index += 1) {
        await seedTransaction(ctx, personal, {
          title: `Row ${index}`,
          date: `2026-06-0${index}`,
          createdAt: index,
        });
      }
    });

    const page1 = await t.query(api.myTransactions.searchMyTransactions, {
      type: "all",
      status: "all",
      page: 1,
      pageSize: 2,
    });
    const page2 = await t.query(api.myTransactions.searchMyTransactions, {
      type: "all",
      status: "all",
      page: 2,
      pageSize: 2,
    });

    expect(page1.transactions.map((txn) => txn.title)).toEqual(["Row 3", "Row 2"]);
    expect(page2.transactions.map((txn) => txn.title)).toEqual(["Row 1"]);
    expect(page1.totalCount).toBe(3);
  });
});

describe("listMyTransactionCircles", () => {
  it("lists visible Circles for the filter", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const personal = await seedPersonalFixture(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      });
      await seedOwnedFixture(ctx, personal.owner, { name: "Trip" });
      return personal;
    });
    signInAs(seeded.owner);

    const circles = await t.query(api.myTransactions.listMyTransactionCircles, {});
    expect(circles.map((circle) => circle.name).sort()).toEqual(["Ada's Circle", "Trip"].sort());
  });
});
