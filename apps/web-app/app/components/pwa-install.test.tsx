import { act, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "~/components/account-menu.js";
import { renderRoutes } from "~/test/convex-react.js";
import {
  dispatchAppInstalled,
  dispatchBeforeInstallPrompt,
  installMatchMediaFake,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

const signOutMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
);

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({ signOut: signOutMock }),
}));

const user = {
  id: "u1",
  email: "alex@example.com",
  displayName: "Alex Tester",
  image: undefined,
  onboardingComplete: true,
  analyticsEnabled: false,
};

async function openAccountMenu(u: UserEvent) {
  await u.click(screen.getByRole("button", { name: "Account menu" }));
}

function renderMenu() {
  return renderRoutes(<Route path="/" element={<AccountMenu user={user} showSignOut />} />, {
    initialEntries: ["/"],
  });
}

beforeEach(() => {
  installMatchMediaFake(false);
  resetNavigatorInstallProps();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetNavigatorInstallProps();
});

describe("PWA install via AccountMenu", () => {
  it("hides Install PocketCircle in an unsupported non-iOS environment", async () => {
    const u = userEvent.setup();
    renderMenu();
    await openAccountMenu(u);
    expect(
      screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
    ).not.toBeInTheDocument();
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Settings",
      "Send feedback",
      "Sign out",
    ]);
  });

  it("calls preventDefault on beforeinstallprompt and reveals the install item", async () => {
    const u = userEvent.setup();
    renderMenu();
    const { preventDefault } = dispatchBeforeInstallPrompt();
    expect(preventDefault).toHaveBeenCalled();

    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();
  });

  it("calls prompt once on click and hides the item after accepted", async () => {
    const u = userEvent.setup();
    renderMenu();
    const { prompt, resolveOutcome } = dispatchBeforeInstallPrompt("accepted");

    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Install PocketCircle" }));
    expect(prompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOutcome();
    });

    await openAccountMenu(u);
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
  });

  it("calls prompt once on click and hides the item after dismissed", async () => {
    const u = userEvent.setup();
    renderMenu();
    const { prompt, resolveOutcome } = dispatchBeforeInstallPrompt("dismissed");

    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Install PocketCircle" }));
    expect(prompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOutcome();
    });

    await openAccountMenu(u);
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
  });

  it("hides an available item when appinstalled fires", async () => {
    const u = userEvent.setup();
    renderMenu();
    dispatchBeforeInstallPrompt();

    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();

    await u.keyboard("{Escape}");
    act(() => {
      dispatchAppInstalled();
    });

    await openAccountMenu(u);
    expect(
      screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
    ).not.toBeInTheDocument();
  });

  it("shows Install between Settings and Send feedback while available", async () => {
    const u = userEvent.setup();
    renderMenu();
    dispatchBeforeInstallPrompt();

    await openAccountMenu(u);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Settings",
      "Install PocketCircle",
      "Send feedback",
      "Sign out",
    ]);
  });

  it("shows the item on iPhone browser mode and opens install instructions", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderMenu();

    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Install PocketCircle" }));

    expect(await screen.findByRole("dialog", { name: "Install PocketCircle" })).toBeInTheDocument();
    expect(screen.getByText("Share", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Add to Home Screen", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Open as Web App", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/open PocketCircle in Safari/i)).toBeInTheDocument();
  });

  it("shows the item on touch-Mac / iPadOS browser mode", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderMenu();

    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();
  });

  it("hides the item in standalone display mode", async () => {
    installMatchMediaFake(true);
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderMenu();

    await openAccountMenu(u);
    expect(
      screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
    ).not.toBeInTheDocument();
  });

  it("hides the item when navigator.standalone is true", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    });
    const u = userEvent.setup();
    renderMenu();

    await openAccountMenu(u);
    expect(
      screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
    ).not.toBeInTheDocument();
  });

  it("removes beforeinstallprompt and appinstalled listeners on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const view = renderMenu();

    expect(addSpy).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("appinstalled", expect.any(Function));

    view.unmount();

    expect(removeSpy).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("appinstalled", expect.any(Function));
  });

  it("reveals the item again if beforeinstallprompt fires after a prior dismissal", async () => {
    const u = userEvent.setup();
    renderMenu();
    const first = dispatchBeforeInstallPrompt("dismissed");

    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Install PocketCircle" }));
    await act(async () => {
      first.resolveOutcome();
    });

    await openAccountMenu(u);
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
    await u.keyboard("{Escape}");

    dispatchBeforeInstallPrompt("accepted");
    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();
  });
});
