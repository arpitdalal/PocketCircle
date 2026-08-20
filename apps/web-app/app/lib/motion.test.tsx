import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { usePrefersReducedMotion } from "./motion.js";

function Probe() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return <span data-testid="prefers-reduced-motion">{String(prefersReducedMotion)}</span>;
}

describe("usePrefersReducedMotion", () => {
  const media = createMatchMediaFakeController();

  it("returns false when the user has not requested reduced motion", () => {
    media.reducedMotion(false);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("false");
  });

  it("returns true when matchMedia reports reduced motion", () => {
    media.reducedMotion(true);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("true");
  });

  it("updates when the reduced-motion preference changes", async () => {
    const handle = media.reducedMotion(false);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("false");

    handle.setQueryMatches("(prefers-reduced-motion: reduce)", true);

    await waitFor(() => {
      expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("true");
    });
  });
});
