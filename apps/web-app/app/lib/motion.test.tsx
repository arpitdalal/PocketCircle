import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installReducedMotionPreference } from "~/test/match-media.js";
import { usePrefersReducedMotion } from "./motion.js";

function Probe() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return <span data-testid="prefers-reduced-motion">{String(prefersReducedMotion)}</span>;
}

describe("usePrefersReducedMotion", () => {
  it("returns false when the user has not requested reduced motion", () => {
    installReducedMotionPreference(false);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("false");
  });

  it("returns true when matchMedia reports reduced motion", () => {
    installReducedMotionPreference(true);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("true");
  });
});
