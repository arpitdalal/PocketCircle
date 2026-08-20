import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMatchMediaFakeController } from "~/test/match-media.js";
import { usePrefersReducedMotion, useScopeChangeMotion } from "./motion.js";

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

describe("useScopeChangeMotion", () => {
  it("stays false on mount and on live value updates with the same scope", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, valueKey }) => useScopeChangeMotion(scopeKey, valueKey),
      { initialProps: { scopeKey: "USD:1", valueKey: "100:50:50" } },
    );
    expect(result.current).toBe(false);

    rerender({ scopeKey: "USD:1", valueKey: "200:50:150" });
    expect(result.current).toBe(false);
  });

  it("animates when values arrive after a scope change", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, valueKey }) => useScopeChangeMotion(scopeKey, valueKey),
      { initialProps: { scopeKey: "USD:1", valueKey: "100:50:50" } },
    );

    rerender({ scopeKey: "EUR:1", valueKey: "100:50:50" });
    expect(result.current).toBe(false);

    rerender({ scopeKey: "EUR:1", valueKey: "80:40:40" });
    expect(result.current).toBe(true);

    rerender({ scopeKey: "EUR:1", valueKey: "90:40:50" });
    expect(result.current).toBe(false);
  });

  it("animates every value change in always mode after mount", () => {
    const { result, rerender } = renderHook(
      ({ valueKey }) => useScopeChangeMotion("dashboard", valueKey, "always"),
      { initialProps: { valueKey: "100:50:50" } },
    );
    expect(result.current).toBe(false);

    rerender({ valueKey: "200:50:150" });
    expect(result.current).toBe(true);
  });
});
