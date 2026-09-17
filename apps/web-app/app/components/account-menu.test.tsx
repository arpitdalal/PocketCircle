import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReturnTo } from "~/lib/return-to-url.js";
import {
  accountMenuItemLabels,
  accountMenuTestUser,
  openAccountMenu,
  renderAccountMenu,
} from "~/test/account-menu.js";
import { configureConvex } from "~/test/convex-react.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

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
  resetPushEnv();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  configureConvex({});
  signOutMock.mockResolvedValue({ data: { success: true }, error: null });
});

describe("AccountMenu", () => {
  const user = accountMenuTestUser;

  it("renders exactly one New badge on Connections while that item owns the slot", async () => {
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);
    const connections = await screen.findByRole("menuitem", { name: /Connections/ });
    expect(connections.textContent?.replace(/\s+/g, " ").trim()).toBe("ConnectionsNew");
    expect(document.querySelectorAll('[data-account-menu-new="true"]')).toHaveLength(1);
    expect(connections.querySelector('[data-account-menu-new="true"]')).not.toBeNull();
  });

  // The desktop sidebar footer (issue #351) hosts this control at the bottom-left, so
  // the menu goes out to the side instead of hanging below a header bar.
  it.each([
    { chrome: "header" as const, side: "bottom" },
    { chrome: "sidebar" as const, side: "right" },
  ])("opens the $chrome menu on its $side side", async ({ chrome, side }) => {
    const u = userEvent.setup();
    renderAccountMenu({ chrome });
    await openAccountMenu(u);

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.closest("[data-side]")).toHaveAttribute("data-side", side);
    });
  });

  // Sidebar rows are wide enough to name the User (issue #351), so the desktop trigger
  // reads as a list item rather than a bare avatar. The email belongs to the menu.
  it("names the User on the sidebar trigger and keeps the email in the menu", async () => {
    const u = userEvent.setup();
    renderAccountMenu({ chrome: "sidebar" });

    const trigger = screen.getByRole("button", { name: "Alex Tester, account menu" });
    expect(trigger).toHaveTextContent("Alex Tester");
    expect(screen.queryByText(user.email)).not.toBeInTheDocument();

    await openAccountMenu(u);
    expect(await screen.findByText(user.email)).toBeInTheDocument();
  });

  it("keeps the header trigger avatar-only", () => {
    renderAccountMenu();

    // Only the Avatar's decorative initials — the narrow bar has no room for identity.
    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger).not.toHaveTextContent("Alex Tester");
    expect(screen.queryByText(user.email)).not.toBeInTheDocument();
  });

  it("opens the menu and navigates to Settings", async () => {
    const u = userEvent.setup();
    const view = renderAccountMenu({
      routes: <Route path="/settings" element={<div>settings-screen</div>} />,
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(view.location()).toBe("/settings");
    expect(await screen.findByText("settings-screen")).toBeInTheDocument();
  });

  // Issue #351: the archive opens beside the app so closing it returns the User to the
  // page they were on — the same contract as the desktop sidebar's footer link.
  it("opens What's new in a new tab with safe link attributes and a spoken cue", async () => {
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);

    const whatsNew = await screen.findByRole("menuitem", { name: /What's new/ });
    expect(whatsNew).toHaveAttribute("href", "/whats-new");
    expect(whatsNew).toHaveAttribute("target", "_blank");
    expect(whatsNew).toHaveAttribute("rel", "noopener noreferrer");
    // Whitespace-tolerant: accessible-name computation joins sibling text with a space in
    // real engines and without one in jsdom. Either spelling reads as the same pause.
    expect(whatsNew).toHaveAccessibleName(/^What's new\s*, opens in a new tab$/);
  });

  it("orders Settings, Connections, What's new, Send feedback, then Sign out when install is unavailable", async () => {
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);
    expect(await accountMenuItemLabels()).toEqual([
      "Settings",
      "ConnectionsNew",
      "What's new, opens in a new tab",
      "Send feedback",
      "Sign out",
    ]);
  });

  it("badges Connections as New while that feature owns the account-menu slot", async () => {
    const u = userEvent.setup();
    const view = renderAccountMenu({
      routes: <Route path="/connections" element={<div>connections-screen</div>} />,
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: /Connections/ }));
    expect(view.location()).toBe("/connections");
    expect(await screen.findByText("connections-screen")).toBeInTheDocument();
  });

  it("navigates Send feedback to the global /feedback route", async () => {
    const u = userEvent.setup();
    const view = renderAccountMenu({
      routes: <Route path="/feedback" element={<div>feedback-screen</div>} />,
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
    expect(view.location()).toBe("/feedback");
    expect(await screen.findByText("feedback-screen")).toBeInTheDocument();
  });

  it("carries a Circle-scoped origin as returnTo on Send feedback", async () => {
    const u = userEvent.setup();
    const origin = "/circles/trip-c1/transactions?month=2026-05";
    const view = renderAccountMenu({
      path: "/circles/:circleRef/transactions",
      initialEntries: [origin],
      routes: <Route path="/feedback" element={<div>feedback-screen</div>} />,
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
    expect(view.location()).toBe(withReturnTo("/feedback", origin));
    expect(await screen.findByText("feedback-screen")).toBeInTheDocument();
  });

  it("shows Sign out and invokes signOut when chosen", async () => {
    const u = userEvent.setup();
    configureConvex({});
    renderAccountMenu();
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("clears local Push subscription and binding before signOut", async () => {
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    const sub = makeFakePushSubscription();
    let releaseCleanup = () => {};
    sub.unsubscribe.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCleanup = () => resolve(true);
        }),
    );
    installPushEnv({ permission: "granted", subscription: sub });
    configureConvex({ disablePushSubscription });
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signOutMock).not.toHaveBeenCalled();
    releaseCleanup();
    await waitFor(() => {
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(disablePushSubscription).toHaveBeenCalledWith({ endpoint: sub.endpoint });
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
  });

  it("still signs out when Push cleanup fails", async () => {
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    const sub = makeFakePushSubscription();
    sub.unsubscribe.mockRejectedValueOnce(new Error("sw down"));
    installPushEnv({ permission: "granted", subscription: sub });
    configureConvex({ disablePushSubscription });
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => {
      // First unsubscribe rejects; after server disable we retry local cleanup.
      expect(sub.unsubscribe).toHaveBeenCalledTimes(2);
      expect(disablePushSubscription).toHaveBeenCalledWith({ endpoint: sub.endpoint });
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
  });

  it("still signs out when Push cleanup setup throws", async () => {
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    configureConvex({ disablePushSubscription });
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID unavailable");
    });
    const u = userEvent.setup();
    try {
      renderAccountMenu();
      await openAccountMenu(u);
      await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      await waitFor(() => {
        expect(signOutMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      randomUUID.mockRestore();
    }
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
    renderAccountMenu();
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    const pending = await screen.findByRole("menuitem", { name: "Signing out..." });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("data-disabled");
    expect(signOutMock).toHaveBeenCalledTimes(1);

    releaseSignOut();
  });

  it("holds Push enable cancel until signOut settles", async () => {
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    configureConvex({ disablePushSubscription });
    let releaseSignOut = () => {};
    signOutMock.mockImplementationOnce(
      () =>
        new Promise<{ data: { success: true }; error: null }>((resolve) => {
          releaseSignOut = () => resolve({ data: { success: true }, error: null });
        }),
    );
    const u = userEvent.setup();
    renderAccountMenu();
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
    expect(window.localStorage.getItem("pocketcircle.pushEnableCancel")).not.toBeNull();

    releaseSignOut();
    await waitFor(() => {
      expect(window.localStorage.getItem("pocketcircle.pushEnableCancel")).toBeNull();
    });
  });

  it("logs and still routes to /signin when sign-out fails", async () => {
    const u = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Better Auth signals failure by resolving with an `error` object (not a rejection);
    // the real `signOut` wrapper turns that into the throw this UX path catches.
    const failure = { message: "network down" };
    signOutMock.mockResolvedValueOnce({ data: null, error: failure });
    const view = renderAccountMenu({
      routes: <Route path="/signin" element={<div>signin-screen</div>} />,
    });
    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByText("signin-screen")).toBeInTheDocument();
    expect(view.location()).toBe("/signin");
    expect(errorSpy).toHaveBeenCalledWith("signOut failed", failure);
  });

  it("omits Sign out when showSignOut is false", async () => {
    const u = userEvent.setup();
    renderAccountMenu({ showSignOut: false });
    await openAccountMenu(u);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
