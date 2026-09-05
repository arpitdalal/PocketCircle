import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { CashFlowTrendChart } from "./cash-flow-trend-chart.js";

const series = [
  { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
  { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
];

describe("CashFlowTrendChart", () => {
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
