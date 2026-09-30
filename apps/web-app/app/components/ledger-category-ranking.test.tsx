import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerCategoryRanking } from "./ledger-category-ranking.js";
import { CATEGORY_RANKING_TEST_ROWS } from "./ledger-category-ranking-test-rows.js";

const ranking = CATEGORY_RANKING_TEST_ROWS;

function renderRanking(overrides: Partial<Parameters<typeof LedgerCategoryRanking>[0]> = {}) {
  return render(
    <LedgerCategoryRanking
      month="2026-06"
      ranking={ranking}
      currency="USD"
      scope="active and archived"
      scopeKey="ledger-ranking:c1:2026-06:all:all"
      {...overrides}
    />,
  );
}

describe("LedgerCategoryRanking", () => {
  it("carries every plotted value in the sr-only table, with Archived marked by name", () => {
    renderRanking();

    const table = screen.getByRole("table");
    expect(table).toHaveAccessibleName("Tagged spend by category for 2026-06");
    // Wrapper (not the table) carries sr-only — WebKit expands page scrollWidth when
    // sr-only is on <table> itself (#398 horizontal overflow / clipped bottom nav).
    expect(table.parentElement).toHaveClass("sr-only");
    for (const header of ["Category", "Type", "Tagged total", "Transactions"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("rowheader", { name: "Salary" })).toBeInTheDocument();
    expect(
      screen.getByRole("rowheader", { name: "Old Subscriptions (archived)" }),
    ).toBeInTheDocument();
    // $5,000.00 income above the baseline, $73.50 and $21.00 expense below it.
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("$73.50")).toBeInTheDocument();
    expect(screen.getByText("$21.00")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getAllByText("Expense")).toHaveLength(2);
  });

  it("states both non-additivity and the lifecycle scope in view", () => {
    renderRanking({ scope: "archived" });

    expect(screen.getByText(/counts its full amount toward each category/i)).toBeInTheDocument();
    expect(screen.getByText(/showing archived transactions/i)).toBeInTheDocument();
  });

  it("is read-only: the chart exposes no control to filter by Category", () => {
    renderRanking();

    expect(screen.queryByRole("button", { name: /groceries/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /groceries/i })).not.toBeInTheDocument();
  });

  it("swaps the lazy chart shell for the real Recharts visual once its chunk loads", async () => {
    const { container } = renderRanking();

    await waitFor(
      () => {
        expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    expect(container.querySelector('[data-chart-shell="fallback"]')).not.toBeInTheDocument();
  });

  it("reads as an empty period rather than an empty chart when nothing is tagged", () => {
    renderRanking({ ranking: [] });

    expect(screen.getByText("No tagged spend for this period.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("marks the section busy while a retained ranking bridges a scope reload", () => {
    const { rerender } = renderRanking();
    const section = screen.getByRole("region", { name: "Tagged spend by category" });
    expect(section).toHaveAttribute("aria-busy", "false");

    rerender(
      <LedgerCategoryRanking
        month="2026-07"
        ranking={ranking}
        currency="USD"
        scope="active and archived"
        scopeKey="ledger-ranking:c1:2026-07:all:all"
        pending
      />,
    );
    expect(section).toHaveAttribute("aria-busy", "true");
  });
});
