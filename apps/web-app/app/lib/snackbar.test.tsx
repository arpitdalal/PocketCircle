import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnackbarProvider, useSnackbar } from "./snackbar.js";

afterEach(() => {
  vi.useRealTimers();
});

// A tiny harness that surfaces the snackbar API as buttons, so the closed
// vocabulary is exercised through the real provider/context rather than a double.
function Harness() {
  const { show, showUnavailable } = useSnackbar();
  return (
    <>
      <button type="button" onClick={() => show("Custom copy")}>
        show
      </button>
      <button type="button" onClick={() => showUnavailable()}>
        default
      </button>
      <button type="button" onClick={() => showUnavailable("circle")}>
        circle
      </button>
    </>
  );
}

function renderHarness() {
  return render(
    <SnackbarProvider>
      <Harness />
    </SnackbarProvider>,
  );
}

describe("snackbar unavailable vocabulary (ADR 0016)", () => {
  it("defaults to the generic bad-link copy", () => {
    renderHarness();
    act(() => screen.getByText("default").click());
    // The exact anti-enumeration string is locked here — it must stay generic and
    // identical for missing vs inaccessible targets so existence never leaks.
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
  });

  it("maps the 'circle' token to the Circle-flavored copy", () => {
    renderHarness();
    act(() => screen.getByText("circle").click());
    expect(screen.getByText("This circle isn't available.")).toBeInTheDocument();
  });

  it("passes arbitrary copy through `show` (the unconstrained, non-enumeration path)", () => {
    renderHarness();
    act(() => screen.getByText("show").click());
    expect(screen.getByText("Custom copy")).toBeInTheDocument();
  });
});

describe("snackbar lifetime (issue #287)", () => {
  it("restarts the four-second lifetime and re-announces identical successive messages", () => {
    vi.useFakeTimers();
    renderHarness();
    act(() => screen.getByText("show").click());
    expect(screen.getByText("Custom copy")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // A second identical show restarts lifetime — the older timeout must not clear it.
    act(() => screen.getByText("show").click());
    expect(screen.getByText("Custom copy")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Custom copy")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Custom copy")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("cleans up pending dismiss timers on unmount", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHarness();
    act(() => screen.getByText("show").click());
    expect(screen.getByText("Custom copy")).toBeInTheDocument();

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
