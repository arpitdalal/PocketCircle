import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installReducedMotionPreference, type MatchMediaFakeHandle } from "~/test/match-media.js";
import { usePrefersReducedMotion } from "./motion.js";

function Probe() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return <span data-testid="prefers-reduced-motion">{String(prefersReducedMotion)}</span>;
}

describe("usePrefersReducedMotion", () => {
  let media: MatchMediaFakeHandle | undefined;

  afterEach(() => {
    media?.restore();
    media = undefined;
  });

  it("returns false when the user has not requested reduced motion", () => {
    media = installReducedMotionPreference(false);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("false");
  });

  it("returns true when matchMedia reports reduced motion", () => {
    media = installReducedMotionPreference(true);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("true");
  });

  it("updates when the reduced-motion preference changes", async () => {
    media = installReducedMotionPreference(false);
    render(<Probe />);
    expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("false");

    media.setQueryMatches("(prefers-reduced-motion: reduce)", true);

    await waitFor(() => {
      expect(screen.getByTestId("prefers-reduced-motion")).toHaveTextContent("true");
    });
  });
});
