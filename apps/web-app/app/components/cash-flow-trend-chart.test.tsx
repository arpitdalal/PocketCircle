import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CashFlowTrendChart } from "./cash-flow-trend-chart.js";
import { CASH_FLOW_TREND_TEST_SERIES } from "./cash-flow-trend-test-series.js";

const series = CASH_FLOW_TREND_TEST_SERIES;

describe("CashFlowTrendChart", () => {
  it("marks the visual chart container as aria-hidden", () => {
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });

  it("keeps chart animation off when chartAnimationActive is false", () => {
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive={false} />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });

  it("enables chart animation when chartAnimationActive is true", () => {
    const { container } = render(
      <CashFlowTrendChart currency="USD" series={series} chartAnimationActive />,
    );
    expect(container.querySelector("[data-chart-animation-active='true']")).toBeInTheDocument();
  });
});
