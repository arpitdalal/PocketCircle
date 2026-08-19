import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Link } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKELETON_DELAY_MS } from "~/lib/route-skeleton.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  testId,
} from "~/test/convex-react.js";
import { installIntersectionObserverStub } from "~/test/intersection-observer-stub.js";
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
});

afterEach(() => {
  resetPostHogBoundary();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

function ready() {
  // A bootstrapped User (session Ready) plus an empty Circle list for the switcher.
  configureConvex({ currentUser: makeCurrentUserView(), circles: [] });
}

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
    // The header (brand) survives the navigation — no full-page swap, no layout shift.
    expect(screen.getByText("PocketCircle")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith({ displayName: "Ada King" });
    });
    expect(posthogSdk.init).not.toHaveBeenCalled();

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
