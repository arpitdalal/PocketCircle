import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { CashFlowTrend } from "./cash-flow-trend.js";
import { CashFlowTrendChart } from "./cash-flow-trend-chart.js";

describe("CashFlowTrend", () => {
  const series = [
    { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
    { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
  ];

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
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
  });
});

describe("CashFlowTrendChart", () => {
  const series = [
    { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
    { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
  ];

  const media = createMatchMediaFakeController();

  it("marks the visual chart container as aria-hidden", () => {
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });

  it("keeps chart animation off when inactive", () => {
    media.reducedMotion(false);
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });

  it("enables chart animation when active", () => {
    media.reducedMotion(false);
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive />,
    );
    expect(container.querySelector("[data-chart-animation-active='true']")).toBeInTheDocument();
  });

  it("can be told to keep animation off for reduced motion callers", () => {
    media.reducedMotion(true);
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });
});
