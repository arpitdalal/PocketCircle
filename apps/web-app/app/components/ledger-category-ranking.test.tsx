import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerCategoryRanking } from "./ledger-category-ranking.js";
import { CATEGORY_RANKING_TEST_ROWS } from "./ledger-category-ranking-test-rows.js";

const ranking = CATEGORY_RANKING_TEST_ROWS;

function renderRanking(overrides: Partial<Parameters<typeof LedgerCategoryRanking>[0]> = {}) {
  return render(
    <LedgerCategoryRanking
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
    expect(table).toHaveAccessibleName("Tagged totals by category");
    // Wrapper (not the table) carries sr-only — WebKit expands page scrollWidth when
    // sr-only is on <table> itself (#398 horizontal overflow / clipped bottom nav).
    expect(table.parentElement).toHaveClass("sr-only");
    for (const header of ["Category", "Type", "Tagged total", "Transactions"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("rowheader", { name: "Salary" })).toBeInTheDocument();
    expect(
      screen.getByRole("rowheader", { name: "Old Subscriptions (Archived)" }),
    ).toBeInTheDocument();
    // $5,000.00 income above the baseline, $73.50 and $21.00 expense below it.
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("$73.50")).toBeInTheDocument();
    expect(screen.getByText("$21.00")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getAllByText("Expense")).toHaveLength(2);
  });

  it("states non-additivity, the lifecycle scope in view, and what does not narrow it", () => {
    renderRanking({ scope: "archived" });

    expect(screen.getByText(/counts its full amount toward each/i)).toBeInTheDocument();
    expect(
      screen.getByText(/showing archived transactions, not narrowed by search text or member/i),
    ).toBeInTheDocument();
  });

  it("is read-only: nothing inside the section is focusable or a control", () => {
    const { container } = renderRanking();

    // `hidden: true` — the chart is aria-hidden, and a control smuggled inside it would
    // otherwise be invisible to this assertion.
    expect(screen.queryByRole("button", { name: /groceries/i, hidden: true })).toBeNull();
    expect(screen.queryByRole("link", { name: /groceries/i, hidden: true })).toBeNull();
    const section = screen.getByRole("region", { name: "Tagged totals by category" });
    expect(section.querySelector("[tabindex]")).toBeNull();
    expect(container.querySelector("button, a")).toBeNull();
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

    expect(screen.getByText("No tagged totals for this period.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps its heading while the first scope loads, and marks the section busy", () => {
    renderRanking({ ranking: undefined });

    const section = screen.getByRole("region", { name: "Tagged totals by category" });
    expect(section).toHaveAttribute("aria-busy", "true");
    const loading = screen.getByTestId("category-ranking-skeleton");
    expect(loading).toHaveAttribute("role", "status");
    expect(loading).toHaveTextContent("Loading tagged totals…");
    expect(loading.querySelector(".h-72")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("drops the scope clause while a retained ranking bridges a scope reload", () => {
    const { rerender } = renderRanking();
    const section = screen.getByRole("region", { name: "Tagged totals by category" });
    expect(section).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText(/showing active and archived transactions/i)).toBeInTheDocument();

    // The rows on screen still belong to the PREVIOUS scope, so the caption must not
    // relabel them with the scope now being loaded.
    rerender(
      <LedgerCategoryRanking
        ranking={ranking}
        currency="USD"
        scope="archived"
        scopeKey="ledger-ranking:c1:2026-07:all:archived"
        pending
      />,
    );
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/showing .* transactions/i)).not.toBeInTheDocument();
  });
});
