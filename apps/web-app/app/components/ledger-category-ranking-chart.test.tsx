import { colorHex } from "@pocketcircle/domain";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ARCHIVED_HATCH_ID,
  LedgerCategoryRankingChart,
  renderRankingBar,
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
    expect(bars[2]?.fill).toBe(`url(#${ARCHIVED_HATCH_ID})`);
  });
});

describe("renderRankingBar", () => {
  // The projection above only proves the DATA carries the right fill; this proves the
  // shape Recharts actually renders applies it, which is what the hatch needs.
  it("draws the bar with the projected fill", () => {
    const { container } = render(
      <svg aria-hidden="true">
        {renderRankingBar({
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          payload: toCategoryRankingBars(ranking).at(2),
        })}
      </svg>,
    );
    const rect = container.querySelector("rect, path");
    expect(rect?.getAttribute("fill")).toBe(`url(#${ARCHIVED_HATCH_ID})`);
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
