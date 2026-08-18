import { describe, expect, it } from "vitest";
import {
  addMonths,
  COMPARISON_RANGE_OPTIONS,
  type ComparisonRangeMonths,
  comparisonWindowMonths,
  currentMonth,
  DEFAULT_COMPARISON_RANGE_MONTHS,
  DEFAULT_HOME_RANGE_MONTHS,
  defaultDateInMonth,
  HOME_RANGE_OPTIONS,
  isComparisonRangeMonths,
  isHomeRangeMonths,
  isValidPlainDate,
  isValidPlainMonth,
  monthOf,
  monthRange,
  plainMonthParts,
  toPlainDate,
} from "./date.js";

describe("isValidPlainDate", () => {
  it("accepts a real date", () => {
    expect(isValidPlainDate("2026-02-28")).toBe(true);
  });

  it("rejects impossible days and bad shapes", () => {
    expect(isValidPlainDate("2026-02-30")).toBe(false);
    expect(isValidPlainDate("2026-13-01")).toBe(false);
    expect(isValidPlainDate("2026-1-1")).toBe(false);
  });

  it("rejects null/undefined (a missing URL/query value)", () => {
    expect(isValidPlainDate(null)).toBe(false);
    expect(isValidPlainDate(undefined)).toBe(false);
  });
});

describe("isValidPlainMonth", () => {
  it("accepts a real YYYY-MM month", () => {
    expect(isValidPlainMonth("2026-05")).toBe(true);
    expect(isValidPlainMonth("2026-12")).toBe(true);
  });

  it("rejects out-of-range months and bad shapes", () => {
    expect(isValidPlainMonth("2026-13")).toBe(false);
    expect(isValidPlainMonth("2026-00")).toBe(false);
    expect(isValidPlainMonth("2026-5")).toBe(false);
    expect(isValidPlainMonth("2026-05-01")).toBe(false);
    expect(isValidPlainMonth("")).toBe(false);
  });

  it("rejects null/undefined so an absent `?month=` is treated as invalid", () => {
    expect(isValidPlainMonth(null)).toBe(false);
    expect(isValidPlainMonth(undefined)).toBe(false);
  });
});

describe("plainMonthParts", () => {
  it("extracts the numeric year and 1-based month", () => {
    expect(plainMonthParts("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(plainMonthParts("0099-12")).toEqual({ year: 99, month: 12 });
  });

  it("degrades a malformed month to NaN parts instead of lying about numbers", () => {
    // PlainMonth is structurally a string, so a bad value CAN reach this parser;
    // NaN is honest (downstream Date/arithmetic surfaces it as invalid) where a
    // tuple cast would silently fabricate `undefined as number`.
    expect(plainMonthParts("banana").year).toBeNaN();
    expect(plainMonthParts("2026").month).toBeNaN();
    expect(plainMonthParts("").year).toBeNaN();
  });
});

describe("month helpers", () => {
  it("derives the month bucket", () => {
    expect(monthOf("2026-05-29")).toBe("2026-05");
  });

  it("adds and subtracts months across year boundaries", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 3)).toBe("2027-02");
  });

  it("builds an inclusive ascending month range", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("toPlainDate", () => {
  it("formats a Date using local parts", () => {
    expect(toPlainDate(new Date(2026, 4, 9))).toBe("2026-05-09");
  });
});

describe("Comparison Range (RPT-4)", () => {
  it("offers exactly 1, 3, 6, and 12 months, defaulting to 6 (glossary)", () => {
    expect(COMPARISON_RANGE_OPTIONS).toEqual([1, 3, 6, 12]);
    expect(DEFAULT_COMPARISON_RANGE_MONTHS).toBe(6);
    expect(COMPARISON_RANGE_OPTIONS).toContain(DEFAULT_COMPARISON_RANGE_MONTHS);
  });

  it("narrows an arbitrary number to a supported range", () => {
    expect(isComparisonRangeMonths(6)).toBe(true);
    expect(isComparisonRangeMonths(12)).toBe(true);
    expect(isComparisonRangeMonths(2)).toBe(false);
    expect(isComparisonRangeMonths(0)).toBe(false);
    expect(isComparisonRangeMonths(-6)).toBe(false);
  });

  it("builds the chronological window of N months ENDING at the end month", () => {
    expect(comparisonWindowMonths("2026-06", 1)).toEqual(["2026-06"]);
    expect(comparisonWindowMonths("2026-06", 3)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(comparisonWindowMonths("2026-06", 6)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
  });

  it("spans year boundaries correctly", () => {
    expect(comparisonWindowMonths("2026-02", 6)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    const yearWindow: ComparisonRangeMonths = 12;
    expect(comparisonWindowMonths("2026-01", yearWindow)).toEqual([
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });
});

describe("Home Summary range (GH-273)", () => {
  it("reuses the Comparison Range options with a 1-month default", () => {
    expect(HOME_RANGE_OPTIONS).toEqual(COMPARISON_RANGE_OPTIONS);
    expect(DEFAULT_HOME_RANGE_MONTHS).toBe(1);
    expect(isHomeRangeMonths(1)).toBe(true);
    expect(isHomeRangeMonths(6)).toBe(true);
    expect(isHomeRangeMonths(2)).toBe(false);
  });
});

describe("defaultDateInMonth", () => {
  const today = new Date(2026, 4, 9); // 2026-05-09

  it("uses today when today is in the selected month", () => {
    expect(defaultDateInMonth(currentMonth(today), today)).toBe("2026-05-09");
  });

  it("anchors to the first of a different selected month", () => {
    expect(defaultDateInMonth("2026-03", today)).toBe("2026-03-01");
    expect(defaultDateInMonth("2026-12", today)).toBe("2026-12-01");
  });
});
