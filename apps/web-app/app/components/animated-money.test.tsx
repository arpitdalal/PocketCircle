import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AnimatedMoney } from "./animated-money.js";

vi.mock("@number-flow/react", () => ({
  default: ({
    value,
    format,
    locales,
  }: {
    value: number;
    format: Intl.NumberFormatOptions;
    locales: string;
  }) => (
    <span data-testid="number-flow" aria-hidden>
      {new Intl.NumberFormat(locales, format).format(value)}
    </span>
  ),
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

describe("AnimatedMoney", () => {
  it("formats minor units as currency in the viewer locale", () => {
    render(<AnimatedMoney minorUnits={500_000} currency="USD" />);
    expect(screen.getByText("$5,000.00", { selector: "[data-money]" })).toBeInTheDocument();
    expect(screen.getByText("$5,000.00", { selector: ".sr-only" })).toBeInTheDocument();
  });

  it("formats negative net amounts", () => {
    render(<AnimatedMoney minorUnits={-4_200} currency="USD" />);
    expect(screen.getByText("-$42.00", { selector: "[data-money]" })).toBeInTheDocument();
  });
});
