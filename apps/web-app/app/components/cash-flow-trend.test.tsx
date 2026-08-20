import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { CashFlowTrend } from "./cash-flow-trend.js";

describe("CashFlowTrend", () => {
  const series = [
    { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
    { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
  ];

  const media = createMatchMediaFakeController();

  it("renders the sr-only data table with correct structure", () => {
    render(<CashFlowTrend currency="USD" series={series} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Expense" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Net" })).toBeInTheDocument();
    // Two data rows
    const rows = screen.getAllByRole("row");
    // 1 header row + 2 body rows = 3
    expect(rows).toHaveLength(3);
  });

  it("uses the provided caption for the table", () => {
    render(<CashFlowTrend currency="CAD" series={series} caption="Custom caption" />);
    expect(screen.getByText("Custom caption")).toBeInTheDocument();
  });

  it("uses a default caption when none is provided", () => {
    render(<CashFlowTrend currency="USD" series={series} />);
    expect(screen.getByText("Month-over-month Income, Expense, and Net")).toBeInTheDocument();
  });

  it("marks the visual chart container as aria-hidden", () => {
    const { container } = render(<CashFlowTrend currency="USD" series={series} />);
    const chartDiv = container.querySelector("[aria-hidden='true']");
    expect(chartDiv).toBeInTheDocument();
  });

  it("enables chart animation when reduced motion is off", () => {
    media.reducedMotion(false);
    const { container } = render(<CashFlowTrend currency="USD" series={series} />);
    expect(container.querySelector("[data-chart-animation-active='true']")).toBeInTheDocument();
  });

  it("disables chart animation when the user prefers reduced motion", () => {
    media.reducedMotion(true);
    const { container } = render(<CashFlowTrend currency="USD" series={series} />);
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });
});
