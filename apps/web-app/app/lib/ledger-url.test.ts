import { describe, expect, it } from "vitest";
import {
  categoryDetailHref,
  ledgerDrilldownHref,
  transactionDetailHref,
  withQuery,
} from "./ledger-url.js";

describe("categoryDetailHref", () => {
  it("builds the bare category detail path (origin is carried by returnTo, not here)", () => {
    expect(categoryDetailHref({ ref: "trip-c1" }, { ref: "groceries-cat1" })).toBe(
      "/circles/trip-c1/categories/groceries-cat1",
    );
  });
});

describe("transactionDetailHref", () => {
  it("builds the bare detail path (origin is carried by returnTo, not here)", () => {
    expect(transactionDetailHref({ ref: "c1" }, { ref: "rent-t1" })).toBe(
      "/circles/c1/transactions/rent-t1",
    );
  });
});

describe("withQuery", () => {
  it("appends a non-empty query with a ?", () => {
    expect(withQuery("/a/b", "month=2026-05")).toBe("/a/b?month=2026-05");
  });

  it("returns the bare path when the query is empty", () => {
    expect(withQuery("/a/b", "")).toBe("/a/b");
  });
});

describe("ledgerDrilldownHref", () => {
  it("builds a month-only ledger URL with canonical defaults", () => {
    expect(ledgerDrilldownHref({ ref: "trip-c1" }, { month: "2026-04" })).toBe(
      "/circles/trip-c1/transactions?month=2026-04&type=all&status=all",
    );
  });

  it("adds category and type filters when provided", () => {
    expect(
      ledgerDrilldownHref(
        { ref: "trip-c1" },
        {
          month: "2026-06",
          categoryId: "cat-groceries",
          type: "expense",
        },
      ),
    ).toBe(
      "/circles/trip-c1/transactions?month=2026-06&type=expense&status=all&categories=cat-groceries",
    );
  });
});
