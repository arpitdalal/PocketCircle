import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  canonicalLedgerParams,
  canonicalMyTransactionsParams,
  canonicalSearchParams,
  defaultLedgerFilters,
  defaultMyTransactionsFilters,
  defaultSearchFilters,
  dropUnknownIds,
  readLedgerFilters,
  readMyTransactionsFilters,
  readSearchFilters,
  toMinorUnits,
  writeLedgerFilters,
} from "./transaction-filter-url.js";

const FALLBACK_MONTH = "2026-03" as const;

describe("readLedgerFilters", () => {
  it("reads defaults from empty params with month equal to fallback", () => {
    expect(readLedgerFilters(new URLSearchParams(), FALLBACK_MONTH)).toEqual({
      month: FALLBACK_MONTH,
      q: "",
      type: "all",
      status: "all",
      categories: [],
      recordedBy: [],
      paidBy: [],
    });
  });

  it("reads explicit month, type, status, q, and id lists", () => {
    const params = new URLSearchParams(
      "month=2026-01&type=income&status=archived&q=coffee&categories=c1,c2&recordedBy=m1&paidBy=m2",
    );
    expect(readLedgerFilters(params, FALLBACK_MONTH)).toEqual({
      month: "2026-01",
      q: "coffee",
      type: "income",
      status: "archived",
      categories: ["c1", "c2"],
      recordedBy: ["m1"],
      paidBy: ["m2"],
    });
  });

  it("uses fallback month when month is invalid or missing", () => {
    expect(readLedgerFilters(new URLSearchParams("month=2026-13"), FALLBACK_MONTH).month).toBe(
      FALLBACK_MONTH,
    );
    expect(readLedgerFilters(new URLSearchParams("month=garbage"), FALLBACK_MONTH).month).toBe(
      FALLBACK_MONTH,
    );
  });

  it("clamps unknown type and status to all", () => {
    expect(
      readLedgerFilters(new URLSearchParams("type=bogus&status=nope"), FALLBACK_MONTH),
    ).toEqual(expect.objectContaining({ type: "all", status: "all" }));
  });

  it("trims and collapses whitespace in q", () => {
    expect(readLedgerFilters(new URLSearchParams("q=++weekly+++shop++"), FALLBACK_MONTH).q).toBe(
      "weekly shop",
    );
  });

  it("dedupes, sorts, trims, and drops empty category segments", () => {
    expect(
      readLedgerFilters(new URLSearchParams("categories=b,a,a, ,c"), FALLBACK_MONTH).categories,
    ).toEqual(["a", "b", "c"]);
  });
});

describe("readSearchFilters", () => {
  it("keeps valid from and to dates", () => {
    expect(readSearchFilters(new URLSearchParams("from=2026-01-15&to=2026-02-28"))).toEqual(
      expect.objectContaining({
        from: "2026-01-15",
        to: "2026-02-28",
      }),
    );
  });

  it("clears from and to when invalid", () => {
    expect(readSearchFilters(new URLSearchParams("from=2026-02-30")).from).toBe("");
    expect(readSearchFilters(new URLSearchParams("to=notadate")).to).toBe("");
  });

  it("keeps valid min and max amount strings and zero", () => {
    expect(readSearchFilters(new URLSearchParams("min=12.50&max=7")).min).toBe("12.50");
    expect(readSearchFilters(new URLSearchParams("min=7")).max).toBe("");
    expect(readSearchFilters(new URLSearchParams("min=0&max=0")).min).toBe("0");
    expect(readSearchFilters(new URLSearchParams("min=0&max=0")).max).toBe("0");
  });

  it("clears min and max when invalid", () => {
    expect(readSearchFilters(new URLSearchParams("min=abc")).min).toBe("");
    expect(readSearchFilters(new URLSearchParams("max=-5")).max).toBe("");
  });
});

describe("writeLedgerFilters and canonicalLedgerParams", () => {
  it("always writes month, type, and status and omits empty q", () => {
    const params = new URLSearchParams();
    writeLedgerFilters(params, defaultLedgerFilters(FALLBACK_MONTH));
    expect(params.toString()).toBe(`month=${FALLBACK_MONTH}&type=all&status=all`);
  });

  it("dedupes and sorts id lists on write", () => {
    const params = new URLSearchParams();
    writeLedgerFilters(params, {
      month: FALLBACK_MONTH,
      q: "",
      type: "all",
      status: "all",
      categories: ["b", "a", "a"],
      recordedBy: [],
      paidBy: [],
    });
    expect(params.get("categories")).toBe("a,b");
  });

  it("preserves non-filter params and drops stale filter keys from preserve", () => {
    const preserve = new URLSearchParams("q=old&other=keep");
    const params = canonicalLedgerParams(defaultLedgerFilters(FALLBACK_MONTH), preserve);
    expect(params.get("other")).toBe("keep");
    expect(params.get("q")).toBeNull();
    expect(params.toString()).toContain(`month=${FALLBACK_MONTH}`);
  });

  it("round-trips ledger filters through canonical params with explicit fallback month", () => {
    const filters = {
      month: "2026-01" as const,
      q: "fuel",
      type: "income" as const,
      status: "active" as const,
      categories: ["z", "a"],
      recordedBy: ["m1"],
      paidBy: ["m2", "m1"],
    };
    expect(readLedgerFilters(canonicalLedgerParams(filters), FALLBACK_MONTH)).toEqual({
      month: "2026-01",
      q: "fuel",
      type: "income",
      status: "active",
      categories: ["a", "z"],
      recordedBy: ["m1"],
      paidBy: ["m1", "m2"],
    });
  });
});

describe("canonicalSearchParams", () => {
  it("writes from, to, min, max only when valid and omits when empty or invalid", () => {
    const empty = canonicalSearchParams(defaultSearchFilters());
    expect(empty.get("from")).toBeNull();
    expect(empty.get("to")).toBeNull();
    expect(empty.get("min")).toBeNull();
    expect(empty.get("max")).toBeNull();
    expect(empty.get("page")).toBeNull();

    const withDates = canonicalSearchParams({
      ...defaultSearchFilters(),
      from: "2026-04-01",
      to: "2026-04-30",
      min: "1.00",
      max: "99.99",
    });
    expect(withDates.get("from")).toBe("2026-04-01");
    expect(withDates.get("to")).toBe("2026-04-30");
    expect(withDates.get("min")).toBe("1.00");
    expect(withDates.get("max")).toBe("99.99");
  });

  it("round-trips search filters through canonical params", () => {
    const filters = {
      ...defaultSearchFilters(),
      q: "dining",
      type: "expense" as const,
      status: "archived" as const,
      categories: ["c1"],
      recordedBy: [],
      paidBy: [],
      from: "2026-05-01",
      to: "2026-05-31",
      min: "10",
      max: "20.00",
      page: 1,
    };
    expect(readSearchFilters(canonicalSearchParams(filters))).toEqual(filters);
  });

  it("clamps page from the URL and omits page=1 from canonical params", () => {
    expect(readSearchFilters(new URLSearchParams("page=0")).page).toBe(1);
    expect(readSearchFilters(new URLSearchParams("page=abc")).page).toBe(1);
    expect(readSearchFilters(new URLSearchParams("page=999")).page).toBe(40);
    expect(canonicalSearchParams(defaultSearchFilters()).get("page")).toBeNull();
    expect(canonicalSearchParams({ ...defaultSearchFilters(), page: 4 }).get("page")).toBe("4");
  });
});

describe("activeFilterCount", () => {
  it("is zero for default ledger filters", () => {
    expect(activeFilterCount(defaultLedgerFilters(FALLBACK_MONTH))).toBe(0);
  });

  it("is zero for default search filters", () => {
    expect(activeFilterCount(defaultSearchFilters())).toBe(0);
  });

  it("counts q, non-default type, non-default status, and non-empty id lists", () => {
    expect(
      activeFilterCount({
        q: "x",
        type: "expense",
        status: "active",
        categories: ["a"],
        recordedBy: ["b"],
        paidBy: ["c"],
      }),
    ).toBe(6);
  });

  it("counts from, to, min, and max for search filters when set", () => {
    expect(
      activeFilterCount({
        ...defaultSearchFilters(),
        from: "2026-01-01",
        to: "2026-01-31",
        min: "1",
        max: "2",
      }),
    ).toBe(4);
  });
});

describe("toMinorUnits", () => {
  it("returns undefined for empty or whitespace-only input", () => {
    expect(toMinorUnits("")).toBeUndefined();
    expect(toMinorUnits("   ")).toBeUndefined();
  });

  it("returns 0 for zero string", () => {
    expect(toMinorUnits("0")).toBe(0);
  });

  it("returns minor units for a valid amount string", () => {
    expect(toMinorUnits("12.50")).toBe(1250);
  });

  it("returns undefined for invalid amount strings", () => {
    expect(toMinorUnits("abc")).toBeUndefined();
    expect(toMinorUnits("-5")).toBeUndefined();
  });
});

describe("dropUnknownIds", () => {
  it("removes unknown category and member ids and leaves other fields unchanged", () => {
    const filters = {
      q: "keep",
      type: "all" as const,
      status: "all" as const,
      categories: ["known-cat", "unknown-cat"],
      recordedBy: ["known-m", "unknown-m"],
      paidBy: ["known-m"],
    };
    expect(
      dropUnknownIds(filters, {
        categoryIds: ["known-cat"],
        memberIds: ["known-m"],
      }),
    ).toEqual({
      q: "keep",
      type: "all",
      status: "all",
      categories: ["known-cat"],
      recordedBy: ["known-m"],
      paidBy: ["known-m"],
    });
  });
});

describe("readMyTransactionsFilters", () => {
  it("reads circle ids and omits Category/Recorded By/Paid By", () => {
    expect(
      readMyTransactionsFilters(
        new URLSearchParams(
          "q=coffee&type=expense&status=active&circles=c1,c2&from=2026-01-01&to=2026-01-31&min=1&max=50&page=2",
        ),
      ),
    ).toEqual({
      q: "coffee",
      type: "expense",
      status: "active",
      circles: ["c1", "c2"],
      from: "2026-01-01",
      to: "2026-01-31",
      min: "1",
      max: "50",
      page: 2,
    });
  });

  it("defaults empty circles and page 1", () => {
    expect(readMyTransactionsFilters(new URLSearchParams())).toEqual(
      defaultMyTransactionsFilters(),
    );
  });
});

describe("canonicalMyTransactionsParams", () => {
  it("round-trips filters without Category params", () => {
    const filters = {
      ...defaultMyTransactionsFilters(),
      q: "rent",
      circles: ["abc"],
      page: 3,
    };
    expect(readMyTransactionsFilters(canonicalMyTransactionsParams(filters))).toEqual(filters);
  });
});
