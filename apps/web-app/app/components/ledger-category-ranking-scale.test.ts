import { describe, expect, it } from "vitest";
import { categoryRankingScale } from "./ledger-category-ranking-scale.js";

describe("categoryRankingScale", () => {
  it.each([[], [0], [-500, 100], [100, 200, 300], [-100, -200]])(
    "keeps ordinary totals proportional: %j",
    (...values) => {
      const scale = categoryRankingScale(values);
      expect(scale.breaks).toEqual([]);
      for (const value of values) expect(scale.project(value)).toBe(value);
      expect(scale.project(0)).toBe(0);
    },
  );

  it.each([1, -1])("reveals small totals next to a large %s outlier", (sign) => {
    const values = [-10_100, 21_300, sign * 3_600_000];
    const scale = categoryRankingScale(values);
    expect(scale.breaks).toContainEqual({ lower: sign * 30_000, upper: sign * 3_500_000 });
    const span = (scale.domain.at(1) ?? 0) - (scale.domain.at(0) ?? 0);
    // Real chart projection at its 200px mobile plot height, not a minimum-height patch.
    expect((Math.abs(scale.project(-10_100)) / span) * 200).toBeGreaterThan(20);
    expect((Math.abs(scale.project(21_300)) / span) * 200).toBeGreaterThan(40);
    expect(scale.project(-21_300)).toBe(-scale.project(21_300));
    expect(values).toEqual([-10_100, 21_300, sign * 3_600_000]);
  });

  it("marks both sides when both have outliers and never cuts through an observation", () => {
    const values = [-4_000_000, -10_100, 21_300, 3_600_000];
    const scale = categoryRankingScale(values);
    expect(scale.breaks).toHaveLength(2);
    for (const cut of scale.breaks) {
      const low = Math.min(cut.lower, cut.upper);
      const high = Math.max(cut.lower, cut.upper);
      expect(values.some((value) => value > low && value < high)).toBe(false);
    }
    const sorted = [...values, 0].sort((a, b) => a - b);
    expect(sorted.map(scale.project)).toEqual(sorted.map(scale.project).sort((a, b) => a - b));
  });
});
