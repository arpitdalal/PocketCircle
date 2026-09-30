import { colorHex } from "@pocketcircle/domain";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LedgerCategoryRankingChart,
  toCategoryRankingBars,
} from "./ledger-category-ranking-chart.js";
import { CATEGORY_RANKING_TEST_ROWS } from "./ledger-category-ranking-test-rows.js";

const ranking = CATEGORY_RANKING_TEST_ROWS;

describe("toCategoryRankingBars", () => {
  it("diverges from a zero baseline: income above, expense below", () => {
    const bars = toCategoryRankingBars(ranking);
    expect(bars.map((bar) => [bar.name, bar.signedMinor])).toEqual([
      ["Salary", 500_000],
      ["Groceries", -7_350],
      ["Old Subscriptions", -2_100],
    ]);
  });

  it("fills an Archived Category with the hatch and a current one with its Category colour", () => {
    const bars = toCategoryRankingBars(ranking);
    expect(bars[0]?.fill).toBe(colorHex("teal"));
    expect(bars[1]?.fill).toBe(colorHex("green"));
    expect(bars[2]?.archived).toBe(true);
    expect(bars[2]?.fill).toMatch(/^url\(#/);
  });
});

describe("LedgerCategoryRankingChart", () => {
  it("marks the visual chart container as aria-hidden", () => {
    const { container } = render(
      <LedgerCategoryRankingChart currency="USD" ranking={ranking} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });

  it("keeps chart animation off when chartAnimationActive is false", () => {
    const { container } = render(
      <LedgerCategoryRankingChart currency="USD" ranking={ranking} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });

  it("enables chart animation when chartAnimationActive is true", () => {
    const { container } = render(
      <LedgerCategoryRankingChart currency="USD" ranking={ranking} chartAnimationActive />,
    );
    expect(container.querySelector("[data-chart-animation-active='true']")).toBeInTheDocument();
  });
});
