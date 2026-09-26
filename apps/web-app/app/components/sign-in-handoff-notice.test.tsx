import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTestProviders } from "~/test/app-test-providers.js";
import { convexReactMock } from "~/test/convex-react.js";

// The notice reads Convex's auth state, the boundary the real provider above it
// writes once a cross-domain sign-in has been redeemed.
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import { SignInHandoffNotice } from "./sign-in-handoff-notice.js";

const HANDOFF_SETTLE_MS = 10_000;

function landOnHandoffUrl() {
  window.history.replaceState({}, "", "/signin?ott=one-time-token-value");
}

function renderNotice() {
  return render(
    <AppTestProviders>
      <SignInHandoffNotice />
    </AppTestProviders>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("SignInHandoffNotice", () => {
  it("says nothing on a page load with no sign-in handoff", () => {
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderNotice();

    act(() => {
      vi.advanceTimersByTime(HANDOFF_SETTLE_MS * 2);
    });

    expect(screen.queryByText(/finish signing in/)).not.toBeInTheDocument();
  });

  it("reports a handoff that never produced a session", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderNotice();

    act(() => {
      vi.advanceTimersByTime(HANDOFF_SETTLE_MS);
    });

    expect(screen.getByText("Couldn't finish signing in. Try again.")).toBeInTheDocument();
  });

  it("stays quiet when the handoff lands a session", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderNotice();

    act(() => {
      vi.advanceTimersByTime(HANDOFF_SETTLE_MS * 2);
    });

    expect(screen.queryByText(/finish signing in/)).not.toBeInTheDocument();
  });

  it("stays quiet once a User who hit a failed handoff signs in again", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    const { rerender } = renderNotice();

    // The report is on a timer, so a User who retries inside the window must not be
    // told the sign-in they just completed failed.
    act(() => {
      vi.advanceTimersByTime(HANDOFF_SETTLE_MS - 1);
    });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    rerender(
      <AppTestProviders>
        <SignInHandoffNotice />
      </AppTestProviders>,
    );
    act(() => {
      vi.advanceTimersByTime(HANDOFF_SETTLE_MS);
    });

    expect(screen.queryByText(/finish signing in/)).not.toBeInTheDocument();
  });
});
