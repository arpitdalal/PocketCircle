import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTestProviders } from "~/test/app-test-providers.js";
import { convexReactMock } from "~/test/convex-react.js";

// The notice reads Convex's auth state, the boundary the real provider above it
// writes once a cross-domain sign-in has been redeemed.
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import { SignInHandoffNotice } from "./sign-in-handoff-notice.js";

const HANDOFF_SETTLE_MS = 10_000;
const REPORTED = "Couldn't finish signing in. Try again.";

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

/** Exactly the moment the report is due: the snackbar is on screen for 4s after it. */
function settleHandoffWindow() {
  act(() => {
    vi.advanceTimersByTime(HANDOFF_SETTLE_MS);
  });
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

    settleHandoffWindow();

    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
  });

  it("reports a handoff that never produced a session", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderNotice();

    settleHandoffWindow();

    expect(screen.getByText(REPORTED)).toBeInTheDocument();
  });

  it("says nothing while the session is still resolving", () => {
    landOnHandoffUrl();
    // A slow session is not a failed sign-in, so the report waits for it to settle
    // rather than racing it.
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
    renderNotice();

    settleHandoffWindow();

    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
  });

  it("stays quiet when the handoff lands a session", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderNotice();

    settleHandoffWindow();

    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
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
    settleHandoffWindow();

    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
  });

  it("reports on one deadline however often the session state changes", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    const { rerender } = renderNotice();
    const rerenderNotice = () =>
      rerender(
        <AppTestProviders>
          <SignInHandoffNotice />
        </AppTestProviders>,
      );

    // A session that refetches more often than the timeout must not push the
    // deadline out for as long as it keeps doing that.
    for (let elapsed = 0; elapsed < HANDOFF_SETTLE_MS; elapsed += 1_000) {
      convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      rerenderNotice();
      convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
      rerenderNotice();
    }

    expect(screen.getByText(REPORTED)).toBeInTheDocument();
  });

  it("defers the report when the session is still resolving at the deadline", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
    const { rerender } = renderNotice();

    settleHandoffWindow();
    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();

    // A slow session is not a failed sign-in; the report follows the moment it
    // settles signed out, rather than never arriving.
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    rerender(
      <AppTestProviders>
        <SignInHandoffNotice />
      </AppTestProviders>,
    );

    expect(screen.getByText(REPORTED)).toBeInTheDocument();
  });

  it("says nothing when the URL carries the param with no token", () => {
    // The provider redeems on the param's *value*, so an empty one starts no handoff
    // and there is nothing to report. The two predicates have to agree.
    window.history.replaceState({}, "", "/signin?ott=");
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderNotice();

    settleHandoffWindow();

    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
  });

  it("cancels the pending report when it goes away", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { rerender } = renderNotice();

    // Unmount the notice but leave the snackbar it reports through standing, so a
    // timer that outlived it would still be visible.
    rerender(
      <AppTestProviders>
        <div />
      </AppTestProviders>,
    );
    settleHandoffWindow();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(screen.queryByText(REPORTED)).not.toBeInTheDocument();
  });

  it("reports a failed handoff once, not on every later session change", () => {
    landOnHandoffUrl();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    const { rerender } = renderNotice();

    settleHandoffWindow();
    const reported = screen.getByText(REPORTED);

    // A session cycle after the report must not re-announce it: the snackbar
    // remounts its live region per message, so a second call is a different node.
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    rerender(
      <AppTestProviders>
        <SignInHandoffNotice />
      </AppTestProviders>,
    );
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    rerender(
      <AppTestProviders>
        <SignInHandoffNotice />
      </AppTestProviders>,
    );

    expect(screen.getByText(REPORTED)).toBe(reported);
  });
});
