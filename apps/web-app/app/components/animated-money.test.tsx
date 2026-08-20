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
    <span data-testid="number-flow">{new Intl.NumberFormat(locales, format).format(value)}</span>
  ),
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

describe("AnimatedMoney", () => {
  it("formats minor units as currency in the viewer locale", () => {
    render(<AnimatedMoney minorUnits={500_000} currency="USD" />);
    expect(screen.getByTestId("number-flow")).toHaveTextContent("$5,000.00");
  });

  it("formats negative net amounts", () => {
    render(<AnimatedMoney minorUnits={-4_200} currency="USD" />);
    expect(screen.getByTestId("number-flow")).toHaveTextContent("-$42.00");
  });
});
