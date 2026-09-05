import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CashFlowTrend } from "./cash-flow-trend.js";

vi.mock("./cash-flow-trend-chart.js", async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return await vi.importActual("./cash-flow-trend-chart.js");
});

const series = [
  { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
  { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
];

describe("CashFlowTrend", () => {
  it("renders the sr-only data table with correct structure without waiting on Recharts", () => {
    render(<CashFlowTrend currency="USD" series={series} scopeKey="range:6" />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Expense" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Net" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
  });

  it("uses the provided caption for the table", () => {
    render(
      <CashFlowTrend currency="CAD" series={series} scopeKey="range:6" caption="Custom caption" />,
    );
    expect(screen.getByText("Custom caption")).toBeInTheDocument();
  });

  it("uses a default caption when none is provided", () => {
    render(<CashFlowTrend currency="USD" series={series} scopeKey="range:6" />);
    expect(screen.getByText("Month-over-month Income, Expense, and Net")).toBeInTheDocument();
  });

  it("shows an aria-hidden chart shell while the Recharts chunk loads", async () => {
    const { container } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    expect(container.querySelector('[data-chart-shell="fallback"]')).toBeInTheDocument();
    expect(container.querySelector(".recharts-responsive-container")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    expect(container.querySelector('[data-chart-shell="fallback"]')).not.toBeInTheDocument();
  });
});
