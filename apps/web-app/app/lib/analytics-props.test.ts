import { currentMonth } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";

import {
  exportAnalyticsProps,
  ledgerFilterAnalyticsProps,
  ledgerMonthOffset,
  searchFilterAnalyticsProps,
} from "./analytics-props.js";
import { defaultLedgerFilters, defaultSearchFilters } from "./transaction-filter-url.js";

describe("ledgerMonthOffset", () => {
  it("returns zero for the current month", () => {
    const now = new Date("2026-05-15T12:00:00");
    expect(ledgerMonthOffset(currentMonth(now), now)).toBe(0);
  });

  it("returns a negative delta for past months", () => {
    const now = new Date("2026-05-15T12:00:00");
    expect(ledgerMonthOffset("2026-03", now)).toBe(-2);
  });
});

describe("coarse filter analytics props", () => {
  it("derives booleans and counts without raw filter values", () => {
    const ledger = ledgerFilterAnalyticsProps({
      ...defaultLedgerFilters("2026-04"),
      q: "coffee",
      type: "expense",
      status: "active",
      categories: ["c1", "c2"],
      recordedBy: ["m1"],
      paidBy: [],
    });

    expect(ledger).toEqual({
      type: "expense",
      status: "active",
      hasQuery: true,
      categoryCount: 2,
      recordedByCount: 1,
      paidByCount: 0,
      monthOffset: expect.any(Number),
    });
    expect(ledger).not.toHaveProperty("q");
    expect(ledger).not.toHaveProperty("categories");
  });

  it("derives search range booleans without dates or amounts", () => {
    const search = searchFilterAnalyticsProps({
      ...defaultSearchFilters(),
      q: "rent",
      from: "2026-01-01",
      min: "10",
      categories: ["c1"],
    });

    expect(search).toEqual({
      type: "all",
      status: "all",
      hasQuery: true,
      hasDateRange: true,
      hasAmountRange: true,
      categoryCount: 1,
      recordedByCount: 0,
      paidByCount: 0,
    });
    expect(search).not.toHaveProperty("from");
    expect(search).not.toHaveProperty("min");
  });

  it("maps export outcomes without filenames or row counts", () => {
    const exported = exportAnalyticsProps(defaultSearchFilters(), "downloaded");
    expect(exported.result).toBe("downloaded");
    expect(exported).not.toHaveProperty("filename");
    expect(exported).not.toHaveProperty("rows");
  });
});
