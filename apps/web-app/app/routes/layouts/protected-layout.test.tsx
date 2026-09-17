import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Link, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_CONTENT_ID } from "~/components/skip-navigation.js";
import { circleNavItems } from "~/lib/circle-nav.js";
import { LAST_USED_GOOGLE_EMAIL_STORAGE_KEY } from "~/lib/last-used-google-email.js";
import { SKELETON_DELAY_MS } from "~/lib/route-skeleton.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  testId,
} from "~/test/convex-react.js";
import { installIntersectionObserverStub } from "~/test/intersection-observer-stub.js";
import { clearLastUsedGoogleEmailStorage } from "~/test/last-used-google-email.js";
import {
  posthogSdk,
  resetPostHogBoundary,
  stubPosthogEnvForTests,
} from "~/test/posthog-boundary.js";
import { AppTestProviders, deferred, renderRouteStub } from "~/test/router-stub.js";

/**
 * Phase-1 shell-skeleton behavior for the protected (app shell) layout (issue #121).
 * Same seam as the Circle layout test: a `createRoutesStub` data router gives the REAL
 * layout a genuine pending navigation, only `convex/react` is doubled, and the real
 * session state machine reads the modeled `getCurrentUser` to reach the Ready branch.
 * The header chrome must stay put while the `<Outlet/>` content swaps to the skeleton.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import OnboardingRoute from "../onboarding.js";
import ProtectedLayout from "./protected-layout.js";

// biome-ignore lint/suspicious/noExplicitAny: thin route-tree stand-ins; the layout is the unit under test.
function routesWith(settingsLoader: () => any) {
  return [
    {
      path: "/",
      Component: ProtectedLayout,
      children: [
        { index: true, Component: () => <Link to="/settings">Go to settings</Link> },
        {
          path: "settings",
          Component: () => <h2>Settings stub</h2>,
          loader: settingsLoader,
        },
      ],
    },
  ];
}

installIntersectionObserverStub();

beforeEach(() => {
  stubPosthogEnvForTests();
  clearLastUsedGoogleEmailStorage();
});

afterEach(() => {
  resetPostHogBoundary();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  clearLastUsedGoogleEmailStorage();
});

function ready() {
  // A bootstrapped User (session Ready) plus an empty Circle list for the switcher.
  configureConvex({ currentUser: makeCurrentUserView(), circles: [] });
}

describe("ProtectedLayout skip navigation", () => {
  it("exposes a skip link as the first tab stop that focuses the main landmark", async () => {
    ready();
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ index: true, Component: () => <h2>Home stub</h2> }],
        },
      ],
      ["/"],
    );

    await screen.findByText("Home stub");
    const user = userEvent.setup();
    await user.tab();

    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();

    await user.keyboard("{Enter}");
    const main = screen.getByRole("main");
    expect(main).toHaveFocus();
    expect(main).toHaveAttribute("id", MAIN_CONTENT_ID);
    expect(main).toHaveAttribute("tabIndex", "-1");
  });

  it("does not render the skip link while onboarding (no shell chrome to skip)", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ onboardingComplete: false }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "onboarding", Component: OnboardingRoute },
          ],
        },
      ],
      ["/onboarding"],
    );

    await screen.findByRole("heading", { name: "Welcome" });
    expect(screen.queryByRole("link", { name: "Skip to main content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
  });
});

/**
 * Desktop sidebar chrome (issue #351) at the shell seam: the real sidebar, the real
 * canonical navigation model, and a real router. Visibility is CSS-only by design, so
 * these assert STRUCTURE (both chromes mounted, correct destinations, active state) and
 * the responsive classes that swap them — never a JavaScript viewport branch.
 */
describe("ProtectedLayout sidebar", () => {
  /** Sidebar regions carry no landmark of their own; the slot attribute locates them. */
  function requireSidebarSlot(slot: "sidebar-header" | "sidebar-footer") {
    const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    if (element === null) {
      throw new Error(`expected a ${slot} in the rendered shell`);
    }
    return element;
  }

  function renderShellAt(pathname: string) {
    ready();
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "circles/:circleRef", Component: () => <h2>Dashboard stub</h2> },
            {
              path: "circles/:circleRef/transactions",
              Component: () => <h2>Transactions stub</h2>,
            },
            {
              path: "circles/:circleRef/transactions/:transactionId",
              Component: () => <h2>Transaction detail stub</h2>,
            },
          ],
        },
      ],
      [pathname],
    );
  }

  it("renders a labelled primary navigation with brand, Circle switcher, and an active Home link", async () => {
    renderShellAt("/");
    await screen.findByText("Home stub");

    const primary = screen.getByRole("navigation", { name: "Primary" });
    const home = within(primary).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");

    // Brand + switcher live in the sidebar header, outside the navigation landmark.
    expect(screen.getAllByRole("link", { name: "PocketCircle" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Circles" })).toHaveLength(2);
    // No Circle group off a Circle route.
    expect(within(primary).queryByRole("group", { name: "Circle" })).not.toBeInTheDocument();
  });

  it("keeps the sticky header mounted but hidden from `lg` up, and the sidebar hidden below it", async () => {
    renderShellAt("/");
    await screen.findByText("Home stub");

    expect(screen.getByRole("banner").className).toContain("lg:hidden");
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.className).toContain("hidden");
    expect(sidebar?.className).toContain("lg:block");
    // Collapse-ready contract: provider state is expressed on the panel, no control yet.
    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(screen.queryByRole("button", { name: /collapse/i })).not.toBeInTheDocument();
  });

  it("renders the canonical Circle destinations, in order, when the URL is Circle-scoped", async () => {
    renderShellAt("/circles/home-c2");
    await screen.findByText("Dashboard stub");

    const group = screen.getByRole("group", { name: "Circle" });
    expect(
      within(group)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(circleNavItems("home-c2").map((item) => item.label));
    expect(within(group).getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "href",
      "/circles/home-c2/transactions",
    );
    expect(within(group).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the parent destination active on a nested detail route", async () => {
    renderShellAt("/circles/home-c2/transactions/t1");
    await screen.findByText("Transaction detail stub");

    const group = screen.getByRole("group", { name: "Circle" });
    expect(within(group).getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // `end: true` keeps Dashboard from lighting up for every nested Circle route.
    expect(within(group).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  // Where the shared controls sit differs by chrome: the bell rides the sidebar's top
  // row beside the brand, and the account control becomes a footer row naming the User.
  it("puts notifications in the sidebar header and the named account row in its footer", async () => {
    renderShellAt("/");
    await screen.findByText("Home stub");

    const sidebarHeader = requireSidebarSlot("sidebar-header");
    const sidebarFooter = requireSidebarSlot("sidebar-footer");

    expect(
      within(sidebarHeader).getByRole("button", { name: /^Notifications/ }),
    ).toBeInTheDocument();
    expect(within(sidebarHeader).getByRole("link", { name: "PocketCircle" })).toBeInTheDocument();

    const seeded = makeCurrentUserView();
    const accountRow = within(sidebarFooter).getByRole("button", {
      name: `${seeded.displayName}, account menu`,
    });
    expect(accountRow).toHaveTextContent(seeded.displayName);
    // Email is menu-only; the persistent row shows just the name.
    expect(screen.queryByText(seeded.email)).not.toBeInTheDocument();
    // The header keeps its own avatar-only trigger — two chromes, one implementation.
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Notifications/ })).toHaveLength(2);
  });

  it("renders no sidebar before onboarding completes", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ onboardingComplete: false }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "onboarding", Component: OnboardingRoute },
          ],
        },
      ],
      ["/onboarding"],
    );

    await screen.findByRole("heading", { name: "Welcome" });
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
  });
});

describe("ProtectedLayout shell skeleton", () => {
  it("shows the generic skeleton while a slow shell navigation loads, keeping the header", async () => {
    const slow = deferred();
    ready();
    renderRouteStub(
      routesWith(() => slow.promise),
      ["/"],
    );

    await userEvent.click(await screen.findByRole("link", { name: "Go to settings" }));

    const main = screen.getByRole("main");
    expect(await within(main).findByTestId("route-skeleton")).toBeInTheDocument();
    // Both chromes (brand) survive the navigation — no full-page swap, no layout shift.
    // Sidebar and header are always both mounted; CSS alone picks which is painted.
    expect(screen.getAllByRole("link", { name: "PocketCircle" })).toHaveLength(2);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to settings" })).not.toBeInTheDocument();
    // A non-Circle destination gets no Circle bottom-bar placeholder.
    expect(screen.queryByTestId("circle-bottom-nav-skeleton")).not.toBeInTheDocument();
    expect(main.className).not.toContain("--mobile-bottom-nav-clearance");

    slow.resolve();
    expect(await screen.findByText("Settings stub")).toBeInTheDocument();
    expect(screen.queryByTestId("route-skeleton")).not.toBeInTheDocument();
  });

  it("does not flash a skeleton for a fast navigation (flicker guard)", async () => {
    ready();
    renderRouteStub(
      routesWith(() => null),
      ["/"],
    );

    await userEvent.click(await screen.findByRole("link", { name: "Go to settings" }));

    expect(await screen.findByText("Settings stub")).toBeInTheDocument();
    expect(screen.queryByTestId("route-skeleton")).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, SKELETON_DELAY_MS + 40));
    expect(screen.queryByTestId("route-skeleton")).not.toBeInTheDocument();
  });

  it("keeps a Circle bottom-bar placeholder mounted while a slow navigation INTO a Circle loads", async () => {
    // Switching into a Circle routes through the shell skeleton, which unmounts the
    // Circle layout (and its real mobile bar). The placeholder bar holds the slot so the
    // mobile bottom bar doesn't flash out then back in during the load (issue #121).
    const slow = deferred();
    ready();
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <Link to="/circles/home-c2">Open circle</Link> },
            {
              path: "circles/:circleRef",
              Component: () => <h2>Circle stub</h2>,
              loader: () => slow.promise,
            },
          ],
        },
      ],
      ["/"],
    );

    await userEvent.click(await screen.findByRole("link", { name: "Open circle" }));

    expect(await screen.findByTestId("route-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("circle-bottom-nav-skeleton")).toBeInTheDocument();
    expect(screen.getByRole("main").className).toContain("--mobile-bottom-nav-clearance");

    // Once the destination resolves the placeholder gives way (the real Circle layout,
    // not exercised here, owns the live bar from then on).
    slow.resolve();
    expect(await screen.findByText("Circle stub")).toBeInTheDocument();
    expect(screen.queryByTestId("circle-bottom-nav-skeleton")).not.toBeInTheDocument();
    expect(screen.getByRole("main").className).toContain("--mobile-bottom-nav-clearance");
  });

  it("drops Circle bottom-bar clearance while a slow navigation OUT of a Circle loads", async () => {
    const slow = deferred();
    ready();
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            {
              index: true,
              Component: () => <h2>Home stub</h2>,
              loader: () => slow.promise,
            },
            {
              path: "circles/:circleRef",
              Component: () => <Link to="/">Back home</Link>,
            },
          ],
        },
      ],
      ["/circles/home-c2"],
    );

    await userEvent.click(await screen.findByRole("link", { name: "Back home" }));

    expect(await screen.findByTestId("route-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("circle-bottom-nav-skeleton")).not.toBeInTheDocument();
    expect(screen.getByRole("main").className).not.toContain("--mobile-bottom-nav-clearance");

    slow.resolve();
    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(screen.getByRole("main").className).not.toContain("--mobile-bottom-nav-clearance");
  });
});

describe("ProtectedLayout onboarding gate", () => {
  it("redirects not-onboarded Users on a deep link to onboarding instead of the destination", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ onboardingComplete: false }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "onboarding", Component: OnboardingRoute },
            { path: "circles/:circleRef", Component: () => <h2>Circle stub</h2> },
          ],
        },
      ],
      ["/circles/abc"],
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Circle stub")).not.toBeInTheDocument();
  });

  it("returns to a deep-linked Circle after onboarding when returnTo was captured", async () => {
    let currentUser = makeCurrentUserView({
      onboardingComplete: false,
      displayName: "Ada Lovelace",
    });
    const completeOnboarding = vi.fn(async () => {
      currentUser = makeCurrentUserView({
        onboardingComplete: true,
        displayName: "Ada King",
      });
    });
    configureConvex({
      currentUser: () => currentUser,
      circles: [],
      completeOnboarding,
    });

    const routes = [
      {
        path: "/",
        Component: ProtectedLayout,
        children: [
          { index: true, Component: () => <h2>Home stub</h2> },
          { path: "onboarding", Component: OnboardingRoute },
          { path: "circles/:circleRef", Component: () => <h2>Circle stub</h2> },
        ],
      },
    ];
    const Stub = createRoutesStub(routes);
    const view = render(
      <AppTestProviders>
        <Stub initialEntries={["/circles/abc"]} />
      </AppTestProviders>,
    );

    const user = userEvent.setup();
    const input = await screen.findByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "  Ada King  ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith({ displayName: "Ada King" });
    });

    view.rerender(
      <AppTestProviders>
        <Stub key="session-updated" initialEntries={["/onboarding?returnTo=/circles/abc"]} />
      </AppTestProviders>,
    );

    expect(await screen.findByText("Circle stub")).toBeInTheDocument();
    expect(screen.queryByText("Home stub")).not.toBeInTheDocument();
  });

  it("redirects onboarded Users on /onboarding without returnTo back to Home", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ onboardingComplete: true }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "onboarding", Component: OnboardingRoute },
          ],
        },
      ],
      ["/onboarding"],
    );

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();
  });

  it("redirects not-onboarded Users to onboarding, but not when already there", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({
        onboardingComplete: false,
        analyticsEnabled: true,
      }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [
            { index: true, Component: () => <h2>Home stub</h2> },
            { path: "onboarding", Component: OnboardingRoute },
          ],
        },
      ],
      ["/"],
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Home stub")).not.toBeInTheDocument();
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("lets onboarded Users render child routes normally", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: true, onboardingComplete: true }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ index: true, Component: () => <h2>Home stub</h2> }],
        },
      ],
      ["/"],
    );

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();
    expect(screen.getByRole("main").className).not.toContain("--mobile-bottom-nav-clearance");
    expect(posthogSdk.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        disable_session_recording: true,
      }),
    );
  });

  it("syncs the stored analytics preference from the ready session", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: false, onboardingComplete: true }),
      circles: [],
    });
    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ index: true, Component: () => <h2>Home stub</h2> }],
        },
      ],
      ["/"],
    );

    await screen.findByText("Home stub");
    expect(posthogSdk.init).not.toHaveBeenCalled();
    expect(posthogSdk.opt_out_capturing).not.toHaveBeenCalled();
  });

  it("completes onboarding and lets the User reach the app shell", async () => {
    let currentUser = makeCurrentUserView({
      onboardingComplete: false,
      analyticsEnabled: true,
      displayName: "Ada Lovelace",
    });
    const completeOnboarding = vi.fn(async () => {
      currentUser = makeCurrentUserView({
        onboardingComplete: true,
        analyticsEnabled: true,
        displayName: "Ada King",
      });
    });
    configureConvex({
      currentUser: () => currentUser,
      circles: [],
      completeOnboarding,
    });

    const routes = [
      {
        path: "/",
        Component: ProtectedLayout,
        children: [
          { index: true, Component: () => <h2>Home stub</h2> },
          { path: "onboarding", Component: OnboardingRoute },
        ],
      },
    ];
    const Stub = createRoutesStub(routes);
    const view = render(
      <AppTestProviders>
        <Stub initialEntries={["/onboarding"]} />
      </AppTestProviders>,
    );

    const user = userEvent.setup();
    const input = await screen.findByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "  Ada King  ");
    // Analytics stay off for a User who has not finished onboarding.
    expect(posthogSdk.init).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith({ displayName: "Ada King" });
    });

    view.rerender(
      <AppTestProviders>
        <Stub key="session-updated" initialEntries={["/onboarding"]} />
      </AppTestProviders>,
    );

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();
    expect(posthogSdk.init).toHaveBeenCalled();
  });

  it("resets analytics when the session leaves an onboarded User", async () => {
    let currentUser = makeCurrentUserView({
      analyticsEnabled: true,
      onboardingComplete: true,
    });
    configureConvex({
      currentUser: () => currentUser,
      circles: [],
    });
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: ProtectedLayout,
        children: [
          { index: true, Component: () => <h2>Home stub</h2> },
          { path: "onboarding", Component: OnboardingRoute },
        ],
      },
    ]);
    const view = render(
      <AppTestProviders>
        <Stub initialEntries={["/"]} />
      </AppTestProviders>,
    );

    await screen.findByText("Home stub");
    expect(posthogSdk.init).toHaveBeenCalled();

    currentUser = makeCurrentUserView({
      analyticsEnabled: true,
      onboardingComplete: false,
    });
    view.rerender(
      <AppTestProviders>
        <Stub key="left-app" initialEntries={["/"]} />
      </AppTestProviders>,
    );

    await waitFor(() => {
      expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    });
  });

  it("resets analytics when the authenticated User changes", async () => {
    let currentUser = makeCurrentUserView({
      id: testId("user-ada"),
      analyticsEnabled: true,
      onboardingComplete: true,
      email: "ada@example.com",
    });
    configureConvex({
      currentUser: () => currentUser,
      circles: [],
    });
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: ProtectedLayout,
        children: [{ index: true, Component: () => <h2>Home stub</h2> }],
      },
    ]);
    const view = render(
      <AppTestProviders>
        <Stub initialEntries={["/"]} />
      </AppTestProviders>,
    );

    await screen.findByText("Home stub");
    expect(posthogSdk.init).toHaveBeenCalledOnce();

    currentUser = makeCurrentUserView({
      id: testId("user-grace"),
      analyticsEnabled: true,
      onboardingComplete: true,
      email: "grace@example.com",
    });
    view.rerender(
      <AppTestProviders>
        <Stub key="user-switched" initialEntries={["/"]} />
      </AppTestProviders>,
    );

    await waitFor(() => {
      expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    });
    expect(posthogSdk.init).toHaveBeenCalledOnce();
  });
});

describe("ProtectedLayout last-used Google email", () => {
  it("persists the ready User email to device-local storage", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ email: "ada@gmail.com" }),
      circles: [],
    });
    renderRouteStub(
      routesWith(() => Promise.resolve(null)),
      ["/"],
    );

    await screen.findByText("Go to settings");
    await waitFor(() => {
      expect(window.localStorage.getItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY)).toBe("ada@gmail.com");
    });
  });

  it("does not persist during bootstrap when getCurrentUser is null", async () => {
    configureConvex({ currentUser: null, circles: [] });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ path: "onboarding", Component: OnboardingRoute }],
        },
      ],
      ["/onboarding"],
    );

    await screen.findByText("Setting up your account…");
    expect(window.localStorage.getItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY)).toBeNull();
  });
});

describe("ProtectedLayout unauthenticated homepage", () => {
  it("shows the marketing homepage at / instead of redirecting to sign-in", async () => {
    configureConvex();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ index: true, Component: () => <h2>App home</h2> }],
        },
        { path: "/signin", Component: () => <h2>Sign in page</h2> },
      ],
      ["/"],
    );

    expect(await screen.findByRole("heading", { name: "PocketCircle" })).toBeInTheDocument();
    expect(screen.getByText(/track spending together in shared Circles/i)).toBeInTheDocument();
    expect(screen.queryByText("App home")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign in page")).not.toBeInTheDocument();
    // No app chrome for a visitor: the marketing page owns the whole viewport, and the
    // sidebar's controls all assume a signed-in User.
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("still redirects other protected paths to sign-in", async () => {
    configureConvex();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ path: "settings", Component: () => <h2>Settings stub</h2> }],
        },
        { path: "/signin", Component: () => <h2>Sign in page</h2> },
      ],
      ["/settings"],
    );

    expect(await screen.findByText("Sign in page")).toBeInTheDocument();
    expect(screen.queryByText("Settings stub")).not.toBeInTheDocument();
  });

  it("preserves Push click deep-link as sign-in returnTo", async () => {
    configureConvex();
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    function SignInStub() {
      const [params] = useSearchParams();
      return <h2 data-testid="signin-stub">Sign in {params.get("returnTo") ?? "(none)"}</h2>;
    }

    renderRouteStub(
      [
        {
          path: "/",
          Component: ProtectedLayout,
          children: [{ path: "from-notification", Component: () => <h2>From notification</h2> }],
        },
        { path: "/signin", Component: SignInStub },
      ],
      ["/from-notification?n=jd7abc123"],
    );

    const signin = await screen.findByTestId("signin-stub");
    expect(signin).toHaveTextContent("Sign in /from-notification?n=jd7abc123");
    expect(screen.queryByText("From notification")).not.toBeInTheDocument();
  });
});
