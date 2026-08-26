import { screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "~/components/account-menu.js";
import { withReturnTo } from "~/lib/return-to-url.js";
import { renderRoutes } from "~/test/convex-react.js";

// Mock only the true boundary: Better Auth's network client. Our own `signOut`
// wrapper in `~/lib/auth-client.js` still runs for real against this fake client,
// so the mock mirrors Better Auth's real contract: it RESOLVES with `{ data, error }`
// (failures are an `error` object, not a rejection).
const signOutMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
);

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({ signOut: signOutMock }),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function openAccountMenu(u: UserEvent) {
  await u.click(screen.getByRole("button", { name: "Account menu" }));
}

describe("AccountMenu", () => {
  const user = {
    id: "u1",
    email: "alex@example.com",
    displayName: "Alex Tester",
    image: undefined,
    onboardingComplete: true,
    analyticsEnabled: false,
    createdAt: 1,
    acknowledgedFeatureAnnouncementIds: [],
  };

  it("opens the menu and navigates to Settings", async () => {
    const u = userEvent.setup();
    const view = renderRoutes(
      <>
        <Route path="/" element={<AccountMenu user={user} showSignOut />} />
        <Route path="/settings" element={<div>settings-screen</div>} />
      </>,
      { initialEntries: ["/"] },
    );
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(view.location()).toBe("/settings");
    expect(await screen.findByText("settings-screen")).toBeInTheDocument();
  });

  it("navigates What's new to /whats-new", async () => {
    const u = userEvent.setup();
    const view = renderRoutes(
      <>
        <Route path="/" element={<AccountMenu user={user} showSignOut />} />
        <Route path="/whats-new" element={<div>whats-new-screen</div>} />
      </>,
      { initialEntries: ["/"] },
    );
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "What's new" }));
    expect(view.location()).toBe("/whats-new");
    expect(await screen.findByText("whats-new-screen")).toBeInTheDocument();
  });

  it("orders Settings, What's new, Send feedback, then Sign out when install is unavailable", async () => {
    const u = userEvent.setup();
    renderRoutes(<Route path="/" element={<AccountMenu user={user} showSignOut />} />, {
      initialEntries: ["/"],
    });
    await openAccountMenu(u);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Settings",
      "What's new",
      "Send feedback",
      "Sign out",
    ]);
  });

  it("navigates Send feedback to the global /feedback route", async () => {
    const u = userEvent.setup();
    const view = renderRoutes(
      <>
        <Route path="/" element={<AccountMenu user={user} showSignOut />} />
        <Route path="/feedback" element={<div>feedback-screen</div>} />
      </>,
      { initialEntries: ["/"] },
    );
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
    expect(view.location()).toBe("/feedback");
    expect(await screen.findByText("feedback-screen")).toBeInTheDocument();
  });

  it("carries a Circle-scoped origin as returnTo on Send feedback", async () => {
    const u = userEvent.setup();
    const origin = "/circles/trip-c1/transactions?month=2026-05";
    const view = renderRoutes(
      <>
        <Route
          path="/circles/:circleRef/transactions"
          element={<AccountMenu user={user} showSignOut />}
        />
        <Route path="/feedback" element={<div>feedback-screen</div>} />
      </>,
      { initialEntries: [origin] },
    );
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
    expect(view.location()).toBe(withReturnTo("/feedback", origin));
    expect(await screen.findByText("feedback-screen")).toBeInTheDocument();
  });

  it("shows Sign out and invokes signOut when chosen", async () => {
    const u = userEvent.setup();
    renderRoutes(<Route path="/" element={<AccountMenu user={user} showSignOut />} />, {
      initialEntries: ["/"],
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("shows a pending state while sign-out is in flight", async () => {
    const u = userEvent.setup();
    // Hold the network boundary open so the in-flight UI is observable until we release it.
    let releaseSignOut = () => {};
    signOutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSignOut = () => resolve();
        }),
    );
    renderRoutes(<Route path="/" element={<AccountMenu user={user} showSignOut />} />, {
      initialEntries: ["/"],
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    const pending = await screen.findByRole("menuitem", { name: "Signing out..." });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("data-disabled");
    expect(signOutMock).toHaveBeenCalledTimes(1);

    releaseSignOut();
  });

  it("logs and still routes to /signin when sign-out fails", async () => {
    const u = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Better Auth signals failure by resolving with an `error` object (not a rejection);
    // the real `signOut` wrapper turns that into the throw this UX path catches.
    const failure = { message: "network down" };
    signOutMock.mockResolvedValueOnce({ data: null, error: failure });
    const view = renderRoutes(
      <>
        <Route path="/" element={<AccountMenu user={user} showSignOut />} />
        <Route path="/signin" element={<div>signin-screen</div>} />
      </>,
      { initialEntries: ["/"] },
    );
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByText("signin-screen")).toBeInTheDocument();
    expect(view.location()).toBe("/signin");
    expect(errorSpy).toHaveBeenCalledWith("signOut failed", failure);
  });

  it("omits Sign out when showSignOut is false", async () => {
    const u = userEvent.setup();
    renderRoutes(<Route path="/" element={<AccountMenu user={user} showSignOut={false} />} />, {
      initialEntries: ["/"],
    });
    await openAccountMenu(u);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
