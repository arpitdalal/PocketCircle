import { render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { CashFlowTrend } from "./cash-flow-trend.js";
import { CASH_FLOW_TREND_TEST_SERIES } from "./cash-flow-trend-test-series.js";

/** Vendor-boundary gate: Suspense fallback without mocking our chart module (ADR 0006). */
const rechartsGate = vi.hoisted(() => {
  let release!: () => void;
  let ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let open = false;
  return {
    wait() {
      if (open) return;
      throw ready;
    },
    release() {
      open = true;
      release();
    },
    reset() {
      open = false;
      ready = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
});

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  type ContainerProps = ComponentProps<typeof actual.ResponsiveContainer>;
  return {
    ...actual,
    ResponsiveContainer: (props: ContainerProps) => {
      rechartsGate.wait();
      return createElement(actual.ResponsiveContainer, props);
    },
  };
});

const series = CASH_FLOW_TREND_TEST_SERIES;
const media = createMatchMediaFakeController();

describe("CashFlowTrend", () => {
  beforeEach(() => {
    rechartsGate.reset();
    rechartsGate.release();
  });

  afterEach(() => {
    rechartsGate.release();
  });

  it("renders the sr-only data table with correct structure without waiting on Recharts", () => {
    rechartsGate.reset();
    render(<CashFlowTrend currency="USD" series={series} scopeKey="range:6" />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Expense" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Net" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(document.querySelector('[data-chart-shell="fallback"]')).toBeInTheDocument();
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
    rechartsGate.reset();
    const { container } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    expect(container.querySelector('[data-chart-shell="fallback"]')).toBeInTheDocument();
    expect(container.querySelector(".recharts-responsive-container")).not.toBeInTheDocument();
    rechartsGate.release();
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    expect(container.querySelector('[data-chart-shell="fallback"]')).not.toBeInTheDocument();
  });

  it("keeps chart animation off on the initial series paint", async () => {
    media.reducedMotion(false);
    const { container } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });

  it("does not enable animation for a live series refresh with the same scopeKey", async () => {
    media.reducedMotion(false);
    const { container, rerender } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    rerender(
      <CashFlowTrend
        currency="USD"
        scopeKey="range:6"
        series={[
          ...series,
          { month: "2026-09", incomeMinor: 130000, expenseMinor: 90000, netMinor: 40000 },
        ]}
      />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });

  it("enables chart animation after a reporting-scope key change then new series", async () => {
    media.reducedMotion(false);
    const { container, rerender } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    rerender(<CashFlowTrend currency="USD" series={series} scopeKey="range:3" pending />);
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
    rerender(
      <CashFlowTrend
        currency="USD"
        scopeKey="range:3"
        series={series.slice(0, 1)}
        pending={false}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector("[data-chart-animation-active='true']")).toBeInTheDocument();
    });
  });

  it("disables chart animation when the user prefers reduced motion", async () => {
    media.reducedMotion(true);
    const { container, rerender } = render(
      <CashFlowTrend currency="USD" series={series} scopeKey="range:6" />,
    );
    await waitFor(() => {
      expect(container.querySelector(".recharts-responsive-container")).toBeInTheDocument();
    });
    rerender(<CashFlowTrend currency="USD" series={series} scopeKey="range:3" pending />);
    rerender(
      <CashFlowTrend
        currency="USD"
        scopeKey="range:3"
        series={series.slice(0, 1)}
        pending={false}
      />,
    );
    expect(container.querySelector("[data-chart-animation-active='false']")).toBeInTheDocument();
  });
});
