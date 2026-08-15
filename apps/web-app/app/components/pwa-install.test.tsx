import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "~/components/account-menu.js";
import { PwaInstallHeaderButton } from "~/components/pwa-install.js";
import { renderRoutes } from "~/test/convex-react.js";
import {
  clearPwaInstallPromptDismissal,
  dispatchAppInstalled,
  dispatchBeforeInstallPrompt,
  installMatchMediaFake,
  resetNavigatorInstallProps,
  seedPwaInstallPromptDismissed,
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

/** Soft promo blocks the shell until dismissed — clear it before menu assertions. */
async function dismissInstallPromo(u: UserEvent) {
  const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });
  await u.click(within(dialog).getByRole("button", { name: "Not now" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Install PocketCircle" })).not.toBeInTheDocument();
  });
}

function renderInstallChrome() {
  return renderRoutes(
    <Route
      path="/"
      element={
        <>
          <PwaInstallHeaderButton />
          <AccountMenu user={user} showSignOut />
        </>
      }
    />,
    { initialEntries: ["/"] },
  );
}

beforeEach(() => {
  installMatchMediaFake(false);
  resetNavigatorInstallProps();
  clearPwaInstallPromptDismissal();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetNavigatorInstallProps();
  clearPwaInstallPromptDismissal();
});

describe("PWA install soft prompt and header shortcut", () => {
  it("shows the install promo when Chromium becomes eligible", async () => {
    renderInstallChrome();
    expect(screen.queryByRole("dialog", { name: "Install PocketCircle" })).not.toBeInTheDocument();

    act(() => {
      dispatchBeforeInstallPrompt();
    });

    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });
    expect(within(dialog).getByText(/app-like experience/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install PocketCircle" })).not.toBeInTheDocument();
  });

  it("shows the header install icon after the promo is dismissed", async () => {
    const u = userEvent.setup();
    renderInstallChrome();
    act(() => {
      dispatchBeforeInstallPrompt();
    });
    await dismissInstallPromo(u);

    expect(screen.getByRole("button", { name: "Install PocketCircle" })).toBeInTheDocument();
  });

  it("header install icon triggers Chromium prompt()", async () => {
    const u = userEvent.setup();
    renderInstallChrome();
    const { prompt, resolveOutcome } = dispatchBeforeInstallPrompt("accepted");
    await dismissInstallPromo(u);

    await u.click(screen.getByRole("button", { name: "Install PocketCircle" }));
    expect(prompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOutcome();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
  });

  it("promo Install on iOS opens Home Screen instructions", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderInstallChrome();

    const promo = await screen.findByRole("dialog", { name: "Install PocketCircle" });
    await u.click(within(promo).getByRole("button", { name: "Install" }));

    expect(await screen.findByText("Share", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Add to Home Screen", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Open as Web App", { exact: true })).toBeInTheDocument();
  });

  it("hides promo and header icon when already standalone", async () => {
    installMatchMediaFake(true);
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    renderInstallChrome();

    expect(screen.queryByRole("dialog", { name: "Install PocketCircle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install PocketCircle" })).not.toBeInTheDocument();
  });
});

describe("PWA install via AccountMenu", () => {
  it("hides Install PocketCircle in an unsupported non-iOS environment", async () => {
    const u = userEvent.setup();
    renderInstallChrome();
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
    renderInstallChrome();
    const { preventDefault } = dispatchBeforeInstallPrompt();
    expect(preventDefault).toHaveBeenCalled();
    await dismissInstallPromo(u);

    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();
  });

  it("calls prompt once on click and hides the item after accepted", async () => {
    const u = userEvent.setup();
    renderInstallChrome();
    const { prompt, resolveOutcome } = dispatchBeforeInstallPrompt("accepted");
    await dismissInstallPromo(u);

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
    renderInstallChrome();
    const { prompt, resolveOutcome } = dispatchBeforeInstallPrompt("dismissed");
    await dismissInstallPromo(u);

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
    renderInstallChrome();
    dispatchBeforeInstallPrompt();
    await dismissInstallPromo(u);

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
    renderInstallChrome();
    dispatchBeforeInstallPrompt();
    await dismissInstallPromo(u);

    await openAccountMenu(u);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Settings",
      "Install PocketCircle",
      "Send feedback",
      "Sign out",
    ]);
  });

  it("shows the item on iPhone browser mode and opens install instructions", async () => {
    seedPwaInstallPromptDismissed();
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderInstallChrome();

    await openAccountMenu(u);
    await u.click(await screen.findByRole("menuitem", { name: "Install PocketCircle" }));

    expect(await screen.findByRole("dialog", { name: "Install PocketCircle" })).toBeInTheDocument();
    expect(screen.getByText("Share", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Add to Home Screen", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Open as Web App", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/open PocketCircle in Safari/i)).toBeInTheDocument();
  });

  it("shows the item on touch-Mac / iPadOS browser mode", async () => {
    seedPwaInstallPromptDismissed();
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const u = userEvent.setup();
    renderInstallChrome();

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
    renderInstallChrome();

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
    renderInstallChrome();

    await openAccountMenu(u);
    expect(
      screen.queryByRole("menuitem", { name: "Install PocketCircle" }),
    ).not.toBeInTheDocument();
  });

  it("removes beforeinstallprompt and appinstalled listeners on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const view = renderInstallChrome();

    expect(addSpy).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("appinstalled", expect.any(Function));

    view.unmount();

    expect(removeSpy).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("appinstalled", expect.any(Function));
  });

  it("reveals the item again if beforeinstallprompt fires after a prior dismissal", async () => {
    const u = userEvent.setup();
    renderInstallChrome();
    const first = dispatchBeforeInstallPrompt("dismissed");
    await dismissInstallPromo(u);

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

    act(() => {
      dispatchBeforeInstallPrompt("accepted");
    });
    // Fresh eligibility after install cleared — promo returns; dismiss to reach the menu.
    await dismissInstallPromo(u);
    await openAccountMenu(u);
    expect(
      await screen.findByRole("menuitem", { name: "Install PocketCircle" }),
    ).toBeInTheDocument();
  });
});
